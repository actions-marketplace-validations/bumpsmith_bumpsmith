import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, runOk } from "../util/proc.ts";
import {
  type CreateOptions,
  EXPORT_EXCLUDES,
  type ExecOptions,
  type ExecResult,
  hostTarCreateArgs,
  type Sandbox,
} from "./sandbox.ts";
import { DATA_DIRS, readinessProbe, type ServiceSpec } from "./services.ts";

export { EXPORT_EXCLUDES };

/** The package root: the nearest ancestor that holds sandbox/mirror/Dockerfile (works from src/ and from a bundle in dist/). */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "sandbox", "mirror", "Dockerfile"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("cannot locate the bumpsmith sandbox definitions");
}
const ROOT = packageRoot();
const SANDBOX_DIR = join(ROOT, "sandbox");
/** Writable state (mirror certificates); defaults inside the package for local use. */
const DATA_DIR = process.env.BUMPSMITH_DATA_DIR ?? join(ROOT, ".data");

// Internal network with no route out. The only peer is the read-only registry mirror.
export const NETWORK = "bumpsmith-sbx";
const SUBNET = "172.31.250.0/24";
export const MIRROR_NAME = "bumpsmith-registry-mirror";
export const MIRROR_IP = "172.31.250.2";
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
];
const CERT_DIR = join(DATA_DIR, "mirror-certs");
const UID = "10001:10001";

/** Directories never copied out of the sandbox and never part of a patch. */

export interface SandboxLimits {
  cpus: number;
  memory: string;
  pids: number;
  homeTmpfs: string;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  cpus: 2,
  memory: "4g",
  pids: 512,
  homeTmpfs: "2g",
};

/** Node base images by major version, pinned by digest. */
export const NODE_IMAGES: Record<22 | 24 | 26, string> = {
  22: "node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee",
  24: "node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54",
  26: "node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1",
};

type ImageKind = "node" | "python" | "mirror";

async function imageTag(kind: ImageKind, buildArgs: string[]): Promise<string> {
  const files =
    kind === "mirror"
      ? ["Dockerfile", "mirror.mjs"]
      : kind === "python"
        ? ["Dockerfile", "git-wrapper.sh"]
        : ["Dockerfile"];
  const h = createHash("sha256");
  for (const f of files) h.update(await readFile(join(SANDBOX_DIR, kind, f)));
  h.update(buildArgs.join("\n"));
  return `bumpsmith-${kind}:${h.digest("hex").slice(0, 12)}`;
}

async function ensureImage(kind: ImageKind, buildArgs: string[] = []): Promise<string> {
  const tag = await imageTag(kind, buildArgs);
  const exists = await run("docker", ["image", "inspect", tag]);
  if (exists.exitCode !== 0) {
    await runOk(
      "docker",
      [
        "build",
        "--pull=false",
        ...buildArgs.flatMap((a) => ["--build-arg", a]),
        "-t",
        tag,
        join(SANDBOX_DIR, kind),
      ],
      { timeoutMs: 15 * 60_000 },
    );
  }
  return tag;
}

/**
 * Certificates for the registry hostnames, signed by a throwaway CA whose private key is
 * deleted immediately after signing: the CA can never issue anything else.
 */
export async function ensureMirrorCerts(dir = CERT_DIR): Promise<string> {
  const { existsSync } = await import("node:fs");
  const { writeFile, rm } = await import("node:fs/promises");
  if (existsSync(join(dir, "mirror.crt")) && existsSync(join(dir, "ca.crt"))) return dir;
  // Readable by the mirror container's own (different) user on Linux hosts. The leaf key
  // is only good for the registry hostnames, and its CA's private key is destroyed below.
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const { chmod: chmodDir } = await import("node:fs/promises");
  await chmodDir(dir, 0o755);
  const cfg = join(dir, "leaf.cnf");
  await writeFile(
    cfg,
    [
      "[req]",
      "distinguished_name=dn",
      "[dn]",
      "[ext]",
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${REGISTRY_HOSTS.map((h) => `DNS:${h}`).join(",")}`,
      "",
    ].join("\n"),
  );
  const o = (args: string[]) => runOk("openssl", args, { cwd: dir });
  await o([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "825",
    "-subj",
    "/CN=Bumpsmith sandbox registry mirror CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext",
    "keyUsage=critical,keyCertSign",
  ]);
  await o([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "mirror.key",
    "-out",
    "mirror.csr",
    "-subj",
    "/CN=bumpsmith-registry-mirror",
  ]);
  await o([
    "x509",
    "-req",
    "-in",
    "mirror.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "mirror.crt",
    "-days",
    "825",
    "-extfile",
    "leaf.cnf",
    "-extensions",
    "ext",
  ]);
  for (const f of ["ca.key", "mirror.csr", "ca.srl", "leaf.cnf"])
    await rm(join(dir, f), { force: true });
  // Readable by the mirror container's unprivileged user.
  const { chmod } = await import("node:fs/promises");
  await chmod(join(dir, "mirror.key"), 0o644);
  await chmod(join(dir, "mirror.crt"), 0o644);
  await chmod(join(dir, "ca.crt"), 0o644);
  return dir;
}

/**
 * Create the internal network and start the read-only registry mirror if not running.
 * Safe to call concurrently (parallel jobs or test files): a lost creation race is
 * detected by re-checking the state once.
 */
let infraReady: Promise<void> | null = null;
export function ensureInfra(): Promise<void> {
  infraReady ??= ensureInfraOnce()
    .catch(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return ensureInfraOnce();
    })
    .finally(() => {
      infraReady = null;
    });
  return infraReady;
}

async function ensureInfraOnce(): Promise<void> {
  const net = await run("docker", ["network", "inspect", NETWORK]);
  if (net.exitCode !== 0) {
    // --internal: no route to the outside world; the mirror is the only reachable peer.
    const created = await run("docker", [
      "network",
      "create",
      "--internal",
      "--subnet",
      SUBNET,
      NETWORK,
    ]);
    if (
      created.exitCode !== 0 &&
      (await run("docker", ["network", "inspect", NETWORK])).exitCode !== 0
    )
      throw new Error(`cannot create sandbox network: ${created.stderr.trim().slice(0, 300)}`);
  }
  const certs = await ensureMirrorCerts();
  const tag = await ensureImage("mirror");
  const ps = await run("docker", [
    "inspect",
    "-f",
    "{{.State.Running}} {{.Config.Image}}",
    MIRROR_NAME,
  ]);
  const [running, image] = ps.stdout.trim().split(" ");
  const alreadyRunning = ps.exitCode === 0 && running === "true" && image === tag;
  if (!alreadyRunning) {
    if (ps.exitCode === 0) await run("docker", ["rm", "-f", MIRROR_NAME]);
    await runOk("docker", [
      "run",
      "-d",
      "--name",
      MIRROR_NAME,
      "--restart",
      "unless-stopped",
      "--network",
      "bridge",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--sysctl",
      "net.ipv4.ip_unprivileged_port_start=443",
      "--memory",
      "512m",
      "--pids-limit",
      "256",
      "--mount",
      `type=bind,src=${certs},dst=/etc/bumpsmith-mirror,readonly`,
      "-e",
      "MIRROR_PORT=443",
      tag,
    ]);
  }
  // Another process may have started the mirror a moment ago: make sure it is attached to
  // the sandbox network at its fixed address before anyone relies on it.
  const nets = await run("docker", [
    "inspect",
    "-f",
    "{{json .NetworkSettings.Networks}}",
    MIRROR_NAME,
  ]);
  if (!nets.stdout.includes(MIRROR_IP)) {
    const c = await run("docker", ["network", "connect", "--ip", MIRROR_IP, NETWORK, MIRROR_NAME]);
    if (c.exitCode !== 0 && !/already exists/i.test(c.stderr))
      throw new Error(`cannot attach the registry mirror: ${c.stderr.trim().slice(0, 300)}`);
  }
  // Fail fast (with the reason) if the mirror does not come up, instead of letting
  // installs hang on an unreachable registry.
  for (let i = 0; i < 20; i++) {
    const logs = await run("docker", ["logs", MIRROR_NAME]);
    if (logs.stdout.includes('"event":"listening"')) return;
    const st = await run("docker", ["inspect", "-f", "{{.State.Running}}", MIRROR_NAME]);
    if (st.stdout.trim() !== "true")
      throw new Error(
        `registry mirror failed to start: ${(logs.stdout + logs.stderr).slice(-800)}`,
      );
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = await run("docker", ["logs", "--tail", "40", MIRROR_NAME]);
  const restarts = (
    await run("docker", ["inspect", "-f", "{{.RestartCount}}", MIRROR_NAME])
  ).stdout.trim();
  throw new Error(
    `registry mirror did not become ready in 10 seconds (restarts: ${restarts}): ${(logs.stdout + logs.stderr).slice(-1500)}`,
  );
}

/** Host names CI container jobs use for services; they resolve to the sandbox's localhost. */
export const SERVICE_HOST_ALIASES = [
  "postgres",
  "postgresql",
  "db",
  "database",
  "mysql",
  "mariadb",
  "redis",
  "valkey",
  "mongo",
  "mongodb",
];

export class DockerSandbox implements Sandbox {
  private networkAttached = true;

  /** Services that started and answered their readiness probe. */
  readonly startedServices: string[] = [];
  /** Services that could not start, with the reason. */
  readonly failedServices: string[] = [];

  private constructor(
    readonly id: string,
    readonly container: string,
    readonly volume: string,
  ) {}

  static async create(opts: CreateOptions & { limits?: SandboxLimits }): Promise<DockerSandbox> {
    await ensureInfra();
    const image =
      opts.ecosystem === "npm"
        ? await ensureImage("node", [`NODE_IMAGE=${NODE_IMAGES[opts.nodeMajor ?? 22]}`])
        : await ensureImage("python");
    const id = randomUUID().slice(0, 12);
    const container = `bumpsmith-job-${id}`;
    const volume = `bumpsmith-ws-${id}`;
    const l = opts.limits ?? DEFAULT_LIMITS;
    await runOk("docker", ["volume", "create", "--label", "bumpsmith=1", volume]);
    await runOk("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      "bumpsmith=1",
      "--label",
      `bumpsmith.job=${(opts.label ?? "none").replace(/[^A-Za-z0-9_.-]/g, "_")}`,
      "--hostname",
      "sandbox",
      "--user",
      UID,
      "--network",
      NETWORK,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,size=1g",
      "--tmpfs",
      `/home/sandbox:rw,exec,nosuid,size=${l.homeTmpfs},uid=10001,gid=10001`,
      "--mount",
      `type=volume,src=${volume},dst=/workspace`,
      "--cpus",
      String(l.cpus),
      "--memory",
      l.memory,
      "--memory-swap",
      l.memory,
      "--pids-limit",
      String(l.pids),
      "--ulimit",
      "nofile=4096:8192",
      ...REGISTRY_HOSTS.flatMap((h) => ["--add-host", `${h}:${MIRROR_IP}`]),
      // CI container jobs reach services by name; here they listen on localhost.
      ...(opts.services?.length
        ? SERVICE_HOST_ALIASES.flatMap((h) => ["--add-host", `${h}:127.0.0.1`])
        : []),
      ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--mount",
      `type=bind,src=${join(CERT_DIR, "ca.crt")},dst=/etc/bumpsmith/ca.crt,readonly`,
      ...[
        "NODE_EXTRA_CA_CERTS=/etc/bumpsmith/ca.crt",
        "YARN_HTTPS_CA_FILE_PATH=/etc/bumpsmith/ca.crt",
        "PIP_CERT=/etc/bumpsmith/ca.crt",
        "REQUESTS_CA_BUNDLE=/etc/bumpsmith/ca.crt",
        "SSL_CERT_FILE=/etc/bumpsmith/ca.crt",
        "UV_SYSTEM_CERTS=1",
      ].flatMap((e) => ["-e", e]),
      image,
      "sleep",
      "infinity",
    ]);
    const sb = new DockerSandbox(id, container, volume);
    await sb.setNetwork(false);
    for (const svc of opts.services ?? []) await sb.startService(svc, opts.label ?? "none");
    return sb;
  }

  /**
   * Start one service sidecar in this sandbox's network namespace: it listens on the
   * sandbox's localhost, keeps its data in memory, and has no network of its own.
   */
  private async startService(svc: ServiceSpec, label: string): Promise<void> {
    const name = `${this.container}-svc-${svc.kind}`;
    const pulled = await run("docker", ["image", "inspect", svc.image]);
    if (pulled.exitCode !== 0) {
      const p = await run("docker", ["pull", "--quiet", svc.image], { timeoutMs: 10 * 60_000 });
      if (p.exitCode !== 0) {
        this.failedServices.push(`${svc.image} (pull failed: ${p.stderr.trim().slice(0, 160)})`);
        return;
      }
    }
    const r = await run("docker", [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "bumpsmith=1",
      "--label",
      `bumpsmith.job=${label.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
      "--network",
      `container:${this.container}`,
      "--cap-drop",
      "ALL",
      ...["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"].flatMap((c) => ["--cap-add", c]),
      "--security-opt",
      "no-new-privileges",
      "--memory",
      "1g",
      "--pids-limit",
      "256",
      "--tmpfs",
      `${DATA_DIRS[svc.kind]}:rw,size=1g`,
      ...Object.entries(svc.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      svc.image,
    ]);
    if (r.exitCode !== 0) {
      this.failedServices.push(`${svc.image} (${r.stderr.trim().slice(0, 160)})`);
      return;
    }
    for (let i = 0; i < 60; i++) {
      const probe = await run("docker", ["exec", name, ...readinessProbe(svc.kind)]);
      if (probe.exitCode === 0) {
        this.startedServices.push(svc.image);
        return;
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    const logs = await run("docker", ["logs", "--tail", "5", name]);
    this.failedServices.push(
      `${svc.image} (not ready after 60 seconds: ${(logs.stdout + logs.stderr).trim().slice(-200)})`,
    );
  }

  /** Attach or detach the internal network. Detached = loopback only. */
  async setNetwork(on: boolean): Promise<void> {
    if (on === this.networkAttached) return;
    await runOk("docker", ["network", on ? "connect" : "disconnect", NETWORK, this.container]);
    this.networkAttached = on;
  }

  /**
   * Run argv inside the sandbox as the unprivileged user. `network: true` attaches
   * the internal network (registry proxy only) for the duration of the command.
   */
  async exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const timeoutSec = opts.timeoutSec ?? 20 * 60;
    const env: string[] = [];
    if (opts.network) await this.setNetwork(true);
    try {
      const r = await run(
        "docker",
        [
          "exec",
          ...(opts.input !== undefined ? ["-i"] : []),
          "--user",
          UID,
          "-w",
          opts.cwd ?? "/workspace",
          ...env,
          this.container,
          "timeout",
          "--kill-after=5s",
          `${timeoutSec}s`,
          ...argv,
        ],
        { input: opts.input, timeoutMs: (timeoutSec + 30) * 1000 },
      );
      return { ...r, timedOut: r.exitCode === 124 || r.exitCode === 137 };
    } finally {
      if (opts.network) await this.setNetwork(false);
    }
  }

  /**
   * Run a check, then restore package.json if the check's own scripts rewrote it
   * (e.g. clean-package strips "scripts" and only restores it on success).
   */
  async execCheck(
    argv: string[],
    opts: ExecOptions & { guardManifest?: boolean } = {},
  ): Promise<ExecResult> {
    if (!opts.guardManifest) return this.exec(argv, opts);
    const bak = "/tmp/bumpsmith-package.json.bak";
    const saved =
      (await this.exec(["cp", "-p", "package.json", bak], { timeoutSec: 10, cwd: opts.cwd }))
        .exitCode === 0;
    try {
      return await this.exec(argv, opts);
    } finally {
      if (saved)
        await this.exec(["cp", "-p", bak, "package.json"], { timeoutSec: 10, cwd: opts.cwd });
    }
  }

  /** Copy a host directory into /workspace (excluding .git and dependency folders). */
  async copyIn(hostDir: string, dest = "/workspace"): Promise<void> {
    if (dest !== "/workspace") await this.exec(["mkdir", "-p", "--", dest], { timeoutSec: 30 });
    await new Promise<void>((resolve, reject) => {
      const tar = spawn("tar", hostTarCreateArgs(hostDir), {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const dock = spawn(
        "docker",
        [
          "exec",
          "-i",
          "--user",
          UID,
          this.container,
          "tar",
          "--no-same-owner",
          "-xf",
          "-",
          "-C",
          dest,
        ],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let errText = "";
      tar.stderr.on("data", (d: Buffer) => (errText += d));
      dock.stderr.on("data", (d: Buffer) => (errText += d));
      tar.stdout.pipe(dock.stdin);
      dock.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`copyIn failed (${code}): ${errText.slice(-1000)}`)),
      );
      tar.on("error", reject);
      dock.on("error", reject);
    });
  }

  /** Copy /workspace out to a host directory, skipping dependency and build folders. */
  async copyOut(hostDir: string): Promise<void> {
    await mkdir(hostDir, { recursive: true });
    const excludes = EXPORT_EXCLUDES.flatMap((e) => [`--exclude=./${e}`, `--exclude=*/${e}`]);
    await new Promise<void>((resolve, reject) => {
      const dock = spawn(
        "docker",
        [
          "exec",
          "--user",
          UID,
          this.container,
          "tar",
          "-cf",
          "-",
          ...excludes,
          "-C",
          "/workspace",
          ".",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // bsdtar refuses absolute paths and ".." by default and does not follow symlinks on extract.
      const tar = spawn("tar", ["-xf", "-", "-C", hostDir], { stdio: ["pipe", "ignore", "pipe"] });
      let errText = "";
      dock.stderr.on("data", (d: Buffer) => (errText += d));
      tar.stderr.on("data", (d: Buffer) => (errText += d));
      dock.stdout.pipe(tar.stdin);
      tar.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`copyOut failed (${code}): ${errText.slice(-1000)}`)),
      );
      tar.on("error", reject);
      dock.on("error", reject);
    });
  }

  async destroy(): Promise<void> {
    const sidecars = await run("docker", ["ps", "-aq", "--filter", `name=${this.container}-svc-`]);
    for (const c of sidecars.stdout.split("\n").filter(Boolean))
      await run("docker", ["rm", "-f", "-v", c]);
    await run("docker", ["rm", "-f", "-v", this.container]);
    await run("docker", ["volume", "rm", "-f", this.volume]);
  }
}

/** Remove containers (and volumes) of one job label, e.g. after a worker crash. */
export async function cleanupJob(label: string): Promise<void> {
  const ps = await run("docker", [
    "ps",
    "-aq",
    "--filter",
    `label=bumpsmith.job=${label.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
  ]);
  for (const id of ps.stdout.split("\n").filter(Boolean))
    await run("docker", ["rm", "-f", "-v", id]);
}

export const dockerSandboxFactory = (opts: CreateOptions) => DockerSandbox.create(opts);

/** Remove any job containers and volumes left behind by crashed runs. */
export async function cleanupStale(): Promise<void> {
  const ps = await run("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=bumpsmith=1",
    "--filter",
    "name=bumpsmith-job-",
  ]);
  for (const id of ps.stdout.split("\n").filter(Boolean))
    await run("docker", ["rm", "-f", "-v", id]);
  const vols = await run("docker", ["volume", "ls", "-q", "--filter", "label=bumpsmith=1"]);
  for (const v of vols.stdout.split("\n").filter(Boolean))
    await run("docker", ["volume", "rm", "-f", v]);
}
