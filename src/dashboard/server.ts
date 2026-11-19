import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import QRCode from "qrcode";
import { inventory } from "../inventory/inventory.ts";
import { bumpsmithVersion } from "../mcp/local.ts";
import { createMcpServer, type McpHost, type McpRepo } from "../mcp/tools.ts";
import type { JobRecord } from "../pipeline.ts";
import { latestRelease } from "../registry/registry.ts";
import { audit, verifyAudit } from "../server/audit.ts";
import {
  Auth,
  AuthError,
  clearCookie,
  cookieName,
  DEFAULT_POLICY,
  type Principal,
  readCookie,
  sessionCookie,
} from "../server/auth.ts";
import { loadMasterKey, safeEqual, verifyPassword } from "../server/crypto.ts";
import { openDb } from "../server/db.ts";
import { Integrations, KEY_PROVIDERS } from "../server/integrations.ts";
import { Org, type Workspace, WS_PERMS } from "../server/org.ts";
import { can, PERMISSIONS, type Permission } from "../server/rbac.ts";
import { type Identity, Sso, type SsoConfig } from "../server/sso.ts";
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

/** Summaries keyed by run directory, re-read only when job.json or patch.diff changes. */
const summaryCache = new Map<string, { key: string; summary: RunSummary }>();

export async function listRuns(runsDir: string): Promise<RunSummary[]> {
  let ids: string[] = [];
  try {
    ids = (await readdir(runsDir)).filter((d) => ID.test(d));
  } catch {
    return [];
  }
  const out = await Promise.all(
    ids.map(async (id) => {
      const dir = join(runsDir, id);
      try {
        const [j, p] = await Promise.all([
          stat(join(dir, "job.json")),
          stat(join(dir, "patch.diff")).catch(() => null),
        ]);
        const key = `${j.mtimeMs}:${j.size}:${p?.mtimeMs ?? 0}:${p?.size ?? 0}`;
        const hit = summaryCache.get(dir);
        if (hit?.key === key) return hit.summary;
        const { job, patch } = await readRun(runsDir, id);
        const summary = summarise(job, patch);
        summaryCache.set(dir, { key, summary });
        return summary;
      } catch {
        return null; // not a finished run (or unreadable): skip it
      }
    }),
  );
  return out
    .filter((x): x is RunSummary => x !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
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

type Env = Awaited<ReturnType<typeof checkEnvironment>>;
let envCache: { at: number; value: Env | null; pending: Promise<Env> | null } = {
  at: 0,
  value: null,
  pending: null,
};

/**
 * Docker and model-tool status. Checking Docker takes seconds, so requests get the last
 * result at once and a fresh check runs in the background when it is over a minute old.
 */
async function environment(): Promise<Env> {
  const stale = Date.now() - envCache.at > 60_000;
  if (stale && !envCache.pending)
    envCache.pending = checkEnvironment()
      .then((v) => {
        envCache = { at: Date.now(), value: v, pending: null };
        return v;
      })
      .catch((e) => {
        envCache.pending = null;
        throw e;
      });
  return envCache.value ?? (envCache.pending as Promise<Env>);
}

async function checkEnvironment() {
  const [docker, claude, codex] = await Promise.all([
    run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 5000 }).catch(
      () => null,
    ),
    onPath("claude"),
    onPath("codex"),
  ]);
  const providers = [
    {
      id: "claude-code",
      label: "Claude Code",
      detail: "your subscription",
      ok: claude,
    },
    { id: "codex", label: "Codex", detail: "your ChatGPT plan", ok: codex },
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
  /** The repository (workspace) it runs in. */
  ws: string;
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
  ".png": "image/png",
};

export interface DashboardOptions {
  /** Local mode: the repository the dashboard was started in. Omit in server mode. */
  repoDir?: string;
  runsDir?: string;
  port?: number;
  /** Where accounts, sessions, the audit log and keys are stored (default ~/.bumpsmith). */
  dataDir?: string;
  /** Mark cookies Secure (set when served over HTTPS). */
  secureCookies?: boolean;
  /**
   * "local" (default) binds loopback and may open folders on this machine. "server" is the
   * self-hosted, multi-user mode: repositories come from GitHub only.
   */
  mode?: "local" | "server";
  /** Address to bind (default 127.0.0.1). */
  host?: string;
  /**
   * The address people use, e.g. https://bumpsmith.acme.dev. Required in server mode: it is the
   * only Host and Origin accepted, and the base of every link Bumpsmith hands out.
   */
  publicUrl?: string;
  /** Serve HTTPS directly with this PEM certificate and key. */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /**
   * Proxies (exact IP addresses) whose X-Forwarded-For is believed. Requests from anywhere
   * else use the socket address, so a client cannot forge its IP for rate limits or the audit log.
   */
  trustedProxies?: string[];
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
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      write: false,
      minify: false,
      logLevel: "silent",
    });
    return r.outputFiles[0]?.text ?? "";
  }
  return readFile(built, "utf8");
}

/** "::ffff:10.0.0.1" and "10.0.0.1" are the same client. */
function normaliseIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * The client's address. X-Forwarded-For is read right to left, skipping trusted proxies, and
 * only when the request itself came from a trusted proxy: anything further left is client-supplied.
 */
export function clientIp(req: http.IncomingMessage, trusted: Set<string>): string {
  const peer = normaliseIp(req.socket.remoteAddress ?? "");
  if (!trusted.has(peer)) return peer;
  const hops = String(req.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((h) => normaliseIp(h.trim()))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const h = hops[i] as string;
    if (!trusted.has(h)) return h;
  }
  return peer;
}

export async function startDashboard(opts: DashboardOptions) {
  const root = packageRoot();
  const mode = opts.mode ?? "local";
  const repoDir = opts.repoDir ? resolve(opts.repoDir) : null;
  const runsDir = repoDir ? resolve(opts.runsDir ?? join(repoDir, ".bumpsmith", "runs")) : null;
  const publicUrl = opts.publicUrl ? new URL(opts.publicUrl) : null;
  if (mode === "server" && !publicUrl) throw new Error("server mode needs a public URL");
  if (publicUrl && (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash))
    throw new Error("the public URL must be an origin, like https://bumpsmith.acme.dev");
  const trusted = new Set((opts.trustedProxies ?? []).map(normaliseIp));
  const dataDir = resolve(opts.dataDir ?? join(homedir(), ".bumpsmith"));
  const db = openDb(dataDir);
  const masterKey = await loadMasterKey(join(dataDir, "master.key"));
  const auth = new Auth(db, DEFAULT_POLICY, masterKey);
  const org = new Org(db);
  const integrations = new Integrations(db, masterKey);
  const sso = new Sso(
    db,
    (id) => auth.extra(id),
    (id, patch) => auth.setExtra(id, patch),
    (id, name) => integrations.get(id, name),
  );
  /** Self-hosted installs hold one organisation; SSO and sign-in belong to it. */
  const firstOrg = () =>
    (
      db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get() as
        | { id: string }
        | undefined
    )?.id;
  /** The repository this dashboard was started in becomes the organisation's first one. */
  const ensureLocalWorkspace = () => {
    const o = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (o && repoDir && runsDir && mode === "local") org.ensureLocal(o.id, repoDir, runsDir, null);
  };
  ensureLocalWorkspace();
  void environment().catch(() => {}); // warm: Docker takes seconds to answer
  const secure = !!opts.secureCookies || !!opts.tls || publicUrl?.protocol === "https:";
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
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com",
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

  /** Upgrade runs get the organisation's model keys in their environment, and only them. */
  const cli = (args: string[], cwd: string, orgId?: string) =>
    spawn(process.execPath, [...process.execArgv, opts.cliEntry, ...args], {
      cwd,
      env: { ...process.env, ...(orgId ? integrations.runEnv(orgId) : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

  const startRun = (
    w: Workspace,
    pkg: string,
    version: string,
    provider: string,
    budget: number,
  ): LiveRun => {
    const lr: LiveRun = {
      id: randomBytes(6).toString("hex"),
      ws: w.id,
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
    const child = cli(
      [
        "fix",
        `${pkg}@${version}`,
        "--repo",
        w.path,
        "--provider",
        provider,
        "--budget",
        String(budget),
      ],
      w.path,
      w.org_id,
    );
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
    /** The repository, for routes under /api/w/<slug>/. */
    w?: Workspace;
    /** What the user may do in that repository. */
    wsPerms: string[];
  };
  interface Route {
    method: "GET" | "POST";
    path: RegExp;
    /** "public" needs no session; "session" any signed-in user; otherwise a permission. */
    /**
     * "public": no session. "pending": a session waiting for its MFA code. "session": any
     * signed-in user. Otherwise the permission the route needs.
     */
    perm: "public" | "pending" | "session" | Permission;
    /** Needs a recent password or MFA confirmation (step-up). */
    stepUp?: boolean;
    /** Allowed while the user still has to enrol in MFA. */
    enroll?: boolean;
    /** Account routes: never usable with a personal API token. */
    noToken?: boolean;
    /** Accepts a cross-site POST (the SAML response from the identity provider). */
    crossSite?: boolean;
    /** The first capture is a repository slug; permission is checked inside that repository. */
    ws?: boolean;
    handler: (c: Ctx) => Promise<void> | void;
  }

  const sessionPayload = (p: Principal) => ({
    user: { id: p.user.id, name: p.user.name, email: p.user.email, mfa: !!p.user.mfa_enabled },
    org: auth.org(p.user.org_id),
    role: p.role,
    permissions: p.permissions,
    csrf: p.session.csrf,
    mustEnrollMfa: p.mustEnrollMfa,
    method: p.session.method ?? "password",
  });
  const ua = (c: Ctx) => String(c.req.headers["user-agent"] ?? "");
  const cookieFor = (token: string) => sessionCookie(token, secure, 72 * 3600);
  const signIn = (c: Ctx, user: Parameters<Auth["createSession"]>[0]) => {
    if (c.token) auth.endSession(c.token, null, c.ip); // rotate: never reuse a pre-login session
    if (user.mfa_enabled) {
      // Password accepted; the session only becomes usable after the second factor.
      const s = auth.createSession(user, c.ip, ua(c), true);
      return send(c.res, 200, { mfaRequired: true }, undefined, {
        "set-cookie": cookieFor(s.token),
      });
    }
    const s = auth.createSession(user, c.ip, ua(c));
    const p = auth.principal(s.token) as Principal;
    return send(c.res, 200, sessionPayload(p), undefined, { "set-cookie": cookieFor(s.token) });
  };
  const mfaFailures = new Map<string, number>();
  /** Model availability for one organisation: detected tools plus its stored keys. */
  const orgEnv = (orgId: string, env: Awaited<ReturnType<typeof environment>>) => {
    const stored = new Set(integrations.list(orgId).map((x) => x.name));
    const providers = env.providers.map((p) => {
      const k = KEY_PROVIDERS.find((x) => x.id === p.id);
      return k && stored.has(k.env) ? { ...p, ok: true, detail: "key saved in Bumpsmith" } : p;
    });
    const want = auth.extra(orgId).defaultProvider as string | undefined;
    const def =
      providers.find((p) => p.id === want && p.ok)?.id ??
      providers.find((p) => p.ok)?.id ??
      env.defaultProvider;
    return { ...env, providers, defaultProvider: def };
  };
  /** Signed in through the identity provider: a fresh session, then into the app. */
  const ssoSignIn = (c: Ctx, orgId: string, identity: Identity) => {
    const user = sso.resolve(orgId, identity, c.ip);
    if (c.token) auth.endSession(c.token, null, c.ip);
    const s = auth.createSession(user, c.ip, ua(c), false, "sso");
    return send(c.res, 302, "", "text/plain", {
      location: "/#/",
      "set-cookie": cookieFor(s.token),
    });
  };
  const readForm = (req: http.IncomingMessage) =>
    new Promise<URLSearchParams>((ok, fail) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (d: Buffer) => {
        size += d.length;
        if (size > 1024 * 1024) {
          fail(new AuthError(413, "SAML response too large."));
          req.destroy();
        } else chunks.push(d);
      });
      req.on("end", () => ok(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    });
  const redirect = (res: http.ServerResponse, location: string) =>
    send(res, 302, "", "text/plain", { location });
  const origin = (_c?: Ctx) =>
    publicUrl ? publicUrl.origin : `http${secure ? "s" : ""}://127.0.0.1:${port}`;
  const CATEGORIES: Record<string, string> = {
    auth: "auth.%",
    people: "member.%",
    access: "access.%",
    roles: "role.%",
    runs: "run.%",
    security: "security.%",
  };
  const auditRows = (orgId: string, q: string, cat: string, before: number, limit: number) => {
    const where = ["(org_id = ? OR org_id IS NULL)"];
    const args: (string | number)[] = [orgId];
    if (before > 0) {
      where.push("seq < ?");
      args.push(before);
    }
    if (CATEGORIES[cat]) {
      where.push("action LIKE ?");
      args.push(CATEGORIES[cat] as string);
    }
    if (q.trim()) {
      where.push("(actor LIKE ? OR action LIKE ? OR target LIKE ? OR ip LIKE ?)");
      const like = `%${q.trim().slice(0, 80)}%`;
      args.push(like, like, like, like);
    }
    return db
      .prepare(
        `SELECT seq, at, actor, action, target, ip, detail, hash FROM audit WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`,
      )
      .all(...args, Math.max(1, limit)) as unknown as {
      seq: number;
      at: string;
      actor: string;
      action: string;
      target: string | null;
      ip: string | null;
      detail: string;
      hash: string;
    }[];
  };
  const body = async (c: Ctx) => readBody(c.req);
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
          ensureLocalWorkspace();
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
          // With SSO required, passwords are for Owners only (break-glass if the IdP is down).
          if (sso.config(user.org_id).enforce && user.role_id !== `${user.org_id}:owner`)
            return send(c.res, 403, {
              error: "Your organisation signs in with single sign-on. Use the SSO button.",
              sso: true,
            });
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
      method: "POST",
      path: /^\/auth\/mfa$/,
      perm: "pending",
      handler: async (c) => {
        const p = c.p as Principal;
        const key = p.session.id_hash;
        const used = auth.checkSecondFactor(p.user.id, String((await body(c)).code ?? ""));
        if (!used) {
          const n = (mfaFailures.get(key) ?? 0) + 1;
          mfaFailures.set(key, n);
          act(c, "auth.mfa_failed", undefined, { attempt: n });
          if (n >= 5) {
            if (c.token) auth.endSession(c.token, null, c.ip);
            mfaFailures.delete(key);
            return send(c.res, 401, { error: "Too many wrong codes. Sign in again." }, undefined, {
              "set-cookie": clearCookie(secure),
            });
          }
          return send(c.res, 400, {
            error: "That code is not valid. Check your authenticator app.",
          });
        }
        mfaFailures.delete(key);
        const s = auth.completeMfa(c.token as string, p, c.ip, ua(c));
        if (used === "recovery")
          act(c, "auth.recovery_code_used", undefined, {
            left: auth.remainingRecoveryCodes(p.user.id),
          });
        const next = auth.principal(s.token) as Principal;
        return send(c.res, 200, sessionPayload(next), undefined, {
          "set-cookie": cookieFor(s.token),
        });
      },
    },
    {
      // Step-up: confirm it's you before a sensitive action (MFA code if enrolled, else password).
      method: "POST",
      path: /^\/api\/me\/reauth$/,
      perm: "session",
      noToken: true,
      handler: async (c) => {
        const p = c.p as Principal;
        if (auth.rateLimited(`reauth:${p.user.id}`, 10))
          return send(c.res, 429, { error: "Too many attempts. Wait a few minutes." });
        const b = await body(c);
        let ok = false;
        if (p.user.mfa_enabled)
          ok = auth.checkSecondFactor(p.user.id, String(b.code ?? "")) !== null;
        else
          ok = await verifyPassword(
            String(b.password ?? ""),
            auth.user(p.user.id)?.password_hash ?? null,
          );
        act(c, ok ? "auth.reauth" : "auth.reauth_failed");
        if (!ok)
          return send(c.res, 400, {
            error: p.user.mfa_enabled ? "That code is not valid." : "That password is not correct.",
          });
        auth.markFresh(p);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      path: /^\/api\/me$/,
      perm: "session",
      enroll: true,
      noToken: true,
      handler: (c) => {
        const p = c.p as Principal;
        return send(c.res, 200, {
          user: {
            ...sessionPayload(p).user,
            created_at: (auth.user(p.user.id) as { created_at?: string }).created_at,
          },
          mfa: {
            enabled: !!p.user.mfa_enabled,
            recoveryLeft: auth.remainingRecoveryCodes(p.user.id),
            required: p.mustEnrollMfa || auth.settings(p.user.org_id).mfa !== "off",
          },
          sessions: auth.sessions(p.user.id, p.session.id_hash),
          tokens: auth.apiTokens(p.user.id).map((t) => ({ ...t, scopes: JSON.parse(t.scopes) })),
          permissions: PERMISSIONS.filter((x) => p.permissions.includes(x.id)),
          fresh: auth.fresh(p),
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/profile$/,
      perm: "session",
      noToken: true,
      handler: async (c) => {
        const name = String((await body(c)).name ?? "").trim();
        if (!name || name.length > 80)
          return send(c.res, 400, { error: "Enter a name (up to 80 characters)." });
        db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, c.p?.user.id ?? "");
        act(c, "user.profile_updated");
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/password$/,
      perm: "session",
      noToken: true,
      handler: async (c) => {
        const b = await body(c);
        try {
          await auth.changePassword(
            c.p as Principal,
            String(b.current ?? ""),
            String(b.next ?? ""),
            c.ip,
          );
          return send(c.res, 200, { ok: true });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/mfa\/start$/,
      perm: "session",
      enroll: true,
      noToken: true,
      handler: async (c) => {
        const p = c.p as Principal;
        if (p.user.mfa_enabled)
          return send(c.res, 409, { error: "Two-factor authentication is already on." });
        const org = auth.org(p.user.org_id);
        const m = auth.startMfa(p.user.id, p.user.email, `Bumpsmith (${org?.name ?? "Bumpsmith"})`);
        const qr = await QRCode.toString(m.url, {
          type: "svg",
          margin: 0,
          errorCorrectionLevel: "M",
          color: { dark: "#121211", light: "#00000000" },
        });
        return send(c.res, 200, { secret: m.secret, qr });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/mfa\/confirm$/,
      perm: "session",
      enroll: true,
      noToken: true,
      handler: async (c) => {
        const p = c.p as Principal;
        const codes = auth.confirmMfa(p.user.id, String((await body(c)).code ?? ""));
        if (!codes)
          return send(c.res, 400, {
            error: "That code is not valid. Enter the 6 digits your app shows now.",
          });
        auth.markFresh(p);
        act(c, "auth.mfa_enabled");
        return send(c.res, 200, { recoveryCodes: codes });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/mfa\/recovery$/,
      perm: "session",
      stepUp: true,
      noToken: true,
      handler: (c) => {
        const p = c.p as Principal;
        if (!p.user.mfa_enabled)
          return send(c.res, 400, { error: "Turn on two-factor authentication first." });
        act(c, "auth.recovery_codes_regenerated");
        return send(c.res, 200, { recoveryCodes: auth.newRecoveryCodes(p.user.id) });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/mfa\/disable$/,
      perm: "session",
      stepUp: true,
      noToken: true,
      handler: (c) => {
        const p = c.p as Principal;
        const pol = auth.settings(p.user.org_id);
        const admin = p.permissions.some((x) =>
          [
            "members.manage",
            "roles.manage",
            "access.manage",
            "security.manage",
            "integrations.manage",
            "org.manage",
          ].includes(x),
        );
        if (pol.mfa === "all" || (pol.mfa === "admins" && admin))
          return send(c.res, 400, {
            error: "Your organisation requires two-factor authentication for your role.",
          });
        auth.disableMfa(p.user.id);
        act(c, "auth.mfa_disabled");
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/sessions\/revoke-others$/,
      perm: "session",
      noToken: true,
      handler: (c) => {
        const p = c.p as Principal;
        const n = auth.revokeOtherSessions(p.user.id, p.session.id_hash);
        act(c, "auth.sessions_revoked", undefined, { count: n });
        return send(c.res, 200, { revoked: n });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/sessions\/([a-f0-9]{16})\/revoke$/,
      perm: "session",
      noToken: true,
      handler: (c) => {
        const p = c.p as Principal;
        if (!auth.revokeSession(p.user.id, c.m[1] as string))
          return send(c.res, 404, { error: "no such session" });
        act(c, "auth.session_revoked");
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/tokens$/,
      perm: "session",
      stepUp: true,
      noToken: true,
      handler: async (c) => {
        const b = await body(c);
        try {
          const t = auth.createApiToken(
            c.p as Principal,
            String(b.name ?? ""),
            Number(b.days ?? 30),
            Array.isArray(b.scopes) ? b.scopes.map(String) : [],
          );
          act(c, "token.created", t.id, {
            name: String(b.name ?? "").slice(0, 60),
            scopes: b.scopes,
          });
          return send(c.res, 200, t);
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/me\/tokens\/(tok_[\w-]+)\/revoke$/,
      perm: "session",
      noToken: true,
      handler: (c) => {
        if (!auth.revokeApiToken(c.p?.user.id ?? "", c.m[1] as string))
          return send(c.res, 404, { error: "no such token" });
        act(c, "token.revoked", c.m[1]);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      path: /^\/api\/org\/security$/,
      perm: "security.manage",
      handler: (c) => send(c.res, 200, auth.settings(c.p?.user.org_id ?? "")),
    },
    {
      method: "POST",
      path: /^\/api\/org\/security$/,
      perm: "security.manage",
      stepUp: true,
      handler: async (c) => {
        const orgId = c.p?.user.org_id ?? "";
        const before = auth.settings(orgId);
        const after = auth.saveSettings(orgId, (await body(c)) as Record<string, never>);
        act(c, "security.policy_changed", undefined, { before, after });
        return send(c.res, 200, after);
      },
    },
    {
      method: "GET",
      path: /^\/api\/audit\/verify$/,
      perm: "audit.view",
      handler: (c) => send(c.res, 200, verifyAudit(db)),
    },

    // ── single sign-on ──
    {
      // Which SSO buttons the sign-in page shows (no secrets).
      method: "GET",
      path: /^\/auth\/sso$/,
      perm: "public",
      handler: (c) => {
        const orgId = firstOrg();
        if (!orgId) return send(c.res, 200, { oidc: null, saml: null, enforce: false });
        const s = sso.config(orgId);
        return send(c.res, 200, {
          oidc: s.oidc.enabled ? { label: s.oidc.label } : null,
          saml: s.saml.enabled ? { label: s.saml.label } : null,
          enforce: s.enforce,
        });
      },
    },
    {
      method: "GET",
      path: /^\/auth\/(oidc|saml)\/start$/,
      perm: "public",
      handler: async (c) => {
        const orgId = firstOrg();
        if (!orgId) return redirect(c.res, "/");
        try {
          const url =
            c.m[1] === "oidc"
              ? await sso.oidcStart(orgId, origin(c))
              : await sso.samlStart(orgId, origin(c));
          return redirect(c.res, url);
        } catch (e) {
          return redirect(
            c.res,
            `/?sso_error=${encodeURIComponent(e instanceof AuthError ? e.message : "Single sign-on is unavailable.")}#/`,
          );
        }
      },
    },
    {
      method: "GET",
      path: /^\/auth\/oidc\/callback$/,
      perm: "public",
      handler: async (c) => {
        try {
          const err = c.url.searchParams.get("error");
          if (err)
            throw new AuthError(
              400,
              `Your identity provider refused the sign-in (${err.slice(0, 60)}).`,
            );
          const { orgId, identity } = await sso.oidcCallback(
            c.url.searchParams.get("code") ?? "",
            c.url.searchParams.get("state") ?? "",
            origin(c),
          );
          return ssoSignIn(c, orgId, identity);
        } catch (e) {
          return redirect(
            c.res,
            `/?sso_error=${encodeURIComponent(e instanceof AuthError ? e.message : "Single sign-on failed.")}#/`,
          );
        }
      },
    },
    {
      // The identity provider posts the signed SAML response here from its own site.
      method: "POST",
      path: /^\/auth\/saml\/acs$/,
      perm: "public",
      crossSite: true,
      handler: async (c) => {
        const orgId = firstOrg();
        try {
          if (!orgId) throw new AuthError(400, "Not set up.");
          const form = await readForm(c.req);
          const identity = await sso.samlCallback(orgId, origin(c), form.get("SAMLResponse") ?? "");
          return ssoSignIn(c, orgId, identity);
        } catch (e) {
          return redirect(
            c.res,
            `/?sso_error=${encodeURIComponent(e instanceof AuthError ? e.message : "Single sign-on failed.")}#/`,
          );
        }
      },
    },
    {
      method: "GET",
      path: /^\/auth\/saml\/metadata$/,
      perm: "public",
      handler: (c) =>
        send(
          c.res,
          200,
          sso.samlMetadata(origin(c)),
          "application/samlmetadata+xml; charset=utf-8",
        ),
    },
    {
      method: "GET",
      path: /^\/api\/sso$/,
      perm: "security.manage",
      handler: (c) => {
        const orgId = c.p?.user.org_id ?? "";
        const secret = integrations.list(orgId).find((x) => x.name === "OIDC_CLIENT_SECRET");
        return send(c.res, 200, {
          config: sso.config(orgId),
          clientSecret: secret ? { last4: secret.last4 } : null,
          sp: {
            oidcRedirect: `${origin(c)}/auth/oidc/callback`,
            samlAcs: `${origin(c)}/auth/saml/acs`,
            samlEntityId: `${origin(c)}/auth/saml/metadata`,
            samlMetadata: `${origin(c)}/auth/saml/metadata`,
          },
          roles: org.roles(orgId).map(({ id, name, permissions }) => ({
            id,
            name,
            owner: permissions.includes("org.manage"),
          })),
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/sso$/,
      perm: "security.manage",
      stepUp: true,
      handler: async (c) => {
        const orgId = c.p?.user.org_id ?? "";
        const b = (await body(c)) as { config?: SsoConfig; clientSecret?: string };
        try {
          if (b.clientSecret?.trim())
            integrations.set(orgId, "OIDC_CLIENT_SECRET", b.clientSecret, c.p?.user.id ?? "");
          if (!b.config) throw new AuthError(400, "Missing settings.");
          const before = sso.config(orgId);
          const after = sso.save(orgId, b.config, org.roles(orgId));
          act(c, "security.sso_changed", undefined, {
            oidc: after.oidc.enabled,
            saml: after.saml.enabled,
            enforce: after.enforce,
            jit: after.jit,
            enforceBefore: before.enforce,
          });
          return send(c.res, 200, after);
        } catch (e) {
          return authErr(c, e);
        }
      },
    },

    // ── invitations (public: the link is the credential) ──
    {
      method: "GET",
      path: /^\/auth\/invite$/,
      perm: "public",
      handler: (c) => {
        const info = org.inviteInfo(c.url.searchParams.get("token") ?? "");
        return info
          ? send(c.res, 200, {
              email: info.email,
              org: info.org,
              sso: sso.config(firstOrg() ?? "").enforce,
            })
          : send(c.res, 404, {
              error: "This invitation is invalid or has expired. Ask for a new one.",
            });
      },
    },
    {
      method: "POST",
      path: /^\/auth\/invite$/,
      perm: "public",
      handler: async (c) => {
        const b = await body(c);
        const info = org.inviteInfo(String(b.token ?? ""));
        if (!info)
          return send(c.res, 404, {
            error: "This invitation is invalid or has expired. Ask for a new one.",
          });
        if (sso.config(firstOrg() ?? "").enforce)
          return send(c.res, 400, {
            error: "Your organisation signs in with single sign-on. Use the SSO button to join.",
            sso: true,
          });
        try {
          const user = await auth.acceptInvite(
            info.id,
            String(b.name ?? ""),
            String(b.password ?? ""),
            c.ip,
          );
          org.removeInvite(user.id);
          return signIn(c, user);
        } catch (e) {
          return authErr(c, e);
        }
      },
    },

    {
      method: "GET",
      path: /^\/auth\/reset$/,
      perm: "public",
      handler: (c) => {
        const info = org.resetInfo(c.url.searchParams.get("token") ?? "");
        return info
          ? send(c.res, 200, { email: info.email, org: info.org, mfa: !!info.mfa_enabled })
          : send(c.res, 404, { error: "This link is invalid or has expired. Ask for a new one." });
      },
    },
    {
      method: "POST",
      path: /^\/auth\/reset$/,
      perm: "public",
      handler: async (c) => {
        const b = await body(c);
        const info = org.resetInfo(String(b.token ?? ""));
        if (!info)
          return send(c.res, 404, {
            error: "This link is invalid or has expired. Ask for a new one.",
          });
        try {
          await auth.completeReset(info.id, String(b.password ?? ""), c.ip);
          // Not signed in: they sign in with the new password and their second factor.
          return send(c.res, 200, { ok: true });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },

    // ── integrations: GitHub and model keys ──
    {
      method: "GET",
      path: /^\/api\/integrations$/,
      perm: "integrations.manage",
      handler: async (c) => {
        const orgId = c.p?.user.org_id ?? "";
        const stored = new Map(integrations.list(orgId).map((x) => [x.name, x]));
        const app = integrations.app(orgId);
        let installations: Awaited<ReturnType<Integrations["installations"]>> = [];
        let githubError: string | null = null;
        if (app)
          installations = await integrations.installations(orgId).catch((e: Error) => {
            githubError = e.message;
            return [];
          });
        const env = orgEnv(orgId, await environment());
        const tokenRow = stored.get("GITHUB_TOKEN");
        return send(c.res, 200, {
          github: {
            app: app
              ? { name: app.name, slug: app.slug, owner: app.owner, html_url: app.html_url }
              : null,
            installations,
            installUrl: app ? integrations.installUrl(orgId, c.p?.user.id ?? "") : null,
            token: tokenRow
              ? {
                  last4: tokenRow.last4,
                  updated_at: tokenRow.updated_at,
                  login: auth.extra(orgId).githubLogin ?? null,
                }
              : null,
            error: githubError,
          },
          models: KEY_PROVIDERS.map((p) => ({
            id: p.id,
            label: p.label,
            hint: p.hint,
            last4: stored.get(p.env)?.last4 ?? null,
            updated_at: stored.get(p.env)?.updated_at ?? null,
          })),
          detected: env.providers
            .filter((p) => p.id === "claude-code" || p.id === "codex")
            .map((p) => ({ id: p.id, label: p.label, ok: p.ok, detail: p.detail })),
          defaultProvider: env.defaultProvider,
          docker: env.docker,
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/integrations\/keys$/,
      perm: "integrations.manage",
      stepUp: true,
      handler: async (c) => {
        const b = await body(c);
        const p = KEY_PROVIDERS.find((x) => x.id === String(b.provider ?? ""));
        const key = String(b.key ?? "").trim();
        if (!p || !key) return send(c.res, 400, { error: "Pick a provider and paste its key." });
        const v = await integrations.verifyKey(p.id, key);
        if (!v.ok) return send(c.res, 400, { error: v.detail });
        integrations.set(c.p?.user.org_id ?? "", p.env, key, c.p?.user.id ?? "");
        act(c, "integration.key_saved", p.label);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/integrations\/keys\/([\w-]+)\/remove$/,
      perm: "integrations.manage",
      stepUp: true,
      handler: (c) => {
        const p = KEY_PROVIDERS.find((x) => x.id === c.m[1]);
        if (!p) return send(c.res, 404, { error: "No such provider." });
        integrations.remove(c.p?.user.org_id ?? "", p.env);
        act(c, "integration.key_removed", p.label);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/integrations\/default$/,
      perm: "integrations.manage",
      handler: async (c) => {
        const provider = String((await body(c)).provider ?? "");
        if (!/^[\w-]{2,30}$/.test(provider))
          return send(c.res, 400, { error: "Unknown provider." });
        auth.setExtra(c.p?.user.org_id ?? "", { defaultProvider: provider });
        act(c, "integration.default_model", provider);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/integrations\/github\/token$/,
      perm: "integrations.manage",
      stepUp: true,
      handler: async (c) => {
        const token = String((await body(c)).token ?? "").trim();
        if (!/^(gh[pousr]_|github_pat_)\w{20,}$/.test(token))
          return send(c.res, 400, {
            error: "That does not look like a GitHub token (ghp_… or github_pat_…).",
          });
        try {
          const u = await integrations.verifyGithubToken(token);
          const orgId = c.p?.user.org_id ?? "";
          integrations.set(orgId, "GITHUB_TOKEN", token, c.p?.user.id ?? "");
          auth.setExtra(orgId, { githubLogin: u.login });
          act(c, "integration.github_token_saved", u.login);
          return send(c.res, 200, { login: u.login });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/integrations\/github\/(token|app)\/remove$/,
      perm: "integrations.manage",
      stepUp: true,
      handler: (c) => {
        integrations.remove(
          c.p?.user.org_id ?? "",
          c.m[1] === "token" ? "GITHUB_TOKEN" : "GITHUB_APP",
        );
        act(
          c,
          c.m[1] === "token"
            ? "integration.github_token_removed"
            : "integration.github_app_removed",
        );
        return send(c.res, 200, { ok: true });
      },
    },
    {
      // Start creating the organisation's own GitHub App: the page posts this manifest to GitHub.
      method: "POST",
      path: /^\/api\/integrations\/github\/app$/,
      perm: "integrations.manage",
      stepUp: true,
      handler: async (c) => {
        const b = await body(c);
        try {
          return send(
            c.res,
            200,
            integrations.appManifest(
              c.p?.user.org_id ?? "",
              c.p?.user.id ?? "",
              origin(c),
              String(b.name ?? ""),
              String(b.owner ?? "").trim(),
            ),
          );
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      // GitHub returns here after creating the app. No session cookie arrives on this
      // cross-site redirect (SameSite=Strict), so the single-use state proves who started it.
      method: "GET",
      path: /^\/auth\/github\/app-created$/,
      perm: "public",
      handler: async (c) => {
        const st = integrations.takeState(c.url.searchParams.get("state") ?? "", "create");
        if (!st) return redirect(c.res, "/#/org/integrations?github=expired");
        try {
          const app = await integrations.completeApp(
            st.orgId,
            st.userId,
            c.url.searchParams.get("code") ?? "",
          );
          audit(db, {
            orgId: st.orgId,
            actorId: st.userId,
            actor: auth.user(st.userId)?.email ?? "",
            action: "integration.github_app_created",
            target: app.slug,
            ip: c.ip,
          });
          // Next: install it on the repositories Bumpsmith should work on.
          return redirect(
            c.res,
            integrations.installUrl(st.orgId, st.userId) ?? "/#/org/integrations",
          );
        } catch {
          return redirect(c.res, "/#/org/integrations?github=failed");
        }
      },
    },
    {
      method: "GET",
      path: /^\/auth\/github\/installed$/,
      perm: "public",
      handler: (c) => {
        const st = integrations.takeState(c.url.searchParams.get("state") ?? "", "install");
        if (st)
          audit(db, {
            orgId: st.orgId,
            actorId: st.userId,
            actor: auth.user(st.userId)?.email ?? "",
            action: "integration.github_app_installed",
            target: c.url.searchParams.get("installation_id"),
            ip: c.ip,
          });
        return redirect(c.res, `/#/onboarding?github=${st ? "installed" : "check"}`);
      },
    },
    {
      method: "GET",
      path: /^\/api\/integrations\/github\/repos$/,
      perm: "workspaces.manage",
      handler: async (c) => {
        const orgId = c.p?.user.org_id ?? "";
        try {
          const repos = await integrations.repos(orgId);
          return send(c.res, 200, {
            repos: repos.map((r) => ({ ...r, added: !!org.workspaceByRepo(orgId, r.full_name) })),
          });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/workspaces\/github$/,
      perm: "workspaces.manage",
      stepUp: true,
      handler: async (c) => {
        const p = c.p as Principal;
        const repo = String((await body(c)).repo ?? "");
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
          return send(c.res, 400, { error: "Pick a repository." });
        const existing = org.workspaceByRepo(p.user.org_id, repo);
        if (existing) return send(c.res, 200, { slug: existing.slug });
        const dir = join(dataDir, "workspaces", `${p.user.org_id}-${repo.replace("/", "--")}`);
        try {
          await integrations.clone(p.user.org_id, repo, join(dir, "repo"));
          const w = org.ensureGithub(
            p.user.org_id,
            repo,
            join(dir, "repo"),
            join(dir, "runs"),
            p.user.id,
          );
          act(c, "workspace.added", w.slug, { github: repo });
          return send(c.res, 200, { slug: w.slug });
        } catch (e) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          return authErr(c, e);
        }
      },
    },

    // ── onboarding ──
    {
      method: "GET",
      path: /^\/api\/onboarding$/,
      perm: "session",
      handler: async (c) => {
        const p = c.p as Principal;
        const orgId = p.user.org_id;
        const env = orgEnv(orgId, await environment());
        const stored = new Set(integrations.list(orgId).map((x) => x.name));
        return send(c.res, 200, {
          done: !!auth.extra(orgId).onboardingDone,
          steps: {
            account: true,
            mfa: !!p.user.mfa_enabled,
            github: stored.has("GITHUB_APP") || stored.has("GITHUB_TOKEN"),
            model: env.providers.some((x) => x.ok),
            sandbox: !!env.docker,
            repository: org.workspaces(orgId).length > 0,
            team: org.members(orgId).length > 1,
          },
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/onboarding\/done$/,
      perm: "integrations.manage",
      handler: (c) => {
        auth.setExtra(c.p?.user.org_id ?? "", { onboardingDone: true });
        act(c, "org.onboarding_finished");
        return send(c.res, 200, { ok: true });
      },
    },

    // ── repositories ──
    {
      method: "GET",
      path: /^\/api\/workspaces$/,
      perm: "session",
      handler: async (c) => {
        const p = c.p as Principal;
        const list = org.visible(p);
        return send(c.res, 200, {
          workspaces: await Promise.all(
            list.map(async ({ w, e }) => ({
              slug: w.slug,
              name: w.name,
              kind: w.kind,
              visibility: w.visibility,
              path: p.permissions.includes("workspaces.manage") ? w.path : null,
              branch:
                w.kind === "local"
                  ? await git(w.path, ["rev-parse", "--abbrev-ref", "HEAD"])
                  : null,
              runs: (await readdir(w.runs_dir).catch(() => [])).filter((d) => ID.test(d)).length,
              permissions: e.permissions,
            })),
          ),
          canAdd: p.permissions.includes("workspaces.manage"),
          localFolders: mode === "local",
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/workspaces$/,
      perm: "workspaces.manage",
      stepUp: true,
      handler: async (c) => {
        // A shared server must not let users point it at arbitrary folders on its disk.
        if (mode !== "local")
          return send(c.res, 403, { error: "Add repositories from GitHub on a shared server." });
        try {
          const w = org.addLocal(
            { p: c.p as Principal, ip: c.ip },
            String((await body(c)).path ?? ""),
          );
          return send(c.res, 200, { slug: w.slug });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/workspaces\/([a-z0-9-]+)\/remove$/,
      perm: "workspaces.manage",
      stepUp: true,
      handler: (c) => {
        try {
          org.removeWorkspace({ p: c.p as Principal, ip: c.ip }, c.m[1] as string);
          return send(c.res, 200, { ok: true });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },

    // ── members, roles and access ──
    {
      method: "GET",
      path: /^\/api\/members$/,
      perm: "members.view",
      handler: (c) => {
        const p = c.p as Principal;
        return send(c.res, 200, {
          members: org.members(p.user.org_id),
          roles: org
            .roles(p.user.org_id)
            .map(({ id, name, permissions, builtin }) => ({ id, name, permissions, builtin })),
          me: p.user.id,
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/members\/invite$/,
      perm: "members.manage",
      stepUp: true,
      handler: async (c) => {
        const b = await body(c);
        try {
          const r = org.invite(
            { p: c.p as Principal, ip: c.ip },
            String(b.email ?? ""),
            String(b.roleId ?? ""),
          );
          return send(c.res, 200, { userId: r.userId, link: `${origin(c)}/#/invite/${r.token}` });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/members\/(usr_[\w-]+)\/(role|deactivate|reactivate|reset-mfa|reset-password|sign-out|resend-invite)$/,
      perm: "members.manage",
      stepUp: true,
      handler: async (c) => {
        const a = { p: c.p as Principal, ip: c.ip };
        const id = c.m[1] as string;
        try {
          switch (c.m[2]) {
            case "role":
              org.setRole(a, id, String((await body(c)).roleId ?? ""));
              break;
            case "deactivate":
              org.setActive(a, id, false);
              break;
            case "reactivate":
              org.setActive(a, id, true);
              break;
            case "reset-mfa":
              org.resetMfa(a, id);
              break;
            case "sign-out":
              org.signOutEverywhere(a, id);
              break;
            case "resend-invite":
              return send(c.res, 200, { link: `${origin(c)}/#/invite/${org.resendInvite(a, id)}` });
            case "reset-password":
              return send(c.res, 200, {
                link: `${origin(c)}/#/reset/${org.passwordResetLink(a, id)}`,
              });
          }
          return send(c.res, 200, { ok: true });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "GET",
      path: /^\/api\/roles$/,
      perm: "members.view",
      handler: (c) =>
        send(c.res, 200, {
          roles: org.roles(c.p?.user.org_id ?? ""),
          catalogue: PERMISSIONS,
          workspacePermissions: WS_PERMS,
          mine: c.p?.permissions,
        }),
    },
    {
      method: "POST",
      path: /^\/api\/roles$/,
      perm: "roles.manage",
      stepUp: true,
      handler: async (c) => {
        const b = await body(c);
        try {
          const id = org.createRole(
            { p: c.p as Principal, ip: c.ip },
            String(b.name ?? ""),
            String(b.description ?? ""),
            Array.isArray(b.permissions) ? b.permissions.map(String) : [],
          );
          return send(c.res, 200, { id });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "POST",
      path: /^\/api\/roles\/([\w:-]+)\/(update|delete)$/,
      perm: "roles.manage",
      stepUp: true,
      handler: async (c) => {
        const a = { p: c.p as Principal, ip: c.ip };
        try {
          if (c.m[2] === "delete") org.deleteRole(a, c.m[1] as string);
          else {
            const b = await body(c);
            org.updateRole(
              a,
              c.m[1] as string,
              String(b.name ?? ""),
              String(b.description ?? ""),
              Array.isArray(b.permissions) ? b.permissions.map(String) : [],
            );
          }
          return send(c.res, 200, { ok: true });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "GET",
      path: /^\/api\/access$/,
      perm: "access.manage",
      handler: (c) => {
        const orgId = c.p?.user.org_id ?? "";
        return send(c.res, 200, {
          workspaces: org
            .workspaces(orgId)
            .map(({ slug, name, visibility }) => ({ slug, name, visibility })),
          roles: org
            .roles(orgId)
            .map(({ id, name, permissions, builtin }) => ({ id, name, permissions, builtin })),
          members: org
            .members(orgId)
            .filter((m) => m.status !== "disabled")
            .map(({ id, name, email, role_id, status }) => ({ id, name, email, role_id, status })),
          grants: org.grants(orgId).map(({ slug, principal_type, principal_id, role_id }) => ({
            workspace: slug,
            principalType: principal_type,
            principalId: principal_id,
            roleId: role_id,
          })),
          mine: c.p?.permissions,
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/access\/(grant|visibility)$/,
      perm: "access.manage",
      stepUp: true,
      handler: async (c) => {
        const a = { p: c.p as Principal, ip: c.ip };
        const b = await body(c);
        try {
          if (c.m[1] === "visibility")
            org.setVisibility(a, String(b.workspace ?? ""), String(b.visibility ?? ""));
          else
            org.setGrant(
              a,
              String(b.workspace ?? ""),
              String(b.principalType ?? ""),
              String(b.principalId ?? ""),
              b.roleId ? String(b.roleId) : null,
            );
          return send(c.res, 200, { ok: true });
        } catch (e) {
          return authErr(c, e);
        }
      },
    },
    {
      method: "GET",
      path: /^\/api\/access\/check$/,
      perm: "access.manage",
      handler: (c) => {
        const orgId = c.p?.user.org_id ?? "";
        const target = org.members(orgId).find((m) => m.id === c.url.searchParams.get("user"));
        if (!target) return send(c.res, 404, { error: "No such member." });
        const role = org.role(orgId, target.role_id);
        const perms = role?.permissions ?? [];
        return send(c.res, 200, {
          user: {
            id: target.id,
            name: target.name,
            email: target.email,
            role: role?.name,
            status: target.status,
          },
          organisation: perms.filter((x) => !WS_PERMS.includes(x)),
          repositories: org.workspaces(orgId).map((w) => ({
            workspace: w.slug,
            name: w.name,
            visibility: w.visibility,
            ...org.effective(target, perms, w),
          })),
        });
      },
    },

    // ── audit log ──
    {
      method: "GET",
      path: /^\/api\/audit$/,
      perm: "audit.view",
      handler: (c) => {
        const q = c.url.searchParams;
        const rows = auditRows(
          c.p?.user.org_id ?? "",
          q.get("q") ?? "",
          q.get("cat") ?? "",
          Number(q.get("before") ?? 0),
          Math.min(200, Number(q.get("limit") ?? 100)),
        );
        return send(c.res, 200, { rows, chain: verifyAudit(db) });
      },
    },
    {
      method: "GET",
      path: /^\/api\/audit\/export$/,
      perm: "audit.view",
      handler: (c) => {
        const rows = auditRows(c.p?.user.org_id ?? "", "", "", 0, 100_000);
        // Quoted, and a leading = + - @ (or tab/CR) is defused so spreadsheets never run it as a formula.
        const cell = (v: unknown) =>
          `"${String(v ?? "")
            .replace(/^[=+\-@\t\r]/, "'$&")
            .replace(/"/g, '""')}"`;
        const csv = [
          "seq,time,actor,action,target,ip,detail,hash",
          ...rows.map((r) =>
            [r.seq, r.at, r.actor, r.action, r.target, r.ip, r.detail, r.hash].map(cell).join(","),
          ),
        ].join("\n");
        act(c, "audit.exported", undefined, { rows: rows.length });
        return send(c.res, 200, csv, "text/csv; charset=utf-8", {
          "content-disposition": `attachment; filename="bumpsmith-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
        });
      },
    },

    // ── the repository and its runs ──
    {
      method: "GET",
      path: /^\/api\/w\/([a-z0-9-]+)\/state$/,
      ws: true,
      perm: "runs.view",
      handler: async (c) => {
        const W = c.w as Workspace;
        const debtFile = join(W.path, ".bumpsmith", "debt.json");
        const [inv, repo, env, runs] = await Promise.all([
          inventory(W.path).catch(() => null), // not a supported repository: still show runs
          repoInfo(W.path),
          environment(),
          listRuns(W.runs_dir),
        ]);
        return send(c.res, 200, {
          repo: {
            ...repo,
            ecosystem: inv?.ecosystem ?? null,
            packageManager: inv?.packageManager ?? null,
            dependencies: inv?.dependencies ?? {},
          },
          env: orgEnv(W.org_id, env),
          runsDir: W.runs_dir,
          runs,
          debt: existsSync(debtFile) ? JSON.parse(await readFile(debtFile, "utf8")) : null,
          live: [...live.values()].filter((l) => l.ws === W.id).map(({ listeners: _l, ...r }) => r),
          workspace: { slug: W.slug, name: W.name, kind: W.kind, visibility: W.visibility },
          perms: c.wsPerms,
        });
      },
    },
    {
      // One file from a run's before/ or after/ snapshot (diff "expand context").
      method: "GET",
      path: /^\/api\/w\/([a-z0-9-]+)\/runs\/([\w.-]+)\/file$/,
      ws: true,
      perm: "runs.view",
      handler: async (c) => {
        const W = c.w as Workspace;
        const id = c.m[2] as string;
        if (!ID.test(id)) return send(c.res, 400, { error: "bad run id" });
        const side = c.url.searchParams.get("side") === "before" ? "before" : "after";
        const rel = c.url.searchParams.get("path") ?? "";
        const base = join(W.runs_dir, id, side);
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
      path: /^\/api\/w\/([a-z0-9-]+)\/runs\/([\w.-]+)$/,
      ws: true,
      perm: "runs.view",
      handler: async (c) => {
        const W = c.w as Workspace;
        const dir = runDir(W, c.m[2] as string);
        if (!dir) return send(c.res, 404, { error: "no such run" });
        const r = await readRun(W.runs_dir, c.m[2] as string);
        return send(c.res, 200, { ...r, summary: summarise(r.job, r.patch) });
      },
    },
    {
      method: "POST",
      path: /^\/api\/w\/([a-z0-9-]+)\/runs\/([\w.-]+)\/apply$/,
      ws: true,
      perm: "runs.apply",
      stepUp: true,
      handler: async (c) => {
        const W = c.w as Workspace;
        const dir = runDir(W, c.m[2] as string);
        if (!dir) return send(c.res, 404, { error: "no such run" });
        const patchFile = join(dir, "patch.diff");
        if (!(await stat(patchFile).catch(() => null))?.size)
          return send(c.res, 400, { error: "this run has no patch" });
        const check = await run("git", ["-C", W.path, "apply", "--check", "--index", patchFile]);
        if (check.exitCode !== 0)
          return send(c.res, 409, {
            error: `the patch does not apply to your working tree: ${(check.stderr || check.stdout).trim().slice(0, 400)}`,
          });
        await run("git", ["-C", W.path, "apply", "--index", patchFile]);
        act(c, "run.applied", c.m[2]);
        return send(c.res, 200, {
          ok: true,
          message: "Applied and staged. Review with git diff --cached.",
        });
      },
    },
    {
      method: "POST",
      path: /^\/api\/w\/([a-z0-9-]+)\/runs\/([\w.-]+)\/delete$/,
      ws: true,
      perm: "runs.delete",
      handler: async (c) => {
        const W = c.w as Workspace;
        const dir = runDir(W, c.m[2] as string);
        if (!dir) return send(c.res, 404, { error: "no such run" });
        await rm(dir, { recursive: true, force: true });
        act(c, "run.deleted", c.m[2]);
        return send(c.res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: /^\/api\/w\/([a-z0-9-]+)\/runs$/,
      ws: true,
      perm: "runs.start",
      handler: async (c) => {
        const W = c.w as Workspace;
        const b = await readBody(c.req);
        const pkg = String(b.package ?? "").trim();
        const version = String(b.version ?? "").trim();
        const provider = String(b.provider ?? "claude-code");
        const budget = Math.min(50, Math.max(0.5, Number(b.budget ?? 8)));
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg) || !/^\d[\w.+-]*$/.test(version))
          return send(c.res, 400, { error: "expected a package name and an exact version" });
        if (!/^[\w-]+$/.test(provider)) return send(c.res, 400, { error: "bad provider" });
        const lr = startRun(W, pkg, version, provider, budget);
        act(c, "run.started", `${pkg}@${version}`, { provider, budget });
        return send(c.res, 200, { id: lr.id });
      },
    },
    {
      method: "GET",
      path: /^\/api\/w\/([a-z0-9-]+)\/live\/([a-f0-9]{12})$/,
      ws: true,
      perm: "runs.view",
      handler: (c) => {
        const W = c.w as Workspace;
        const lr = live.get(c.m[2] as string);
        if (!lr || lr.ws !== W.id) return send(c.res, 404, { error: "no such live run" });
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
      path: /^\/api\/w\/([a-z0-9-]+)\/scan$/,
      ws: true,
      perm: "runs.start",
      handler: async (c) => {
        const W = c.w as Workspace;
        const child = cli(["scan", "--repo", W.path], W.path, W.org_id);
        let err = "";
        child.stderr.on("data", (d: Buffer) => (err += d.toString()));
        const code = await new Promise<number | null>((r) => child.on("close", r));
        const debtFile = join(W.path, ".bumpsmith", "debt.json");
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
      path: /^\/api\/w\/([a-z0-9-]+)\/latest$/,
      ws: true,
      perm: "runs.view",
      handler: async (c) => {
        const W = c.w as Workspace;
        const name = c.url.searchParams.get("name") ?? "";
        const eco = c.url.searchParams.get("ecosystem") === "pypi" ? "pypi" : "npm";
        if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return send(c.res, 400, { error: "bad name" });
        return send(c.res, 200, (await latestRelease(eco, name)) ?? { version: null });
      },
    },
  ];

  const runDir = (w: Workspace, id: string) => {
    if (!ID.test(id)) return null;
    const dir = join(w.runs_dir, id);
    return dir.startsWith(w.runs_dir + sep) && existsSync(join(dir, "job.json")) ? dir : null;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // Liveness for load balancers and container health checks: no data, any Host.
      if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true });
      // DNS rebinding and Host-header injection: only this server's own address may be the Host.
      const host = req.headers.host ?? "";
      const hostOk = publicUrl
        ? host === publicUrl.host
        : host === `127.0.0.1:${port}` || host === `localhost:${port}`;
      if (!hostOk) return send(res, 421, { error: "wrong host" });
      const url = new URL(req.url ?? "/", `http://${host}`);
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/index.html"))
        return send(res, 200, html, MIME[".html"]);
      if (req.method === "GET" && path === "/app.js") return send(res, 200, appJs, MIME[".js"]);
      if (
        req.method === "GET" &&
        /^\/(app\.css|fonts\/[\w-]+\.woff2|brand\/[\w-]+\.svg|art\/[\w-]+\.png)$/.test(path)
      ) {
        const file = join(root, "dashboard", path);
        const body = await readFile(file).catch(() => null);
        return body
          ? send(res, 200, body, MIME[extname(file)])
          : send(res, 404, { error: "not found" });
      }

      // MCP for applications and agents (Streamable HTTP), authenticated by a personal API token.
      if (path === "/mcp") return await serveMcp(req, res, host);

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

      const ip = clientIp(req, trusted);
      let ctxW: Workspace | undefined;
      let ctxPerms: string[] = [];
      const token = readCookie(req.headers.cookie, cookieName(secure));
      const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const p = bearer
        ? auth.principalFromToken(bearer)
        : auth.principal(token, route.perm === "pending");

      // Anything that changes state must come from this origin (cross-site requests are
      // also blocked by SameSite=Strict cookies; this is defence in depth).
      if (req.method !== "GET") {
        const origin = req.headers.origin;
        if (
          !route.crossSite &&
          origin !== undefined &&
          origin !== (publicUrl ? publicUrl.origin : `http${secure ? "s" : ""}://${host}`)
        )
          return send(res, 403, { error: "cross-origin request refused" });
        if ((route.perm === "public" || route.perm === "pending") && auth.rateLimited(ip))
          return send(res, 429, { error: "Too many attempts. Wait a few minutes." });
      }
      if (route.perm === "pending") {
        if (!p?.session.mfa_pending) return send(res, 401, { error: "Sign in again." });
      } else if (route.perm !== "public") {
        if (!p) return send(res, 401, { error: "Your session has ended. Sign in again." });
        if (p.apiToken && (route.noToken || path.startsWith("/auth/")))
          return send(res, 403, { error: "API tokens cannot manage accounts." });
        if (req.method !== "GET" && !p.apiToken) {
          const csrf = String(req.headers["x-csrf-token"] ?? "");
          if (!safeEqual(csrf, p.session.csrf))
            return send(res, 403, { error: "missing or wrong CSRF token" });
        }
        if (p.mustEnrollMfa && !route.enroll && route.path.source !== "^\\/auth\\/logout$")
          return send(res, 403, {
            error: "Your organisation requires two-factor authentication. Set it up to continue.",
            mfaEnrollmentRequired: true,
          });
        if (route.ws) {
          const w = org.workspace(p.user.org_id, m[1] ?? "");
          const e = w ? org.effective(p.user, p.permissions, w) : null;
          // A repository you cannot see does not exist, as far as you can tell.
          if (!w || !e?.permissions.length) return send(res, 404, { error: "No such repository." });
          const scoped = p.apiToken
            ? e.permissions.filter((x) => p.permissions.includes(x))
            : e.permissions;
          if (route.perm !== "session" && !scoped.includes(route.perm))
            return send(res, 403, { error: "Your access to this repository does not allow this." });
          ctxW = w;
          ctxPerms = scoped;
        } else if (route.perm !== "session" && !can(p.permissions, route.perm))
          return send(res, 403, { error: "Your role does not allow this." });
        if (route.stepUp && !auth.fresh(p))
          return send(res, 403, { error: "Confirm it's you to continue.", reauth: true });
      }
      await route.handler({ req, res, url, m, p, ip, token, w: ctxW, wsPerms: ctxPerms });
    } catch (err) {
      if (!res.headersSent)
        return send(res, 500, { error: String((err as Error).message ?? err).slice(0, 300) });
    }
  };
  /**
   * `/mcp`: Bumpsmith's tools for applications and agents, over Streamable HTTP. Each request
   * carries a personal API token (Authorization: Bearer bs_pat_…); the token's scopes and the
   * access matrix decide which repositories and tools it can use. Runs it starts show up live in
   * the dashboard and in the audit log, like any other.
   */
  const serveMcp = async (req: http.IncomingMessage, res: http.ServerResponse, host: string) => {
    const deny = (code: number, message: string) => {
      res.writeHead(code, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...(code === 401
          ? { "www-authenticate": 'Bearer realm="bumpsmith", error="invalid_token"' }
          : {}),
      });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }));
    };
    const origin = req.headers.origin;
    if (origin && origin !== (publicUrl ? publicUrl.origin : `http${secure ? "s" : ""}://${host}`))
      return deny(403, "cross-origin request refused");
    const ip = clientIp(req, trusted);
    const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
    const p = bearer ? auth.principalFromToken(bearer) : null;
    if (!p) {
      if (auth.rateLimited(ip)) return deny(429, "Too many attempts. Wait a few minutes.");
      return deny(
        401,
        "Create a personal API token in Bumpsmith (Account → API tokens) and send it as Authorization: Bearer <token>.",
      );
    }
    const orgId = p.user.org_id;
    const env = orgEnv(orgId, await environment());
    const repoOf = (w: Workspace): McpRepo | null => {
      const e = org.effective(p.user, p.permissions, w);
      const scoped = p.apiToken
        ? e.permissions.filter((x) => p.permissions.includes(x))
        : e.permissions;
      if (!scoped.includes("runs.view")) return null;
      return {
        id: w.slug,
        name: w.name,
        path: w.path,
        runsDir: w.runs_dir,
        can: (perm) => scoped.includes(perm),
      };
    };
    const visible = () =>
      org
        .workspaces(orgId)
        .map((w) => ({ w, r: repoOf(w) }))
        .filter((x): x is { w: Workspace; r: McpRepo } => !!x.r);
    const mcpHost: McpHost = {
      mode: "server",
      repos: async () => visible().map((x) => x.r),
      repo: async (id) => {
        const all = visible();
        if (!id) {
          if (all.length === 1) return (all[0] as { r: McpRepo }).r;
          throw new Error("Name the repository: call list_repositories for the slugs.");
        }
        const hit = all.find((x) => x.r.id === id);
        if (!hit) throw new Error(`No repository "${id}" that you can access.`);
        return hit.r;
      },
      start: (repo, pkg, version, o) => {
        const w = visible().find((x) => x.r.id === repo.id)?.w as Workspace;
        const provider = o.provider ?? env.defaultProvider;
        const lr = startRun(w, pkg, version, provider, o.budget);
        audit(db, {
          orgId,
          actorId: p.user.id,
          actor: p.user.email,
          action: "run.started",
          target: `${pkg}@${version}`,
          ip,
          detail: { provider, budget: o.budget, via: "mcp" },
        });
        return lr;
      },
      live: (id) => {
        const lr = live.get(id);
        return lr && visible().some((x) => x.w.id === lr.ws) ? lr : undefined;
      },
      exec: (repo, args) =>
        new Promise((ok) => {
          const w = visible().find((x) => x.r.id === repo.id)?.w as Workspace;
          const child = cli(args, w.path, orgId);
          let out = "";
          child.stdout.on("data", (d: Buffer) => {
            out += d.toString("utf8");
          });
          child.stderr.on("data", (d: Buffer) => {
            out += d.toString("utf8");
          });
          const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
          child.on("close", (code) => {
            clearTimeout(timer);
            ok({ code: code ?? 1, out: out.replace(ANSI, "") });
          });
        }),
    };
    const mcp = createMcpServer(mcpHost, bumpsmithVersion());
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await transport.handleRequest(req, res);
  };

  const server = opts.tls
    ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key, minVersion: "TLSv1.2" }, handle)
    : http.createServer(handle);
  // Slow-client limits: a request must arrive within 30 s; idle keep-alives close after 5 s.
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  const bindHost = opts.host ?? "127.0.0.1";
  await new Promise<void>((ok, fail) => {
    const tryListen = (p: number, attempts: number) => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempts > 0) tryListen(p + 1, attempts - 1);
        else fail(e);
      });
      server.listen(p, bindHost, () => {
        port = p;
        ok();
      });
    };
    // A server's port is part of its configuration: fail rather than drift to another one.
    tryListen(port, mode === "local" && opts.port === undefined ? 20 : 0);
  });
  const url = publicUrl
    ? `${publicUrl.origin}/`
    : `http${opts.tls ? "s" : ""}://127.0.0.1:${port}/`;
  return {
    url,
    port,
    dataDir,
    mode,
    host: bindHost,
    /** Open once to create the owner account; null when the server is already set up. */
    setupUrl: setupToken ? `${url}#/setup/${setupToken}` : null,
    routes: routes.map((r) => ({
      method: r.method,
      path: String(r.path),
      perm: r.perm,
      stepUp: !!r.stepUp,
    })),
    close: () =>
      new Promise<void>((r) =>
        server.close(() => {
          db.close();
          r();
        }),
      ),
  };
}
