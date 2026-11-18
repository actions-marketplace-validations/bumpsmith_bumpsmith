import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageOf, startDashboard, summarise } from "../../src/dashboard/server.ts";
import type { JobRecord } from "../../src/pipeline.ts";
import { base32Decode, hotp } from "../../src/server/crypto.ts";
import { runOk } from "../../src/util/proc.ts";

const job = (over: Partial<JobRecord> = {}): JobRecord =>
  ({
    id: "20261118000000-abc123",
    created_at: "2026-11-18T00:00:00.000Z",
    finished_at: "2026-11-18T00:03:00.000Z",
    input: { repo: "/r", packageName: "zod", to: "4.1.0", ecosystem: "npm" },
    provider: "fake",
    model: "fake-model",
    prompt_versions: {},
    state: "ready",
    from: "3.23.8",
    rounds: [{ round: 1, stop: "completed", summary: "", checks: [] }],
    baseline: [
      {
        name: "install",
        command: "",
        exit_code: 0,
        passed: true,
        duration_ms: 1,
        timed_out: false,
        output_tail: "",
      },
      {
        name: "test",
        command: "",
        exit_code: 0,
        passed: true,
        duration_ms: 1,
        timed_out: false,
        output_tail: "",
      },
    ],
    verdict: {
      passed: true,
      comparisons: [
        { name: "install", baseline: true, after: true, flaky: false, regression: false },
        { name: "test", baseline: true, after: true, flaky: false, regression: false },
      ],
      regressions: [],
      preexistingFailures: [],
    },
    edits: [{ path: "src/a.ts", allowlisted: true, reason: null }],
    usage: [
      {
        role: "fixer",
        provider: "fake",
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        api_equivalent_usd: 0.5,
        duration_ms: 1,
      },
      {
        role: "reviewer",
        provider: "fake",
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        api_equivalent_usd: 0.1,
        duration_ms: 1,
      },
    ],
    cost_usd: 0.6,
    duration_ms: 180000,
    notes: [],
    ...over,
  }) as JobRecord;

const PATCH = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1 +1 @@
-{"dependencies":{"zod":"^3.23.8"}}
+{"dependencies":{"zod":"^4.1.0"}}
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-import { z } from "zod";
+import * as z from "zod";
 export const s = z.string();
`;

describe("dashboard data", () => {
  it("summarises a run: checks, agent lines, cost by role, reason", () => {
    const s = summarise(job(), PATCH);
    expect(s.files).toBe(2);
    expect(s.lines).toBe(4);
    expect(s.agent_lines).toBe(2);
    expect(s.cost_by_role).toEqual({ fixer: 0.5, reviewer: 0.1 });
    expect(s.checks.map((c) => `${c.name}:${c.before}:${c.after}`)).toEqual([
      "install:true:true",
      "test:true:true",
    ]);
    expect(s.reason).toBeNull();
    const blocked = summarise(
      job({
        state: "blocked_policy",
        rules: [
          {
            rule: "new_dependency",
            severity: "block",
            file: "package.json",
            detail: "adds left-pad",
          },
        ],
      }),
      "",
    );
    expect(blocked.reason).toBe("Safety rule new dependency in package.json: adds left-pad");
  });

  it("maps log lines to stages", () => {
    expect(stageOf("job x: preparing repository")).toBe("prepare");
    expect(stageOf("job x: building Change Record zod 3 -> 4")).toBe("analyse");
    expect(stageOf("job x: fixer round 2 (spent $0.40)")).toBe("fix");
    expect(stageOf("READY (confidence high, $0.62)")).toBe("done");
    expect(stageOf("something else")).toBeNull();
  });
});

// Password hashing is deliberately slow (scrypt), and these tests sign in several times.
describe("dashboard server", { timeout: 30_000 }, () => {
  let base = "";
  let port = 0;
  let close: () => Promise<void> = async () => {};
  let repo = "";
  let setupUrl = "";
  let routes: { method: string; path: string; perm: string; stepUp: boolean }[] = [];
  /** Headers of the signed-in owner: session cookie and CSRF token. */
  let h: Record<string, string> = {};
  const PASSWORD = "Tidal-Lantern-Quartz-42";
  let mfaSecret = "";
  let recovery: string[] = [];
  let dataDir = "";
  /** API prefix of the test repository, e.g. /api/w/bumpsmith-dash-abc123. */
  let W = "";
  let sam: Record<string, string> = {};
  /** A TOTP code for `offset` 30-second steps from now. */
  const code = (offset = 0) =>
    hotp(base32Decode(mfaSecret), Math.floor(Date.now() / 30_000) + offset);
  const staleSession = () => {
    const db = new DatabaseSync(join(dataDir, "bumpsmith.db"));
    db.prepare("UPDATE sessions SET auth_at = '2020-01-01T00:00:00.000Z'").run();
    db.close();
  };

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "bumpsmith-dash-"));
    await writeFile(join(repo, "package.json"), '{"dependencies":{"zod":"^3.23.8"}}\n');
    await runOk("git", ["-C", repo, "init", "-q"]);
    const runDir = join(repo, ".bumpsmith", "runs", "20261118000000-abc123");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "job.json"), JSON.stringify(job()));
    // This patch touches src/a.ts, which does not exist here: applying must fail cleanly.
    await writeFile(join(runDir, "patch.diff"), PATCH);
    // Full files kept for "expand context" in the diff view, plus a symlink that escapes.
    await mkdir(join(runDir, "after", "src"), { recursive: true });
    await writeFile(join(runDir, "after", "src", "a.ts"), "export const a = 1;\n");
    await writeFile(join(repo, "secret.txt"), "do not serve\n");
    await symlink(join(repo, "secret.txt"), join(runDir, "after", "escape.txt"));
    const d = await startDashboard({
      repoDir: repo,
      dataDir: join(repo, ".data"),
      port: 4600 + Math.floor(Math.random() * 300),
      cliEntry: "",
    });
    base = d.url.replace(/\/$/, "");
    port = d.port;
    close = d.close;
    setupUrl = d.setupUrl ?? "";
    routes = d.routes;
    dataDir = d.dataDir;
    W = `/api/w/${basename(repo)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)}`;
  });
  afterAll(() => close());

  const raw = (path: string, headers: Record<string, string>, method = "GET") =>
    new Promise<number>((ok) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.end();
    });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const signedIn = async (r: Response) => {
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { csrf } = (await r.json()) as { csrf: string };
    return { cookie, "x-csrf-token": csrf };
  };

  it("sets up the owner only with the one-time setup link", async () => {
    const token = /#\/setup\/(.+)$/.exec(setupUrl)?.[1] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(40);
    const s = await (await fetch(`${base}/auth/session`)).json();
    expect(s).toMatchObject({ setupRequired: true });
    const owner = {
      orgName: "Acme",
      name: "Dana Reyes",
      email: "dana@acme.dev",
      password: PASSWORD,
    };
    expect((await post("/auth/setup", { ...owner, token: "x".repeat(43) })).status).toBe(403);
    expect((await post("/auth/setup", { ...owner, token, password: "password1234" })).status).toBe(
      400,
    );
    const ok = await post("/auth/setup", { ...owner, token });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^bs_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Strict/);
    h = await signedIn(ok);
    expect((await post("/auth/setup", { ...owner, token })).status).toBe(409);
  });

  it("makes an admin set up two-factor authentication before anything else", async () => {
    const blocked = await fetch(`${base}${W}/state`, { headers: h });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ mfaEnrollmentRequired: true });
    const start = (await (await post("/api/me/mfa/start", {}, h)).json()) as {
      secret: string;
      qr: string;
    };
    expect(start.qr).toMatch(/^<svg/);
    mfaSecret = start.secret;
    expect((await post("/api/me/mfa/confirm", { code: "000000" }, h)).status).toBe(400);
    const done = await post("/api/me/mfa/confirm", { code: code() }, h);
    expect(done.status).toBe(200);
    recovery = ((await done.json()) as { recoveryCodes: string[] }).recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect((await fetch(`${base}${W}/state`, { headers: h })).status).toBe(200);
  });

  it("asks for the code at sign-in and refuses a replayed code", async () => {
    const pw = await post("/auth/login", { email: "dana@acme.dev", password: PASSWORD });
    expect(await pw.clone().json()).toEqual({ mfaRequired: true });
    const pending = (pw.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    // Half signed in: nothing works yet.
    expect((await fetch(`${base}${W}/state`, { headers: { cookie: pending } })).status).toBe(401);
    expect((await post("/auth/mfa", { code: "123456" }, { cookie: pending })).status).toBe(400);
    const c = code(1);
    const ok = await post("/auth/mfa", { code: c }, { cookie: pending });
    expect(ok.status).toBe(200);
    const fresh = await signedIn(ok);
    expect(fresh.cookie).not.toBe(pending); // rotated after the second factor
    // The same code cannot be used again.
    const again = await post("/auth/login", { email: "dana@acme.dev", password: PASSWORD });
    const pending2 = (again.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await post("/auth/mfa", { code: c }, { cookie: pending2 })).status).toBe(400);
    // A recovery code works once.
    expect((await post("/auth/mfa", { code: recovery[0] }, { cookie: pending2 })).status).toBe(200);
    const again2 = await post("/auth/login", { email: "dana@acme.dev", password: PASSWORD });
    const pending3 = (again2.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await post("/auth/mfa", { code: recovery[0] }, { cookie: pending3 })).status).toBe(400);
    h = fresh;
  });

  it("asks you to confirm it's you before sensitive actions", async () => {
    staleSession();
    const r = await post(`${W}/runs/20261118000000-abc123/apply`, {}, h);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ reauth: true });
    expect((await post("/api/me/reauth", { code: "000000" }, h)).status).toBe(400);
    expect((await post("/api/me/reauth", { code: recovery[1] }, h)).status).toBe(200);
    expect((await post(`${W}/runs/20261118000000-abc123/apply`, {}, h)).status).toBe(409); // got through to git
  });

  it("issues scoped API tokens that cannot change accounts or apply patches", async () => {
    expect(
      (await post("/api/me/tokens", { name: "CI", days: 30, scopes: ["runs.apply"] }, h)).status,
    ).toBe(400);
    const r = await post("/api/me/tokens", { name: "CI", days: 30, scopes: ["runs.view"] }, h);
    expect(r.status).toBe(200);
    const { token, id } = (await r.json()) as { token: string; id: string };
    expect(token).toMatch(/^bs_pat_/);
    const bearer = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}${W}/state`, { headers: bearer })).status).toBe(200);
    expect((await post(`${W}/runs/20261118000000-abc123/apply`, {}, bearer)).status).toBe(403);
    expect((await post(`${W}/runs`, { package: "zod", version: "4.1.0" }, bearer)).status).toBe(
      403,
    );
    expect((await fetch(`${base}/api/me`, { headers: bearer })).status).toBe(403);
    expect(
      (
        await fetch(`${base}${W}/state`, {
          headers: { authorization: "Bearer bs_pat_nope-nope-nope-nope-nope" },
        })
      ).status,
    ).toBe(401);
    expect((await post(`/api/me/tokens/${id}/revoke`, {}, h)).status).toBe(200);
    expect((await fetch(`${base}${W}/state`, { headers: bearer })).status).toBe(401);
  });

  it("lets a security admin tighten the session policy", async () => {
    const r = await post("/api/org/security", { mfa: "all", idleMinutes: 15, absoluteHours: 8 }, h);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mfa: "all", idleMinutes: 15, absoluteHours: 8 });
    expect((await post("/api/org/security", { idleMinutes: 99999 }, h)).status).toBe(200);
    expect(
      (
        (await (await fetch(`${base}/api/org/security`, { headers: h })).json()) as {
          idleMinutes: number;
        }
      ).idleMinutes,
    ).toBe(480);
  });

  it("serves the page and bundled assets without a session, with security headers", async () => {
    const page = await fetch(`${base}/`);
    expect(page.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).not.toMatch(/token/i);
    expect((await fetch(`${base}/app.css`)).headers.get("content-type")).toMatch(/text\/css/);
    const font = await fetch(`${base}/fonts/geist.woff2`);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(new Uint8Array(await font.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
    );
    const logo = await fetch(`${base}/brand/icon.svg`);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(await logo.text()).toMatch(/^<svg /);
    expect((await fetch(`${base}/brand/missing.svg`)).status).toBe(404);
    expect(await raw("/brand/../package.json", { host: `127.0.0.1:${port}` })).toBe(404);
  });

  it("declares a permission on every API route", () => {
    const api = routes.filter((r) => r.path.includes("api"));
    expect(api.length).toBeGreaterThan(5);
    for (const r of api) expect(r.perm, `${r.method} ${r.path}`).not.toBe("public");
    // Sensitive changes need a fresh password or MFA code (step-up).
    const sensitive = routes.filter(
      (r) =>
        r.method === "POST" &&
        ["apply$/", "security$/", "tokens$/", "recovery$/", "disable$/"].some((x) =>
          r.path.endsWith(x),
        ),
    );
    expect(sensitive).toHaveLength(5);
    for (const r of sensitive)
      expect((r as { stepUp?: boolean }).stepUp, `${r.path} needs step-up`).toBe(true);
    expect(
      routes
        .filter((r) => r.perm === "public")
        .map((r) => r.path)
        .sort(),
    ).toEqual(
      [
        "/^\\/auth\\/github\\/app-created$/",
        "/^\\/auth\\/github\\/installed$/",
        "/^\\/auth\\/invite$/",
        "/^\\/auth\\/invite$/",
        "/^\\/auth\\/login$/",
        "/^\\/auth\\/session$/",
        "/^\\/auth\\/setup$/",
      ].sort(),
    );
  });

  it("refuses API calls without a session, without CSRF, cross-origin, or with a foreign Host", async () => {
    expect((await fetch(`${base}${W}/state`)).status).toBe(401);
    expect(await raw(`${W}/state`, { host: `evil.example:${port}`, cookie: h.cookie ?? "" })).toBe(
      421,
    );
    expect(await raw("/", { host: "evil.example" })).toBe(421);
    const apply = `${W}/runs/20261118000000-abc123/apply`;
    expect((await post(apply, {}, { cookie: h.cookie ?? "" })).status).toBe(403);
    expect((await post(apply, {}, { ...h, origin: "https://evil.example" })).status).toBe(403);
  });

  it("lists runs and serves one, but never paths outside the runs directory", async () => {
    const state = (await (await fetch(`${base}${W}/state`, { headers: h })).json()) as {
      runs: { id: string; agent_lines: number }[];
      repo: { dependencies: Record<string, string> };
    };
    expect(state.runs.map((r) => r.id)).toEqual(["20261118000000-abc123"]);
    expect(state.repo.dependencies.zod).toBe("^3.23.8");
    expect((await fetch(`${base}${W}/runs/20261118000000-abc123`, { headers: h })).status).toBe(
      200,
    );
    expect((await fetch(`${base}${W}/runs/..%2F..%2Fetc`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}${W}/runs/nope`, { headers: h })).status).toBe(404);
  });

  it("serves a run's stored full file for context, and nothing outside it", async () => {
    const file = (q: string, headers = h) =>
      fetch(`${base}${W}/runs/20261118000000-abc123/file?${q}`, { headers });
    const ok = await file("side=after&path=src/a.ts");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { text: string }).text).toBe("export const a = 1;\n");
    expect((await file("side=after&path=src/a.ts", {})).status).toBe(401);
    expect((await file("side=after&path=../job.json")).status).toBe(400);
    expect((await file("side=after&path=%2E%2E%2F%2E%2E%2Fsecret.txt")).status).toBe(400);
    expect((await file("side=after&path=")).status).toBe(400);
    expect((await file("side=after&path=escape.txt")).status).toBe(404);
    expect((await file("side=before&path=src/a.ts")).status).toBe(404);
    expect((await file("side=after&path=src")).status).toBe(404);
  });

  it("explains a patch that does not apply instead of half-applying it", async () => {
    const r = await post(`${W}/runs/20261118000000-abc123/apply`, {}, h);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/does not apply/);
  });

  it("validates upgrade requests before starting anything", async () => {
    const r = await post(`${W}/runs`, { package: "zod; rm -rf /", version: "4.1.0" }, h);
    expect(r.status).toBe(400);
  });

  it("records actions in a verifiable audit log", async () => {
    const v = (await (await fetch(`${base}/api/audit/verify`, { headers: h })).json()) as {
      ok: boolean;
      rows: number;
    };
    expect(v.ok).toBe(true);
    expect(v.rows).toBeGreaterThanOrEqual(2); // org created, login
  });

  it("gives one generic error for bad sign-ins, then locks the account", async () => {
    const bad = await post("/auth/login", {
      email: "nobody@acme.dev",
      password: "Whatever-Long-1",
    });
    const wrong = await post("/auth/login", {
      email: "dana@acme.dev",
      password: "Wrong-Password-1",
    });
    expect([bad.status, wrong.status]).toEqual([401, 401]);
    expect(((await bad.json()) as { error: string }).error).toBe(
      ((await wrong.json()) as { error: string }).error,
    );
    for (let i = 0; i < 4; i++)
      await post("/auth/login", { email: "dana@acme.dev", password: "Wrong-Password-1" });
    // locked: even the right password is refused for now
    expect((await post("/auth/login", { email: "dana@acme.dev", password: PASSWORD })).status).toBe(
      429,
    );
  });

  it("invites a member, who joins with a password and gets only their role", async () => {
    expect((await post("/api/org/security", { mfa: "admins" }, h)).status).toBe(200);
    const mem = (await (await fetch(`${base}/api/members`, { headers: h })).json()) as {
      roles: { id: string; name: string }[];
    };
    const roles = Object.fromEntries(mem.roles.map((r) => [r.name, r.id]));
    const inv = await post(
      "/api/members/invite",
      { email: "sam@acme.dev", roleId: roles.Viewer },
      h,
    );
    expect(inv.status).toBe(200);
    expect(
      (await post("/api/members/invite", { email: "sam@acme.dev", roleId: roles.Viewer }, h))
        .status,
    ).toBe(409);
    const token = ((await inv.json()) as { link: string }).link.split("#/invite/")[1] ?? "";
    expect(await (await fetch(`${base}/auth/invite?token=${token}`)).json()).toEqual({
      email: "sam@acme.dev",
      org: "Acme",
    });
    expect(
      (await post("/auth/invite", { token, name: "Sam Patel", password: "password1234" })).status,
    ).toBe(400);
    const joined = await post("/auth/invite", {
      token,
      name: "Sam Patel",
      password: "Copper-Harbour-Lantern-7",
    });
    expect(joined.status).toBe(200);
    sam = await signedIn(joined);
    expect(
      (await post("/auth/invite", { token, name: "X", password: "Copper-Harbour-Lantern-7" }))
        .status,
    ).toBe(404);
    expect((await fetch(`${base}${W}/state`, { headers: sam })).status).toBe(200);
    expect((await post(`${W}/runs/20261118000000-abc123/apply`, {}, sam)).status).toBe(403);
    expect(
      (await post("/api/members/invite", { email: "x@acme.dev", roleId: roles.Viewer }, sam))
        .status,
    ).toBe(403);
    expect((await fetch(`${base}/api/access`, { headers: sam })).status).toBe(403);
    expect(
      (await post("/api/roles", { name: "Mine", description: "", permissions: ["runs.view"] }, sam))
        .status,
    ).toBe(403);
  });

  it("hides restricted repositories until access is granted, and grants only what is held", async () => {
    const slug = W.split("/").pop();
    expect(
      (await post("/api/access/visibility", { workspace: slug, visibility: "restricted" }, h))
        .status,
    ).toBe(200);
    expect((await fetch(`${base}${W}/state`, { headers: sam })).status).toBe(404);
    expect(
      (
        await fetch(`${base}${W}/runs/20261118000000-abc123/file?side=after&path=src/a.ts`, {
          headers: sam,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        (await (await fetch(`${base}/api/workspaces`, { headers: sam })).json()) as {
          workspaces: unknown[];
        }
      ).workspaces,
    ).toEqual([]);
    expect(
      (await post("/api/roles", { name: "Bad", description: "", permissions: ["org.manage"] }, h))
        .status,
    ).toBe(400);
    const role = await post(
      "/api/roles",
      {
        name: "Release manager",
        description: "",
        permissions: ["runs.view", "runs.apply", "workspaces.view"],
      },
      h,
    );
    const roleId = ((await role.json()) as { id: string }).id;
    const access = (await (await fetch(`${base}/api/access`, { headers: h })).json()) as {
      members: { id: string; email: string }[];
    };
    const samId = access.members.find((m) => m.email === "sam@acme.dev")?.id ?? "";
    expect(
      (
        await post(
          "/api/access/grant",
          { workspace: slug, principalType: "user", principalId: samId, roleId },
          h,
        )
      ).status,
    ).toBe(200);
    expect((await post(`${W}/runs/20261118000000-abc123/apply`, {}, sam)).status).toBe(409); // allowed: reaches git
    expect((await post(`${W}/runs/20261118000000-abc123/delete`, {}, sam)).status).toBe(403); // not granted
    const check = (await (
      await fetch(`${base}/api/access/check?user=${samId}`, { headers: h })
    ).json()) as { repositories: { why: string[] }[] };
    expect(check.repositories[0]?.why).toEqual(["Granted Release manager directly"]);
    expect((await post(`/api/roles/${roleId}/delete`, {}, h)).status).toBe(409); // still granted
  });

  it("refuses self-service escalation and ends a deactivated member's sessions", async () => {
    const me = (await (await fetch(`${base}/api/members`, { headers: h })).json()) as {
      me: string;
      members: { id: string; email: string }[];
      roles: { id: string; name: string }[];
    };
    const viewer = me.roles.find((r) => r.name === "Viewer")?.id;
    expect((await post(`/api/members/${me.me}/role`, { roleId: viewer }, h)).status).toBe(403); // not your own role
    const samId = me.members.find((m) => m.email === "sam@acme.dev")?.id ?? "";
    expect((await post(`/api/members/${samId}/deactivate`, {}, h)).status).toBe(200);
    expect((await fetch(`${base}/api/workspaces`, { headers: sam })).status).toBe(401);
  });

  it("records people and access changes in the audit log", async () => {
    const a = (await (await fetch(`${base}/api/audit?cat=access`, { headers: h })).json()) as {
      rows: { action: string }[];
      chain: { ok: boolean };
    };
    expect(a.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["access.granted", "access.visibility_changed"]),
    );
    expect(a.chain.ok).toBe(true);
    const csv = await fetch(`${base}/api/audit/export`, { headers: h });
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(await csv.text()).toMatch(/^seq,time,actor,action/);
  });

  it("keeps integration secrets out of every response, and GitHub callbacks need their state", async () => {
    const r = await fetch(`${base}/api/integrations`, { headers: h });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      models: { id: string; last4: string | null }[];
      github: { app: unknown; token: unknown };
    };
    expect(body.models.map((m) => m.id)).toContain("anthropic-api");
    expect(body.github).toMatchObject({ app: null, token: null });
    expect((await post("/api/integrations/keys", { provider: "nope", key: "x" }, h)).status).toBe(
      400,
    );
    expect((await post("/api/integrations/github/token", { token: "not-a-token" }, h)).status).toBe(
      400,
    );
    // A forged or replayed callback never touches the organisation.
    const forged = await fetch(`${base}/auth/github/app-created?code=abc123&state=forged`, {
      redirect: "manual",
    });
    expect(forged.status).toBe(302);
    expect(forged.headers.get("location")).toBe("/#/org/integrations?github=expired");
    const onboarding = (await (await fetch(`${base}/api/onboarding`, { headers: h })).json()) as {
      steps: Record<string, boolean>;
    };
    expect(onboarding.steps).toMatchObject({ account: true, mfa: true, repository: true });
  });

  it("ends the session on sign-out", async () => {
    expect((await post("/auth/logout", {}, h)).status).toBe(200);
    expect((await fetch(`${base}${W}/state`, { headers: h })).status).toBe(401);
  });
});
