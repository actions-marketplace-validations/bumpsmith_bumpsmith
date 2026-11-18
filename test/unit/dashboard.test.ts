import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageOf, startDashboard, summarise } from "../../src/dashboard/server.ts";
import type { JobRecord } from "../../src/pipeline.ts";
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

describe("dashboard server", () => {
  let base = "";
  let port = 0;
  let token = "";
  let close: () => Promise<void> = async () => {};
  let repo = "";

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
      port: 4600 + Math.floor(Math.random() * 300),
      cliEntry: "",
    });
    base = d.url.replace(/\/$/, "");
    port = d.port;
    close = d.close;
    const html = await (await fetch(`${base}/`)).text();
    token = /name="bumpsmith-token" content="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
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

  it("serves the page with a per-session token and bundled assets", async () => {
    expect(token).toMatch(/^[a-f0-9]{48}$/);
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

  it("refuses API calls without the token, and foreign Host headers (DNS rebinding)", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(403);
    expect(
      await raw("/api/state", { host: `evil.example:${port}`, "x-bumpsmith-token": token }),
    ).toBe(421);
    expect(await raw("/", { host: "evil.example" })).toBe(421);
  });

  it("lists runs and serves one, but never paths outside the runs directory", async () => {
    const h = { "x-bumpsmith-token": token };
    const state = (await (await fetch(`${base}/api/state`, { headers: h })).json()) as {
      runs: { id: string; agent_lines: number }[];
      repo: { dependencies: Record<string, string> };
    };
    expect(state.runs.map((r) => r.id)).toEqual(["20261118000000-abc123"]);
    expect(state.repo.dependencies.zod).toBe("^3.23.8");
    expect((await fetch(`${base}/api/runs/20261118000000-abc123`, { headers: h })).status).toBe(
      200,
    );
    expect((await fetch(`${base}/api/runs/..%2F..%2Fetc`, { headers: h })).status).toBe(404);
    expect((await fetch(`${base}/api/runs/nope`, { headers: h })).status).toBe(404);
  });

  it("serves a run's stored full file for context, and nothing outside it", async () => {
    const h = { "x-bumpsmith-token": token };
    const file = (q: string, headers = h) =>
      fetch(`${base}/api/runs/20261118000000-abc123/file?${q}`, { headers });
    const ok = await file("side=after&path=src/a.ts");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { text: string }).text).toBe("export const a = 1;\n");
    expect((await file("side=after&path=src/a.ts", {} as typeof h)).status).toBe(403);
    expect((await file("side=after&path=../job.json")).status).toBe(400);
    expect((await file("side=after&path=%2E%2E%2F%2E%2E%2Fsecret.txt")).status).toBe(400);
    expect((await file("side=after&path=")).status).toBe(400);
    expect((await file("side=after&path=escape.txt")).status).toBe(404);
    expect((await file("side=before&path=src/a.ts")).status).toBe(404);
    expect((await file("side=after&path=src")).status).toBe(404);
  });

  it("explains a patch that does not apply instead of half-applying it", async () => {
    const r = await fetch(`${base}/api/runs/20261118000000-abc123/apply`, {
      method: "POST",
      headers: { "x-bumpsmith-token": token },
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/does not apply/);
  });

  it("validates upgrade requests before starting anything", async () => {
    const r = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "x-bumpsmith-token": token, "content-type": "application/json" },
      body: JSON.stringify({ package: "zod; rm -rf /", version: "4.1.0" }),
    });
    expect(r.status).toBe(400);
  });
});
