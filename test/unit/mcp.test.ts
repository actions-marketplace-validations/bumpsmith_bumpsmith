import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboard } from "../../src/dashboard/server.ts";
import { base32Decode, hotp } from "../../src/server/crypto.ts";
import { runOk } from "../../src/util/proc.ts";

const PASSWORD = "Harbor-Lantern-Quartz-58";
const RUN = "20261118000000-abc123";
const job = {
  id: RUN,
  created_at: "2026-11-18T00:00:00.000Z",
  finished_at: "2026-11-18T00:03:00.000Z",
  input: { repo: "/r", packageName: "zod", to: "4.1.0", ecosystem: "npm" },
  provider: "fake",
  model: "fake",
  prompt_versions: {},
  state: "needs_human",
  confidence: "low",
  from: "3.23.8",
  rounds: [],
  baseline: [],
  edits: [],
  usage: [],
  cost_usd: 0.4,
  duration_ms: 90000,
  notes: [],
};

async function repoWithRun() {
  const repo = await mkdtemp(join(tmpdir(), "bumpsmith-mcp-"));
  await writeFile(join(repo, "package.json"), '{"dependencies":{"zod":"^3.23.8"}}\n');
  await runOk("git", ["-C", repo, "init", "-q"]);
  const dir = join(repo, ".bumpsmith", "runs", RUN);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "job.json"), JSON.stringify(job));
  await writeFile(join(dir, "evidence.md"), "# Upgrade zod 3.23.8 → 4.1.0\n\nNeeds a human.\n");
  await writeFile(join(dir, "patch.diff"), "diff --git a/x b/x\n");
  return repo;
}

/** One JSON-RPC exchange over Streamable HTTP (stateless; the reply may come as SSE). */
async function rpc(url: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  const json = raw.trim().startsWith("{")
    ? raw
    : (raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .pop() ?? "{}");
  return { status: r.status, body: JSON.parse(json) };
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  },
};
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const textOf = (b: { result?: { content?: { text: string }[]; isError?: boolean } }) =>
  b.result?.content?.[0]?.text ?? "";

describe("MCP over HTTP on a Bumpsmith server (/mcp)", { timeout: 60_000 }, () => {
  let base = "";
  let close: () => Promise<void>;
  let viewer = "";
  let starter = "";

  beforeAll(async () => {
    const repo = await repoWithRun();
    const d = await startDashboard({
      repoDir: repo,
      dataDir: join(repo, ".data"),
      port: 5100 + Math.floor(Math.random() * 300),
      cliEntry: "",
    });
    base = d.url.replace(/\/$/, "");
    close = d.close;
    const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
      fetch(base + p, {
        method: "POST",
        headers: { "content-type": "application/json", ...h },
        body: JSON.stringify(b),
      });
    const r = await post("/auth/setup", {
      orgName: "Acme",
      name: "Dana Reyes",
      email: "dana@acme.dev",
      password: PASSWORD,
      token: d.setupUrl?.split("#/setup/")[1],
    });
    const h = {
      cookie: (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
      "x-csrf-token": ((await r.json()) as { csrf: string }).csrf,
    };
    const { secret } = (await (await post("/api/me/mfa/start", {}, h)).json()) as {
      secret: string;
    };
    await post(
      "/api/me/mfa/confirm",
      {
        code: hotp(base32Decode(secret), Math.floor(Date.now() / 30000))
          .toString()
          .padStart(6, "0"),
      },
      h,
    );
    const tok = async (scopes: string[]) =>
      (
        (await (await post("/api/me/tokens", { name: "mcp", days: 7, scopes }, h)).json()) as {
          token: string;
        }
      ).token;
    viewer = await tok(["runs.view", "workspaces.view"]);
    starter = await tok(["runs.view", "runs.start", "workspaces.view"]);
  });
  afterAll(() => close());

  it("asks for a token, and refuses other origins", async () => {
    const r = await rpc(`${base}/mcp`, init);
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/API token/);
    const x = await rpc(`${base}/mcp`, init, {
      authorization: `Bearer ${viewer}`,
      origin: "https://evil.example",
    });
    expect(x.status).toBe(403);
  });

  it("serves Bumpsmith's tools to a token holder", async () => {
    const auth = { authorization: `Bearer ${viewer}` };
    const i = await rpc(`${base}/mcp`, init, auth);
    expect(i.status).toBe(200);
    expect(i.body.result.serverInfo.name).toBe("bumpsmith");
    const list = await rpc(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list" }, auth);
    const names = list.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_repositories",
        "get_upgrade",
        "start_upgrade",
        "check_release",
      ]),
    );
    // No applying to a server's clone: you take the patch, or the pull request.
    expect(names).not.toContain("apply_upgrade");
    expect(textOf((await rpc(`${base}/mcp`, call(3, "list_repositories"), auth)).body)).toMatch(
      /^bumpsmith-mcp-/,
    );
    const runs = await rpc(`${base}/mcp`, call(4, "list_upgrades"), auth);
    expect(textOf(runs.body)).toContain(`${RUN}\tzod 3.23.8 → 4.1.0\tneeds_human`);
    const one = await rpc(
      `${base}/mcp`,
      call(5, "get_upgrade", { id: RUN, include_patch: true }),
      auth,
    );
    expect(textOf(one.body)).toMatch(/NEEDS_HUMAN[\s\S]*Needs a human[\s\S]*```diff/);
  });

  it("honours the token's scopes", async () => {
    const r = await rpc(
      `${base}/mcp`,
      call(6, "start_upgrade", { package: "zod", version: "4.1.0" }),
      { authorization: `Bearer ${viewer}` },
    );
    expect(r.body.result.isError).toBe(true);
    expect(textOf(r.body)).toMatch(/does not allow starting/);
    // a token that may start runs gets a live id it can poll
    const s = await rpc(
      `${base}/mcp`,
      call(7, "start_upgrade", { package: "zod", version: "4.1.0", provider: "fake-nope" }),
      { authorization: `Bearer ${starter}` },
    );
    expect(textOf(s.body)).toMatch(/Started zod → 4\.1\.0 as [0-9a-f]{12}/);
  });
});

describe("MCP over stdio (bumpsmith mcp)", { timeout: 60_000 }, () => {
  let child: ChildProcessWithoutNullStreams;
  let buf = "";
  const waiting = new Map<number, (v: unknown) => void>();

  beforeAll(async () => {
    const repo = await repoWithRun();
    const root = resolve(import.meta.dirname, "../..");
    child = spawn(
      process.execPath,
      ["--import", "tsx", join(root, "src", "cli.ts"), "mcp", "--repo", repo],
      { cwd: root },
    );
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id !== undefined) waiting.get(msg.id)?.(msg);
        }
        i = buf.indexOf("\n");
      }
    });
  });
  afterAll(() => child.kill());

  const send = (msg: { id?: number }) =>
    new Promise<{ result: Record<string, unknown> & { content?: { text: string }[] } }>((ok) => {
      if (msg.id !== undefined) waiting.set(msg.id, ok as (v: unknown) => void);
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      if (msg.id === undefined) ok({ result: {} });
    });

  it("speaks MCP on stdout and nothing else", async () => {
    const i = await send(init);
    expect((i.result.serverInfo as { name: string }).name).toBe("bumpsmith");
    await send({ jsonrpc: "2.0", method: "notifications/initialized" } as never);
    const list = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" } as never);
    expect((list.result.tools as { name: string }[]).map((t) => t.name)).toContain("apply_upgrade");
    const runs = await send(call(3, "list_upgrades") as never);
    expect(runs.result.content?.[0]?.text).toContain("needs_human");
  });

  it("refuses to apply a result that was not verified", async () => {
    const r = await send(call(4, "apply_upgrade", { id: RUN }) as never);
    expect(r.result.isError).toBe(true);
    expect(r.result.content?.[0]?.text).toMatch(/not verified/);
  });
});
