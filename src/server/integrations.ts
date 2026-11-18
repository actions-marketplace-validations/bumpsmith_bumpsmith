// Model keys and the GitHub connection, kept encrypted in the database and handed only to
// the process that needs them (an upgrade run), never to the browser or the logs.
import { createSign } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { run } from "../util/proc.ts";
import { AuthError } from "./auth.ts";
import { decrypt, encrypt, newToken, sha256 } from "./crypto.ts";
import { type Db, now } from "./db.ts";

/** Providers configured with an API key. The env name is what the upgrade run reads. */
export const KEY_PROVIDERS = [
  {
    id: "anthropic-api",
    label: "Anthropic API",
    env: "ANTHROPIC_API_KEY",
    hint: "sk-ant-…",
    base: "",
  },
  {
    id: "openai",
    label: "OpenAI",
    env: "OPENAI_API_KEY",
    hint: "sk-…",
    base: "https://api.openai.com/v1",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    env: "GEMINI_API_KEY",
    hint: "AIza…",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    hint: "sk-or-…",
    base: "https://openrouter.ai/api/v1",
  },
  {
    id: "groq",
    label: "Groq",
    env: "GROQ_API_KEY",
    hint: "gsk_…",
    base: "https://api.groq.com/openai/v1",
  },
  {
    id: "together",
    label: "Together AI",
    env: "TOGETHER_API_KEY",
    hint: "",
    base: "https://api.together.xyz/v1",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
    hint: "sk-…",
    base: "https://api.deepseek.com/v1",
  },
] as const;

const SECRET_NAMES = new Set<string>([
  ...KEY_PROVIDERS.map((p) => p.env),
  "GITHUB_TOKEN",
  "GITHUB_APP",
]);

export interface GithubApp {
  id: number;
  slug: string;
  name: string;
  pem: string;
  webhook_secret: string | null;
  client_id: string;
  client_secret: string;
  html_url: string;
  owner: string;
}

const GH = "https://api.github.com";
const ghHeaders = (auth: string) => ({
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "bumpsmith-self-hosted",
  authorization: auth,
});

export class Integrations {
  /** One-time state values for the GitHub App flows, bound to the organisation. */
  private states = new Map<
    string,
    { orgId: string; userId: string; kind: "create" | "install"; expires: number }
  >();

  constructor(
    private db: Db,
    private key: Buffer,
  ) {}

  // ── encrypted secrets ──

  set(orgId: string, name: string, value: string, by: string) {
    if (!SECRET_NAMES.has(name)) throw new AuthError(400, "Unknown setting.");
    const v = value.trim();
    if (!v || v.length > 20_000) throw new AuthError(400, "Enter a value.");
    this.db
      .prepare(
        "INSERT INTO secrets (org_id, name, value, last4, updated_at, updated_by) VALUES (?,?,?,?,?,?) ON CONFLICT(org_id, name) DO UPDATE SET value = excluded.value, last4 = excluded.last4, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
      )
      .run(
        orgId,
        name,
        encrypt(this.key, v, `secret:${orgId}:${name}`),
        name === "GITHUB_APP" ? "" : v.slice(-4),
        now(),
        by,
      );
  }

  get(orgId: string, name: string): string | null {
    const r = this.db
      .prepare("SELECT value FROM secrets WHERE org_id = ? AND name = ?")
      .get(orgId, name) as { value: string } | undefined;
    return r ? decrypt(this.key, r.value, `secret:${orgId}:${name}`) : null;
  }

  remove(orgId: string, name: string) {
    return (
      Number(
        this.db.prepare("DELETE FROM secrets WHERE org_id = ? AND name = ?").run(orgId, name)
          .changes,
      ) > 0
    );
  }

  /** What is configured, without the values: name, last four characters, when, by whom. */
  list(orgId: string) {
    return this.db
      .prepare("SELECT name, last4, updated_at, updated_by FROM secrets WHERE org_id = ?")
      .all(orgId) as unknown as {
      name: string;
      last4: string;
      updated_at: string;
      updated_by: string | null;
    }[];
  }

  /** Environment for an upgrade run: the organisation's model keys (and nothing else). */
  runEnv(orgId: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const p of KEY_PROVIDERS) {
      const v = this.get(orgId, p.env);
      if (v) env[p.env] = v;
    }
    return env;
  }

  /** Check a model key against the provider before saving it. */
  async verifyKey(providerId: string, key: string): Promise<{ ok: boolean; detail: string }> {
    const p = KEY_PROVIDERS.find((x) => x.id === providerId);
    if (!p) return { ok: false, detail: "Unknown provider." };
    try {
      const r =
        p.id === "anthropic-api"
          ? await fetch("https://api.anthropic.com/v1/models?limit=1", {
              headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
              signal: AbortSignal.timeout(10_000),
            })
          : await fetch(`${p.base}/models`, {
              headers: { authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(10_000),
            });
      if (r.ok) return { ok: true, detail: "Key works." };
      if (r.status === 401 || r.status === 403)
        return { ok: false, detail: `${p.label} rejected this key.` };
      return { ok: false, detail: `${p.label} answered ${r.status}. Try again in a moment.` };
    } catch {
      return {
        ok: false,
        detail: `Could not reach ${p.label}. Check this server's internet connection.`,
      };
    }
  }

  // ── GitHub: personal access token ──

  async verifyGithubToken(token: string): Promise<{ login: string; scopes: string }> {
    try {
      const r = await fetch(`${GH}/user`, {
        headers: ghHeaders(`Bearer ${token}`),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 401) throw new AuthError(400, "GitHub rejected this token.");
      if (!r.ok) throw new AuthError(400, `GitHub answered ${r.status}.`);
      const u = (await r.json()) as { login: string };
      return { login: u.login, scopes: r.headers.get("x-oauth-scopes") ?? "fine-grained" };
    } catch (e) {
      if (e instanceof AuthError) throw e;
      throw new AuthError(502, "Could not reach GitHub. Check this server's internet connection.");
    }
  }

  // ── GitHub: the organisation's own GitHub App (manifest flow) ──

  private newState(orgId: string, userId: string, kind: "create" | "install") {
    const s = newToken();
    this.states.set(sha256(s), { orgId, userId, kind, expires: Date.now() + 15 * 60_000 });
    for (const [k, v] of this.states) if (v.expires < Date.now()) this.states.delete(k);
    return s;
  }

  /** Single use: the state is removed when it is checked. */
  takeState(s: string, kind: "create" | "install") {
    const h = sha256(s);
    const v = this.states.get(h);
    this.states.delete(h);
    return v && v.kind === kind && v.expires > Date.now() ? v : null;
  }

  /** The manifest GitHub uses to create the app, and where to post it. */
  appManifest(orgId: string, userId: string, origin: string, name: string, owner: string) {
    const clean = name.trim().slice(0, 34);
    if (!clean) throw new AuthError(400, "Give the GitHub App a name.");
    if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner))
      throw new AuthError(400, "That is not a GitHub organisation name.");
    const state = this.newState(orgId, userId, "create");
    const manifest = {
      name: clean,
      url: origin,
      redirect_url: `${origin}/auth/github/app-created`,
      setup_url: `${origin}/auth/github/installed`,
      setup_on_update: true,
      public: false,
      hook_attributes: { url: `${origin}/hooks/github`, active: false },
      // What Bumpsmith needs and nothing more (PRD GH-2/GH-3): no workflows, admin or secrets.
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        metadata: "read",
        checks: "read",
        statuses: "read",
      },
      default_events: [],
    };
    const action = owner
      ? `https://github.com/organizations/${owner}/settings/apps/new?state=${encodeURIComponent(state)}`
      : `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
    return { action, manifest };
  }

  /** GitHub sent us back a one-time code: exchange it for the app's credentials. */
  async completeApp(orgId: string, by: string, code: string): Promise<GithubApp> {
    if (!/^[\w-]{4,80}$/.test(code)) throw new AuthError(400, "Bad code from GitHub.");
    const r = await fetch(`${GH}/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: ghHeaders(""),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r?.ok)
      throw new AuthError(
        502,
        `GitHub did not confirm the app (${r?.status ?? "no answer"}). Try again.`,
      );
    const a = (await r.json()) as GithubApp & { owner: { login: string } };
    const app: GithubApp = {
      id: a.id,
      slug: a.slug,
      name: a.name,
      pem: a.pem,
      webhook_secret: a.webhook_secret,
      client_id: a.client_id,
      client_secret: a.client_secret,
      html_url: a.html_url,
      owner: a.owner?.login ?? "",
    };
    this.set(orgId, "GITHUB_APP", JSON.stringify(app), by);
    return app;
  }

  app(orgId: string): GithubApp | null {
    const v = this.get(orgId, "GITHUB_APP");
    return v ? (JSON.parse(v) as GithubApp) : null;
  }

  installUrl(orgId: string, userId: string): string | null {
    const app = this.app(orgId);
    return app
      ? `https://github.com/apps/${app.slug}/installations/new?state=${encodeURIComponent(this.newState(orgId, userId, "install"))}`
      : null;
  }

  /** A short-lived JWT that authenticates as the app itself (RS256, 9 minutes). */
  private appJwt(app: GithubApp): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const t = Math.floor(Date.now() / 1000);
    const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: t - 60, exp: t + 540, iss: String(app.id) })}`;
    return `${body}.${createSign("RSA-SHA256").update(body).sign(app.pem).toString("base64url")}`;
  }

  private async gh<T>(path: string, auth: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${GH}${path}`, {
      ...init,
      headers: { ...ghHeaders(auth), ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!r) throw new AuthError(502, "Could not reach GitHub.");
    if (!r.ok)
      throw new AuthError(
        r.status === 401 ? 400 : 502,
        `GitHub answered ${r.status} for ${path.split("?")[0]}.`,
      );
    return (await r.json()) as T;
  }

  async installations(orgId: string) {
    const app = this.app(orgId);
    if (!app) return [];
    return (
      await this.gh<
        { id: number; account: { login: string; type: string }; repository_selection: string }[]
      >("/app/installations", `Bearer ${this.appJwt(app)}`)
    ).map((i) => ({
      id: i.id,
      account: i.account.login,
      type: i.account.type,
      selection: i.repository_selection,
    }));
  }

  /**
   * A token for one job: an installation token narrowed to one repository (one hour), or the
   * personal token when that is how GitHub is connected.
   */
  async tokenFor(orgId: string, fullName: string): Promise<string | null> {
    const app = this.app(orgId);
    if (app) {
      const [owner, repo] = fullName.split("/");
      const inst = (await this.installations(orgId)).find(
        (i) => i.account.toLowerCase() === (owner ?? "").toLowerCase(),
      );
      if (inst) {
        const t = await this.gh<{ token: string }>(
          `/app/installations/${inst.id}/access_tokens`,
          `Bearer ${this.appJwt(app)}`,
          {
            method: "POST",
            body: JSON.stringify({ repositories: [repo] }),
          },
        );
        return t.token;
      }
    }
    return this.get(orgId, "GITHUB_TOKEN");
  }

  /** Repositories Bumpsmith can reach: through the app's installations, or the token. */
  async repos(orgId: string): Promise<
    {
      full_name: string;
      private: boolean;
      default_branch: string;
      description: string | null;
      pushed_at: string;
    }[]
  > {
    const pick = (r: {
      full_name: string;
      private: boolean;
      default_branch: string;
      description: string | null;
      pushed_at: string;
    }) => ({
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      description: r.description,
      pushed_at: r.pushed_at,
    });
    const app = this.app(orgId);
    if (app) {
      const out = [];
      for (const inst of await this.installations(orgId)) {
        const t = await this.gh<{ token: string }>(
          `/app/installations/${inst.id}/access_tokens`,
          `Bearer ${this.appJwt(app)}`,
          { method: "POST" },
        );
        const list = await this.gh<{ repositories: Parameters<typeof pick>[0][] }>(
          "/installation/repositories?per_page=100",
          `Bearer ${t.token}`,
        );
        out.push(...list.repositories.map(pick));
      }
      return out;
    }
    const token = this.get(orgId, "GITHUB_TOKEN");
    if (!token) return [];
    return (
      await this.gh<Parameters<typeof pick>[0][]>(
        "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
        `Bearer ${token}`,
      )
    ).map(pick);
  }

  /**
   * Clone without writing the token anywhere: it goes in a one-off HTTP header, so the
   * clone's .git/config holds only the plain https URL.
   */
  async clone(orgId: string, fullName: string, dest: string) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName))
      throw new AuthError(400, "Not a GitHub repository name.");
    const token = await this.tokenFor(orgId, fullName);
    if (!token) throw new AuthError(400, "Connect GitHub first.");
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const r = await run(
      "git",
      [
        "-c",
        `http.extraHeader=${header}`,
        "clone",
        "--filter=blob:none",
        "--quiet",
        `https://github.com/${fullName}.git`,
        dest,
      ],
      {
        timeoutMs: 10 * 60_000,
      },
    );
    if (r.exitCode !== 0)
      throw new AuthError(
        502,
        `git clone failed: ${(r.stderr || r.stdout)
          .replace(/AUTHORIZATION:[^\n]*/gi, "[redacted]")
          .trim()
          .slice(0, 300)}`,
      );
  }
}
