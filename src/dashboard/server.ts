import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "../inventory/inventory.ts";
import type { JobRecord } from "../pipeline.ts";
import { latestRelease } from "../registry/registry.ts";
import { audit, verifyAudit } from "../server/audit.ts";
import {
  Auth,
  AuthError,
  clearCookie,
  cookieName,
  type Principal,
  readCookie,
  sessionCookie,
} from "../server/auth.ts";
import { loadMasterKey, safeEqual } from "../server/crypto.ts";
import { openDb } from "../server/db.ts";
import { can, type Permission } from "../server/rbac.ts";
import { run } from "../util/proc.ts";

/**
 * `bumpsmith dashboard`: the web app over the runs in <repo>/.bumpsmith/runs.
 *
 * Behind a login: accounts, roles and sessions live in a SQLite store in the data directory
 * (see src/server/). The first visit needs a one-time setup link printed by the server to
 * create the owner, so nobody else can claim a fresh install. Every API route declares the
 * permission it needs and is denied otherwise; requests that change anything must come from
 * this origin and carry the session's CSRF token. It also binds 127.0.0.1 by default, sends
 * nothing anywhere (fonts are bundled) and rejects foreign Host headers (DNS rebinding).
 */

function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "dashboard", "index.html"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("cannot locate the bumpsmith dashboard assets");
}

export interface RunSummary {
  id: string;
  created_at: string;
  finished_at: string | null;
  package: string;
  ecosystem: string;
  from: string | null;
  to: string;
  state: string;
  confidence: string | null;
  cost_usd: number;
  duration_ms: number;
  provider: string;
  model: string;
  checks: { name: string; before: boolean | null; after: boolean | null; sameFailures: boolean }[];
  files: number;
  lines: number;
  edited_by_agent: number;
  rounds: number;
  review: string | null;
  reason: string | null;
  upgrade_class: string | null;
  breaking_changes: number;
  impact_items: number;
  has_patch: boolean;
  cost_by_role: Record<string, number>;
  /** Changed lines in files the agent edited (not manifests or lockfiles). */
  agent_lines: number;
}

const ID = /^[\w.-]{1,80}$/;
/** Terminal colour codes, stripped from streamed log lines. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** Plain-words headline reason for a run that is not ready: the most telling note. */
function headlineReason(job: JobRecord): string | null {
  if (job.state === "ready" || job.state === "safe") return null;
  const telling =
    /^(Stopped|Unsupported|Not verified|Baseline install failed|Before the upgrade|The version bump could not|listed as malicious|published|Could not|Skipped checks)/i;
  const rule = job.rules?.find((r) => r.severity === "block");
  const n =
    (rule
      ? `Safety rule ${rule.rule.replace(/_/g, " ")}${rule.file ? ` in ${rule.file}` : ""}: ${rule.detail}`
      : undefined) ??
    job.notes.find((x) => telling.test(x)) ??
    job.gate?.reasons[0] ??
    job.notes.find(
      (x) => !/^(Upgraded together|Workspace members|.* is declared in|Excluded files)/.test(x),
    );
  return n ?? job.error ?? null;
}

export function summarise(job: JobRecord, patch: string): RunSummary {
  const files = new Set<string>();
  const edited = new Set((job.edits ?? []).map((e) => e.path));
  let lines = 0;
  let agentLines = 0;
  let current = "";
  for (const l of patch.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(l);
    if (m?.[1]) {
      current = m[1];
      files.add(current);
    } else if (/^[+-](?![+-]{2} )/.test(l)) {
      lines++;
      if (edited.has(current)) agentLines++;
    }
  }
  const base = job.baseline ?? [];
  const cmp = job.verdict?.comparisons ?? [];
  const names = [...new Set([...base.map((c) => c.name), ...cmp.map((c) => c.name)])];
  return {
    id: job.id,
    created_at: job.created_at,
    finished_at: job.finished_at ?? null,
    package: job.input.packageName,
    ecosystem: job.input.ecosystem ?? "npm",
    from: job.from ?? job.input.from ?? null,
    to: job.input.to,
    state: job.state,
    confidence: job.confidence ?? null,
    cost_usd: job.cost_usd ?? 0,
    duration_ms: job.duration_ms ?? 0,
    provider: job.provider,
    model: job.model,
    checks: names.map((name) => {
      const c = cmp.find((x) => x.name === name);
      return {
        name,
        before: c?.baseline ?? base.find((x) => x.name === name)?.passed ?? null,
        after: c?.after ?? null,
        sameFailures: !!(c as { sameFailures?: unknown } | undefined)?.sameFailures,
      };
    }),
    files: files.size,
    lines,
    edited_by_agent: job.edits?.length ?? 0,
    rounds: job.rounds.length,
    review: job.review?.verdict ?? null,
    reason: headlineReason(job),
    upgrade_class: job.impact?.upgrade_class ?? null,
    breaking_changes: job.change_record?.changes.length ?? 0,
    impact_items: job.impact?.items.length ?? 0,
    has_patch: patch.trim().length > 0,
    agent_lines: agentLines,
    cost_by_role: (job.usage ?? []).reduce<Record<string, number>>((acc, u) => {
      acc[u.role] = (acc[u.role] ?? 0) + u.api_equivalent_usd;
      return acc;
    }, {}),
  };
}

async function readRun(runsDir: string, id: string) {
  const dir = join(runsDir, id);
  const job = JSON.parse(await readFile(join(dir, "job.json"), "utf8")) as JobRecord;
  const patch = await readFile(join(dir, "patch.diff"), "utf8").catch(() => "");
  const evidence = await readFile(join(dir, "evidence.md"), "utf8").catch(() => "");
  return { job, patch, evidence };
}

export async function listRuns(runsDir: string): Promise<RunSummary[]> {
  let ids: string[] = [];
  try {
    ids = (await readdir(runsDir)).filter((d) => ID.test(d));
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const id of ids) {
    try {
      const { job, patch } = await readRun(runsDir, id);
      out.push(summarise(job, patch));
    } catch {
      // not a finished run (or unreadable): skip it
    }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const git = async (dir: string, args: string[]) => {
  const r = await run("git", ["-C", dir, ...args], { timeoutMs: 10_000 }).catch(() => null);
  return r && r.exitCode === 0 ? r.stdout.trim() : null;
};

async function repoInfo(dir: string) {
  const status = await git(dir, ["status", "--porcelain"]);
  return {
    name: basename(dir),
    path: dir,
    branch: await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: (await git(dir, ["rev-parse", "--short", "HEAD"])) ?? null,
    changes: status === null ? null : status.split("\n").filter(Boolean).length,
    user: await git(dir, ["config", "user.name"]),
    remote: await git(dir, ["remote", "get-url", "origin"]),
  };
}

const onPath = async (cmd: string) =>
  (await run("sh", ["-c", `command -v ${cmd}`], { timeoutMs: 3000 }).catch(() => null))
    ?.exitCode === 0;

async function environment() {
  const docker = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 5000,
  }).catch(() => null);
  const providers = [
    {
      id: "claude-code",
      label: "Claude Code",
      detail: "your subscription",
      ok: await onPath("claude"),
    },
    { id: "codex", label: "Codex", detail: "your ChatGPT plan", ok: await onPath("codex") },
    {
      id: "anthropic-api",
      label: "Anthropic API",
      detail: "ANTHROPIC_API_KEY",
      ok: !!process.env.ANTHROPIC_API_KEY,
    },
    { id: "openai", label: "OpenAI", detail: "OPENAI_API_KEY", ok: !!process.env.OPENAI_API_KEY },
    { id: "gemini", label: "Gemini", detail: "GEMINI_API_KEY", ok: !!process.env.GEMINI_API_KEY },
    {
      id: "openrouter",
      label: "OpenRouter",
      detail: "OPENROUTER_API_KEY",
      ok: !!process.env.OPENROUTER_API_KEY,
    },
  ];
  return {
    docker: docker?.exitCode === 0 ? docker.stdout.trim() : null,
    providers,
    defaultProvider: process.env.ANTHROPIC_API_KEY ? "anthropic-api" : "claude-code",
  };
}

interface LiveRun {
  id: string;
  package: string;
  version: string;
  provider: string;
  started_at: string;
  lines: string[];
  stage: string;
  jobId: string | null;
  done: boolean;
  exitCode: number | null;
  listeners: Set<http.ServerResponse>;
}

/** Map a log line to a pipeline stage the UI shows. */
export function stageOf(line: string): string | null {
  const m = /^job \S+: (.*)$/.exec(line);
  const t = (m?.[1] ?? line).toLowerCase();
  if (t.startsWith("preparing repository")) return "prepare";
  if (t.startsWith("building change record")) return "analyse";
  if (/impact item/.test(t)) return "analyse";
  if (t.startsWith("baseline checks")) return "baseline";
  if (t.startsWith("applying the version bump")) return "bump";
  if (t.startsWith("checks after the bump")) return "verify";
  if (t.startsWith("fixer round")) return "fix";
  if (t.startsWith("reviewing")) return "review";
  if (/^(ready|safe|needs_human|blocked_policy|failed_infra|waiting_release_age) \(/.test(t))
    return "done";
  return null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

export interface DashboardOptions {
  repoDir: string;
  runsDir?: string;
  port?: number;
  /** Where accounts, sessions, the audit log and keys are stored (default ~/.bumpsmith). */
  dataDir?: string;
  /** Mark cookies Secure (set when served over HTTPS). */
  secureCookies?: boolean;
  /** The CLI entry (process.argv[1]) used to start upgrades and scans. */
  cliEntry: string;
  log?: (m: string) => void;
}

async function clientBundle(root: string): Promise<string> {
  const built = join(root, "dist", "dashboard-app.js");
  // From source (development), bundle on the fly; a published package ships the build.
  if (fileURLToPath(import.meta.url).endsWith(".ts") || !existsSync(built)) {
    const { build } = await import("esbuild");
    const r = await build({
      entryPoints: [join(root, "src", "dashboard", "client", "app.ts")],
      bundle: true,
      format: "esm",
      target: "es2022",
      write: false,
      minify: false,
      logLevel: "silent",
    });
    return r.outputFiles[0]?.text ?? "";
  }
  return readFile(built, "utf8");
}

export async function startDashboard(opts: DashboardOptions) {
  const root = packageRoot();
  const repoDir = resolve(opts.repoDir);
  const runsDir = resolve(opts.runsDir ?? join(repoDir, ".bumpsmith", "runs"));
  const dataDir = resolve(opts.dataDir ?? join(homedir(), ".bumpsmith"));
  const db = openDb(dataDir);
  await loadMasterKey(join(dataDir, "master.key"));
  const auth = new Auth(db);
  const secure = !!opts.secureCookies;
  const setupToken = auth.needsSetup() ? auth.issueSetupToken() : null;
  const live = new Map<string, LiveRun>();
  const appJs = await clientBundle(root);
  const html = await readFile(join(root, "dashboard", "index.html"), "utf8");
  let port = opts.port ?? 4477;

  const send = (
    res: http.ServerResponse,
    code: number,
    body: unknown,
    type?: string,
    extra: Record<string, string> = {},
  ) => {
    const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, {
      "content-type": type ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "content-security-policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...(secure ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
      ...extra,
    });
    res.end(text);
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 64 * 1024) {
          fail(new Error("body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          fail(new Error("invalid JSON"));
        }
      });
    });

  const cli = (args: string[]) =>
    spawn(process.execPath, [...process.execArgv, opts.cliEntry, ...args], {
      cwd: repoDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const startRun = (pkg: string, version: string, provider: string, budget: number): LiveRun => {
    const lr: LiveRun = {
      id: randomBytes(6).toString("hex"),
      package: pkg,
      version,
      provider,
      started_at: new Date().toISOString(),
      lines: [],
      stage: "prepare",
      jobId: null,
      done: false,
      exitCode: null,
      listeners: new Set(),
    };
    live.set(lr.id, lr);
    const child = cli([
      "fix",
      `${pkg}@${version}`,
      "--repo",
      repoDir,
      "--provider",
      provider,
      "--budget",
      String(budget),
    ]);
    const emit = (event: string, data: unknown) => {
      for (const l of lr.listeners) l.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let buf = "";
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const raw of parts) {
        const line = raw.replace(ANSI, "").trimEnd();
        if (!line) continue;
        lr.lines.push(line);
        if (lr.lines.length > 400) lr.lines.shift();
        const job = /^job (\S+):/.exec(line)?.[1];
        if (job && !lr.jobId) lr.jobId = job;
        const st = stageOf(line);
        if (st) lr.stage = st;
        emit("line", { line, stage: lr.stage, jobId: lr.jobId });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      lr.done = true;
      lr.exitCode = code;
      lr.stage = "done";
      emit("done", { exitCode: code, jobId: lr.jobId });
      for (const l of lr.listeners) l.end();
      lr.listeners.clear();
    });
    return lr;
  };

  type Ctx = {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    url: URL;
    m: RegExpExecArray;
    p: Principal | null;
    ip: string;
    token: string | undefined;
  };
  interface Route {
    method: "GET" | "POST";
    path: RegExp;
    /** "public" needs no session; "session" any signed-in user; otherwise a permission. */
    perm: "public" | "session" | Permission;
    handler: (c: Ctx) => Promise<void> | void;
  }

  const sessionPayload = (p: Principal) => ({
    user: { id: p.user.id, name: p.user.name, email: p.user.email, mfa: !!p.user.mfa_enabled },
    org: auth.org(p.user.org_id),
    role: p.role,
    permissions: p.permissions,
    csrf: p.session.csrf,
  });
  const signIn = (c: Ctx, user: Parameters<Auth["createSession"]>[0]) => {
    if (c.token) auth.endSession(c.token, null, c.ip); // rotate: never reuse a pre-login session
    const s = auth.createSession(user, c.ip, String(c.req.headers["user-agent"] ?? ""));
    const p = auth.principal(s.token) as Principal;
    return send(c.res, 200, sessionPayload(p), undefined, {
      "set-cookie": sessionCookie(s.token, secure, 12 * 3600),
    });
  };
  const authErr = (c: Ctx, e: unknown) => {
    if (e instanceof AuthError) return send(c.res, e.status, { error: e.message });
    throw e;
  };
  const act = (c: Ctx, action: string, target?: string, detail?: Record<string, unknown>) =>
    c.p &&
    audit(db, {
      orgId: c.p.user.org_id,
      actorId: c.p.user.id,
      actor: c.p.user.email,
      action,
      target,
      ip: c.ip,
      detail,
    });

  const routes: Route[] = [
    // ── authentication ──
    {
      method: "GET",
      path: /^\/auth\/session$/,
      perm: "public",
      handler: (c) =>
        c.p
          ? send(c.res, 200, sessionPayload(c.p))
          : send(c.res, 401, { error: "signed out", setupRequired: auth.needsSetup() }),
    },
    {
      method: "POST",
      path: /^\/auth\/setup$/,
      perm: "public",
      handler: async (c) => {
        const b = await readBody(c.req);
        try {
          const user = await auth.setupOwner({
            token: String(b.token ?? ""),
            orgName: String(b.orgName ?? ""),
            name: String(b.name ?? ""),
            email: String(b.email ?? ""),
            password: String(b.password ?? ""),
            ip: c.ip,
          });
          return signIn(c, user);
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/auth\/login$/,
      perm: "public",
      handler: async (c) => {
        const b = await readBody(c.req);
        try {
          const user = await auth.login(String(b.email ?? ""), String(b.password ?? ""), c.ip);
          return signIn(c, user);
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/auth\/logout$/,
      perm: "session",
      handler: (c) => {
        if (c.token) auth.endSession(c.token, c.p, c.ip);
        return send(c.res, 200, { ok: true }, undefined, { "set-cookie": clearCookie(secure) });
      },
    },
    {
      method: "GET",
      path: /^\/api\/audit\/verify$/,
      perm: "audit.view",
      handler: (c) => send(c.res, 200, verifyAudit(db)),
    },

    // ── the repository and its runs ──
    {
      method: "GET",
      path: /^\/api\/state$/,
      perm: "runs.view",
      handler: async (c) => {
        const debtFile = join(repoDir, ".bumpsmith", "debt.json");
        let deps: Record<string, string> = {};
        let ecosystem: string | null = null;
        let packageManager: string | null = null;
        try {
          const inv = await inventory(repoDir);
          deps = inv.dependencies;
          ecosystem = inv.ecosystem;
          packageManager = inv.packageManager;
        } catch {
          // not a supported repository: the dashboard still shows runs
        }
        return send(c.res, 200, {
          repo: { ...(await repoInfo(repoDir)), ecosystem, packageManager, dependencies: deps },
          env: await environment(),
          runsDir,
          runs: await listRuns(runsDir),
          debt: existsSync(debtFile) ? JSON.parse(await readFile(debtFile, "utf8")) : null,
          live: [...live.values()].map(({ listeners: _l, ...r }) => r),
        });
      },
    },
    {
      // One file from a run's before/ or after/ snapshot (diff "expand context").
      method: "GET",
      path: /^\/api\/runs\/([\w.-]+)\/file$/,
      perm: "runs.view",
      handler: async (c) => {
        const id = c.m[1] as string;
        if (!ID.test(id)) return send(c.res, 400, { error: "bad run id" });
        const side = c.url.searchParams.get("side") === "before" ? "before" : "after";
        const rel = c.url.searchParams.get("path") ?? "";
        const base = join(runsDir, id, side);
        const file = resolve(base, rel);
        if (!rel || rel.includes("\0") || !file.startsWith(base + sep))
          return send(c.res, 400, { error: "bad path" });
        // Symlinks in the repository must not lead outside the snapshot.
        const real = await realpath(file).catch(() => null);
        const realBase = await realpath(base).catch(() => null);
        if (!real || !realBase || !real.startsWith(realBase + sep))
          return send(c.res, 404, { error: "the full file is not stored for this run" });
        const st = await stat(real).catch(() => null);
        if (!st?.isFile())
          return send(c.res, 404, { error: "the full file is not stored for this run" });
        if (st.size > 2 * 1024 * 1024) return send(c.res, 413, { error: "file too large to show" });
        return send(c.res, 200, { text: await readFile(real, "utf8") });
      },
    },
    {
      method: "GET",
      path: /^\/api\/runs\/([\w.-]+)$/,
      perm: "runs.view",
      handler: async (c) => {
        const dir = runDir(c.m[1] as string);
        if (!dir) return send(c.res, 404, { error: "no such run" });
        const r = await readRun(runsDir, c.m[1] as string);
        return send(c.res, 200, { ...r, summary: summarise(r.job, r.patch) });
      },
    },
    {
      method: "POST",
      path: /^\/api\/runs\/([\w.-]+)\/apply$/,
      perm: "runs.apply",
      handler: async (c) => {
        const dir = runDir(c.m[1] as string);
        if (!dir) return send(c.res, 404, { error: "no such run" });
        const patchFile = join(dir, "patch.diff");
        if (!(await stat(patchFile).catch(() => null))?.size)
          return send(c.res, 400, { error: "this run has no patch" });
        const check = await run("git", ["-C", repoDir, "apply", "--check", "--index", patchFile]);
        if (check.exitCode !== 0)
          return send(c.res, 409, {
            error: `the patch does not apply to your working tree: ${(check.stderr || check.stdout).trim().slice(0, 400)}`,
          });
        await run("git", ["-C", repoDir, "apply", "--index", patchFile]);
        act(c, "run.applied", c.m[1]);
        return send(c.res, 200, {
          ok: true,
          message: "Applied and staged. Review with git diff --cached.",
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/runs\/([\w.-]+)\/delete$/,
      perm: "runs.delete",
      handler: async (c) => {
        const dir = runDir(c.m[1] as string);
        if (!dir) return send(c.res, 404, { error: "no such run" });
        await rm(dir, { recursive: true, force: true });
        act(c, "run.deleted", c.m[1]);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/runs$/,
      perm: "runs.start",
      handler: async (c) => {
        const b = await readBody(c.req);
        const pkg = String(b.package ?? "").trim();
        const version = String(b.version ?? "").trim();
        const provider = String(b.provider ?? "claude-code");
        const budget = Math.min(50, Math.max(0.5, Number(b.budget ?? 8)));
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg) || !/^\d[\w.+-]*$/.test(version))
          return send(c.res, 400, { error: "expected a package name and an exact version" });
        if (!/^[\w-]+$/.test(provider)) return send(c.res, 400, { error: "bad provider" });
        const lr = startRun(pkg, version, provider, budget);
        act(c, "run.started", `${pkg}@${version}`, { provider, budget });
        return send(c.res, 200, { id: lr.id });
      },
    },
    {
      method: "GET",
      path: /^\/api\/live\/([a-f0-9]{12})$/,
      perm: "runs.view",
      handler: (c) => {
        const lr = live.get(c.m[1] as string);
        if (!lr) return send(c.res, 404, { error: "no such live run" });
        c.res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        for (const line of lr.lines)
          c.res.write(
            `event: line\ndata: ${JSON.stringify({ line, stage: lr.stage, jobId: lr.jobId })}\n\n`,
          );
        if (lr.done) {
          c.res.write(
            `event: done\ndata: ${JSON.stringify({ exitCode: lr.exitCode, jobId: lr.jobId })}\n\n`,
          );
          c.res.end();
          return;
        }
        lr.listeners.add(c.res);
        c.req.on("close", () => lr.listeners.delete(c.res));
      },
    },
    {
      method: "POST",
      path: /^\/api\/scan$/,
      perm: "runs.start",
      handler: async (c) => {
        const child = cli(["scan", "--repo", repoDir]);
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        const code = await new Promise<number | null>((r) => child.on("close", r));
        const debtFile = join(repoDir, ".bumpsmith", "debt.json");
        if (code !== 0 || !existsSync(debtFile))
          return send(c.res, 500, {
            error: err.trim().split("\n").slice(-3).join(" ") || "scan failed",
          });
        act(c, "deps.scanned");
        return send(c.res, 200, JSON.parse(await readFile(debtFile, "utf8")));
      },
    },
    {
      method: "GET",
      path: /^\/api\/latest$/,
      perm: "runs.view",
      handler: async (c) => {
        const name = c.url.searchParams.get("name") ?? "";
        const eco = c.url.searchParams.get("ecosystem") === "pypi" ? "pypi" : "npm";
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return send(c.res, 400, { error: "bad name" });
        return send(c.res, 200, (await latestRelease(eco, name)) ?? { version: null });
      },
    },
  ];

  const runDir = (id: string) => {
    if (!ID.test(id)) return null;
    const dir = join(runsDir, id);
    return dir.startsWith(runsDir + sep) && existsSync(join(dir, "job.json")) ? dir : null;
  };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding: only this server's own address may be the Host.
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
        return send(res, 421, { error: "wrong host" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/index.html"))
        return send(res, 200, html, MIME[".html"]);
      if (req.method === "GET" && path === "/app.js") return send(res, 200, appJs, MIME[".js"]);
      if (
        req.method === "GET" &&
        /^\/(app\.css|fonts\/[\w-]+\.woff2|brand\/[\w-]+\.svg)$/.test(path)
      ) {
        const file = join(root, "dashboard", path);
        const body = await readFile(file).catch(() => null);
        return body
          ? send(res, 200, body, MIME[extname(file)])
          : send(res, 404, { error: "not found" });
      }

      let route: Route | undefined;
      let m: RegExpExecArray | null = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        m = r.path.exec(path);
        if (m) {
          route = r;
          break;
        }
      }
      if (!route || !m) return send(res, 404, { error: "not found" });

      const ip = req.socket.remoteAddress ?? "";
      const token = readCookie(req.headers.cookie, cookieName(secure));
      const p = auth.principal(token);

      // Anything that changes state must come from this origin (cross-site requests are
      // also blocked by SameSite=Strict cookies; this is defence in depth).
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== `http${secure ? "s" : ""}://${host}`)
          return send(res, 403, { error: "cross-origin request refused" });
        if (route.perm === "public" && auth.rateLimited(ip))
          return send(res, 429, { error: "Too many attempts. Wait a few minutes." });
      }
      if (route.perm !== "public") {
        if (!p) return send(res, 401, { error: "Your session has ended. Sign in again." });
        if (req.method !== "GET") {
          const csrf = String(req.headers["x-csrf-token"] ?? "");
          if (!safeEqual(csrf, p.session.csrf))
            return send(res, 403, { error: "missing or wrong CSRF token" });
        }
        if (route.perm !== "session" && !can(p.permissions, route.perm))
          return send(res, 403, { error: "Your role does not allow this." });
      }
      await route.handler({ req, res, url, m, p, ip, token });
    } catch (err) {
      if (!res.headersSent)
        return send(res, 500, { error: String((err as Error).message ?? err).slice(0, 300) });
    }
  });

  await new Promise<void>((ok, fail) => {
    const tryListen = (p: number, attempts: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempts > 0) tryListen(p + 1, attempts - 1);
        else fail(e);
      });
      server.listen(p, "127.0.0.1", () => {
        port = p;
        ok();
      });
    };
    tryListen(port, 20);
  });
  const url = `http://127.0.0.1:${port}/`;
  return {
    url,
    port,
    dataDir,
    /** Open once to create the owner account; null when the server is already set up. */
    setupUrl: setupToken ? `${url}#/setup/${setupToken}` : null,
    routes: routes.map((r) => ({ method: r.method, path: String(r.path), perm: r.perm })),
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          db.close();
          r();
        }),
      ),
  };
}
