// Model keys and GitHub credentials: encrypted at rest, given only to upgrade runs, and the
// GitHub App flow's state values and signed tokens behave as they must.
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/server/db.ts";
import { Integrations } from "../../src/server/integrations.ts";

async function setup() {
  const db = openDb(await mkdtemp(join(tmpdir(), "bs-integ-")));
  db.prepare(
    "INSERT INTO orgs (id, name, created_at) VALUES ('org_1', 'Acme', '2026-11-19')",
  ).run();
  return { db, integ: new Integrations(db, Buffer.alloc(32, 9)) };
}

afterEach(() => vi.unstubAllGlobals());

describe("integration secrets", () => {
  it("are encrypted at rest and only reach upgrade runs", async () => {
    const { db, integ } = await setup();
    integ.set("org_1", "ANTHROPIC_API_KEY", "sk-ant-api03-SECRETVALUE1234", "usr_1");
    integ.set("org_1", "GITHUB_TOKEN", "github_pat_ABCDEFGHIJKLMNOPQRSTUV", "usr_1");
    const raw = JSON.stringify(db.prepare("SELECT * FROM secrets").all());
    expect(raw).not.toContain("SECRETVALUE");
    expect(raw).not.toContain("ABCDEFGHIJ");
    expect(integ.list("org_1").map((x) => [x.name, x.last4])).toEqual(
      expect.arrayContaining([
        ["ANTHROPIC_API_KEY", "1234"],
        ["GITHUB_TOKEN", "STUV"],
      ]),
    );
    // Runs get model keys, never the GitHub token (jobs get a per-job token instead).
    expect(integ.runEnv("org_1")).toEqual({ ANTHROPIC_API_KEY: "sk-ant-api03-SECRETVALUE1234" });
    expect(() => integ.set("org_1", "PATH", "/evil", "usr_1")).toThrow(/Unknown setting/);
  });

  it("checks a key with the provider before it is saved", async () => {
    const { integ } = await setup();
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response("{}", {
          status: (init.headers as Record<string, string>)["x-api-key"] === "good" ? 200 : 401,
        }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await integ.verifyKey("anthropic-api", "good")).toEqual({
      ok: true,
      detail: "Key works.",
    });
    expect((await integ.verifyKey("anthropic-api", "bad")).ok).toBe(false);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/models?limit=1");
  });
});

describe("GitHub App flow", () => {
  it("uses each state value once, for its own step", async () => {
    const { integ } = await setup();
    const { action, manifest } = integ.appManifest(
      "org_1",
      "usr_1",
      "https://bumpsmith.acme.dev",
      "Bumpsmith Acme",
      "acme",
    );
    expect(action).toMatch(
      /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/,
    );
    expect(manifest).toMatchObject({
      redirect_url: "https://bumpsmith.acme.dev/auth/github/app-created",
      public: false,
      default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
    expect(JSON.stringify(manifest)).not.toMatch(/workflows|administration|secrets/);
    const state = decodeURIComponent(action.split("state=")[1] ?? "");
    expect(integ.takeState(state, "install")).toBeNull(); // wrong step
    expect(integ.takeState(state, "create")).toBeNull(); // already used up by the wrong-step attempt
    const { action: a2 } = integ.appManifest("org_1", "usr_1", "https://x", "App", "");
    const s2 = decodeURIComponent(a2.split("state=")[1] ?? "");
    expect(integ.takeState(s2, "create")).toMatchObject({ orgId: "org_1", userId: "usr_1" });
    expect(integ.takeState(s2, "create")).toBeNull();
    expect(() => integ.appManifest("org_1", "usr_1", "https://x", "App", "not an org!")).toThrow();
  });

  it("authenticates as the app with an RS256 token GitHub can verify", async () => {
    const { integ } = await setup();
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    integ.set(
      "org_1",
      "GITHUB_APP",
      JSON.stringify({
        id: 42,
        slug: "bumpsmith-acme",
        name: "Bumpsmith Acme",
        pem,
        owner: "acme",
      }),
      "usr_1",
    );
    let auth = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).authorization ?? "";
        return new Response("[]", { status: 200 });
      }),
    );
    await integ.installations("org_1");
    const jwt = auth.replace(/^Bearer /, "");
    const [h, p, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const claims = JSON.parse(Buffer.from(p ?? "", "base64url").toString()) as {
      iss: string;
      exp: number;
      iat: number;
    };
    expect(claims.iss).toBe("42");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600); // GitHub allows at most 10 minutes
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        publicKey,
        Buffer.from(sig ?? "", "base64url"),
      ),
    ).toBe(true);
  });
});
