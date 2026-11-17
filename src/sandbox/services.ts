import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Databases and caches a repository's tests need, read from its CI workflow's
 * `services:` blocks (the same place GitHub Actions starts them). Only official images
 * of a short allowlist run, as sidecars that share the sandbox's network namespace:
 * tests reach them on localhost exactly as they do in CI, and they add no new route out.
 */

export type ServiceKind = "postgres" | "mysql" | "mariadb" | "redis" | "valkey" | "mongo";

export interface ServiceSpec {
  kind: ServiceKind;
  /** Official image with a plain version tag, e.g. "postgres:16" or "redis:7-alpine". */
  image: string;
  env: Record<string, string>;
}

export interface ServicePlan {
  services: ServiceSpec[];
  /** Literal (non-secret) env from the CI job, e.g. DATABASE_URL, for the checks. */
  env: Record<string, string>;
  /** Services named in CI that Bumpsmith does not run (with the reason). */
  skipped: string[];
}

const KINDS: Record<string, ServiceKind> = {
  postgres: "postgres",
  "postgis/postgis": "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  redis: "redis",
  "valkey/valkey": "valkey",
  mongo: "mongo",
};

/** Plain version tags only (no digests or registries): "16", "16.2-alpine", "latest". */
const TAG = /^[\w][\w.-]{0,40}$/;

/** Default credentials when CI sets none, matching the images' documented defaults. */
const DEFAULT_ENV: Record<ServiceKind, Record<string, string>> = {
  postgres: { POSTGRES_PASSWORD: "postgres", POSTGRES_HOST_AUTH_METHOD: "trust" },
  mysql: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes" },
  mariadb: { MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "yes" },
  redis: {},
  valkey: {},
  mongo: {},
};

/** Env values that come from secrets or expressions are never copied (unknown at runtime). */
const literal = (v: unknown): v is string | number | boolean =>
  (typeof v === "string" && !v.includes("${{")) || typeof v === "number" || typeof v === "boolean";

const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Never let CI env change how the sandbox resolves or trusts the network. */
const BLOCKED_ENV =
  /^(PATH|HOME|LD_\w+|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_\w+|REQUESTS_CA_BUNDLE|PIP_\w+|UV_\w+|NPM_CONFIG_\w+|YARN_\w+|HTTPS?_PROXY|NO_PROXY|PYTHONPATH|GIT_\w+)$/i;

function cleanEnv(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>))
    if (SAFE_ENV_NAME.test(k) && !BLOCKED_ENV.test(k) && literal(v)) out[k] = String(v);
  return out;
}

export function parseImage(image: string): { kind: ServiceKind; image: string } | null {
  const m = /^(?:docker\.io\/)?(?:library\/)?([a-z0-9/-]+)(?::([^@\s]+))?$/.exec(image.trim());
  if (!m?.[1]) return null;
  const kind = KINDS[m[1]];
  const tag = m[2] ?? "latest";
  if (!kind || !TAG.test(tag)) return null;
  return { kind, image: `${m[1]}:${tag}` };
}

/** Services and literal env from one workflow file's jobs. */
export function servicesFromWorkflow(text: string): ServicePlan {
  const plan: ServicePlan = { services: [], env: {}, skipped: [] };
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return plan;
  }
  const wf = (doc ?? {}) as { env?: unknown; jobs?: Record<string, unknown> };
  for (const job of Object.values(wf.jobs ?? {})) {
    const j = (job ?? {}) as { services?: Record<string, unknown>; env?: unknown; steps?: unknown };
    if (!j.services) continue;
    Object.assign(plan.env, cleanEnv(wf.env), cleanEnv(j.env));
    // Step-level env of test steps often holds DATABASE_URL.
    for (const step of Array.isArray(j.steps) ? j.steps : [])
      Object.assign(plan.env, cleanEnv((step as { env?: unknown })?.env));
    for (const [name, svc] of Object.entries(j.services)) {
      const s = (typeof svc === "string" ? { image: svc } : (svc ?? {})) as {
        image?: unknown;
        env?: unknown;
      };
      const parsed = typeof s.image === "string" ? parseImage(s.image) : null;
      if (!parsed) {
        plan.skipped.push(`${name} (${String(s.image ?? "no image")})`);
        continue;
      }
      if (plan.services.some((x) => x.kind === parsed.kind)) continue;
      plan.services.push({
        ...parsed,
        env: { ...DEFAULT_ENV[parsed.kind], ...cleanEnv(s.env) },
      });
    }
  }
  return plan;
}

/** All services the repository's CI starts for its tests. */
export async function detectServices(repoRoot: string): Promise<ServicePlan> {
  const plan: ServicePlan = { services: [], env: {}, skipped: [] };
  const dir = join(repoRoot, ".github", "workflows");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return plan;
  }
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(join(dir, f), "utf8");
    } catch {
      continue;
    }
    const p = servicesFromWorkflow(text);
    for (const s of p.services)
      if (!plan.services.some((x) => x.kind === s.kind)) plan.services.push(s);
    for (const [k, v] of Object.entries(p.env)) plan.env[k] ??= v;
    for (const s of p.skipped) if (!plan.skipped.includes(s)) plan.skipped.push(s);
  }
  plan.services = plan.services.slice(0, 4);
  return plan;
}

/** Command that exits 0 once the service accepts connections (run inside the sidecar). */
export function readinessProbe(kind: ServiceKind): string[] {
  switch (kind) {
    case "postgres":
      return ["pg_isready", "-h", "127.0.0.1"];
    case "mysql":
    case "mariadb":
      return [
        "sh",
        "-c",
        "mysqladmin ping -h 127.0.0.1 --silent 2>/dev/null || mariadb-admin ping -h 127.0.0.1 --silent",
      ];
    case "redis":
      return ["redis-cli", "ping"];
    case "valkey":
      return ["valkey-cli", "ping"];
    case "mongo":
      return [
        "sh",
        "-c",
        'mongosh --quiet --eval "db.runCommand({ ping: 1 })" || mongo --quiet --eval "db.runCommand({ ping: 1 })"',
      ];
  }
}

/** Where each kind keeps its data (a tmpfs: nothing persists, nothing touches the host). */
export const DATA_DIRS: Record<ServiceKind, string> = {
  postgres: "/var/lib/postgresql",
  mysql: "/var/lib/mysql",
  mariadb: "/var/lib/mysql",
  redis: "/data",
  valkey: "/data",
  mongo: "/data/db",
};
