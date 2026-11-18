import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inventory } from "../inventory/inventory.ts";
import type { JobRecord } from "../pipeline.ts";
import { latestRelease } from "../registry/registry.ts";
import { run } from "../util/proc.ts";

/**
 * `bumpsmith dashboard`: a local web app over the runs in <repo>/.bumpsmith/runs.
 *
 * Local only and private: it binds 127.0.0.1, sends nothing anywhere (fonts are bundled),
 * rejects requests whose Host is not this server (DNS rebinding), and every API call needs
 * the per-session token embedded in the page (a page on another site cannot read it).
 * Actions: start an upgrade (the same `bumpsmith fix` the CLI runs, streamed live), apply a
 * verified patch to the working tree, delete a run, scan dependencies.
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
  const token = randomBytes(24).toString("hex");
  const live = new Map<string, LiveRun>();
  const appJs = await clientBundle(root);
  const html = (await readFile(join(root, "dashboard", "index.html"), "utf8")).replace(
    "%%TOKEN%%",
    token,
  );
  let port = opts.port ?? 4477;

  const send = (res: http.ServerResponse, code: number, body: unknown, type?: string) => {
    const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(code, {
      "content-type": type ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy":
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
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

      if (!path.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (req.headers["x-bumpsmith-token"] !== token) return send(res, 403, { error: "token" });

      if (req.method === "GET" && path === "/api/state") {
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
        return send(res, 200, {
          repo: { ...(await repoInfo(repoDir)), ecosystem, packageManager, dependencies: deps },
          env: await environment(),
          runsDir,
          runs: await listRuns(runsDir),
          debt: existsSync(debtFile) ? JSON.parse(await readFile(debtFile, "utf8")) : null,
          live: [...live.values()].map(({ listeners: _l, ...r }) => r),
        });
      }

      // One file from a run's before/ or after/ snapshot (diff "expand context").
      const fileMatch = /^\/api\/runs\/([\w.-]+)\/file$/.exec(path);
      if (req.method === "GET" && fileMatch?.[1] && ID.test(fileMatch[1])) {
        const side = url.searchParams.get("side") === "before" ? "before" : "after";
        const rel = url.searchParams.get("path") ?? "";
        const base = join(runsDir, fileMatch[1], side);
        const file = resolve(base, rel);
        if (!rel || rel.includes("\0") || !file.startsWith(base + sep))
          return send(res, 400, { error: "bad path" });
        // Symlinks in the repository must not lead outside the snapshot.
        const real = await realpath(file).catch(() => null);
        const realBase = await realpath(base).catch(() => null);
        if (!real || !realBase || !real.startsWith(realBase + sep))
          return send(res, 404, { error: "the full file is not stored for this run" });
        const st = await stat(real).catch(() => null);
        if (!st?.isFile())
          return send(res, 404, { error: "the full file is not stored for this run" });
        if (st.size > 2 * 1024 * 1024) return send(res, 413, { error: "file too large to show" });
        return send(res, 200, { text: await readFile(real, "utf8") });
      }

      const runMatch = /^\/api\/runs\/([\w.-]+)(\/apply|\/delete)?$/.exec(path);
      if (runMatch?.[1] && ID.test(runMatch[1])) {
        const id = runMatch[1];
        const dir = join(runsDir, id);
        if (!dir.startsWith(runsDir + sep) || !existsSync(join(dir, "job.json")))
          return send(res, 404, { error: "no such run" });
        if (req.method === "GET" && !runMatch[2]) {
          const r = await readRun(runsDir, id);
          return send(res, 200, { ...r, summary: summarise(r.job, r.patch) });
        }
        if (req.method === "POST" && runMatch[2] === "/apply") {
          const patchFile = join(dir, "patch.diff");
          if (!(await stat(patchFile).catch(() => null))?.size)
            return send(res, 400, { error: "this run has no patch" });
          const check = await run("git", ["-C", repoDir, "apply", "--check", "--index", patchFile]);
          if (check.exitCode !== 0)
            return send(res, 409, {
              error: `the patch does not apply to your working tree: ${(check.stderr || check.stdout).trim().slice(0, 400)}`,
            });
          await run("git", ["-C", repoDir, "apply", "--index", patchFile]);
          return send(res, 200, {
            ok: true,
            message: "Applied and staged. Review with git diff --cached.",
          });
        }
        if (req.method === "POST" && runMatch[2] === "/delete") {
          await rm(dir, { recursive: true, force: true });
          return send(res, 200, { ok: true });
        }
      }

      if (req.method === "POST" && path === "/api/runs") {
        const b = await readBody(req);
        const pkg = String(b.package ?? "").trim();
        const version = String(b.version ?? "").trim();
        const provider = String(b.provider ?? "claude-code");
        const budget = Math.min(50, Math.max(0.5, Number(b.budget ?? 8)));
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg) || !/^\d[\w.+-]*$/.test(version))
          return send(res, 400, { error: "expected a package name and an exact version" });
        if (!/^[\w-]+$/.test(provider)) return send(res, 400, { error: "bad provider" });
        const lr = startRun(pkg, version, provider, budget);
        return send(res, 200, { id: lr.id });
      }

      const liveMatch = /^\/api\/live\/([a-f0-9]{12})$/.exec(path);
      if (req.method === "GET" && liveMatch?.[1]) {
        const lr = live.get(liveMatch[1]);
        if (!lr) return send(res, 404, { error: "no such live run" });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        for (const line of lr.lines)
          res.write(
            `event: line\ndata: ${JSON.stringify({ line, stage: lr.stage, jobId: lr.jobId })}\n\n`,
          );
        if (lr.done) {
          res.write(
            `event: done\ndata: ${JSON.stringify({ exitCode: lr.exitCode, jobId: lr.jobId })}\n\n`,
          );
          return res.end();
        }
        lr.listeners.add(res);
        req.on("close", () => lr.listeners.delete(res));
        return;
      }

      if (req.method === "POST" && path === "/api/scan") {
        const child = cli(["scan", "--repo", repoDir]);
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        const code = await new Promise<number | null>((r) => child.on("close", r));
        const debtFile = join(repoDir, ".bumpsmith", "debt.json");
        if (code !== 0 || !existsSync(debtFile))
          return send(res, 500, {
            error: err.trim().split("\n").slice(-3).join(" ") || "scan failed",
          });
        return send(res, 200, JSON.parse(await readFile(debtFile, "utf8")));
      }

      if (req.method === "GET" && path === "/api/latest") {
        const name = url.searchParams.get("name") ?? "";
        const eco = url.searchParams.get("ecosystem") === "pypi" ? "pypi" : "npm";
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return send(res, 400, { error: "bad name" });
        return send(res, 200, (await latestRelease(eco, name)) ?? { version: null });
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
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
  return { url, port, close: () => new Promise<void>((r) => server.close(() => r())) };
}
