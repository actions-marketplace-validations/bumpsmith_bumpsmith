import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main, runAction, type Target } from "../../src/action.ts";
import { tokenClient } from "../../src/github/client.ts";
import type { JobRecord } from "../../src/pipeline.ts";
import { FakeGitHub, type FakeRepo } from "../fakes/github.ts";

const BASE = {
  "package.json": '{\n  "name": "demo",\n  "dependencies": {\n    "left-pad": "^1.0.0"\n  }\n}\n',
  "src/index.js": 'const pad = require("left-pad");\nmodule.exports = (s) => pad(s, 5);\n',
  ".github/workflows/ci.yml": "on: push\n",
};
const PATCH = `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -2,5 +2,5 @@
   "name": "demo",
   "dependencies": {
-    "left-pad": "^1.0.0"
+    "left-pad": "^2.0.0"
   }
 }
diff --git a/src/index.js b/src/index.js
--- a/src/index.js
+++ b/src/index.js
@@ -1,2 +1,2 @@
-const pad = require("left-pad");
+const { pad } = require("left-pad");
 module.exports = (s) => pad(s, 5);
`;

const record = (id: string, state = "ready"): JobRecord =>
  ({
    id,
    created_at: "",
    input: { repo: "x", packageName: "left-pad", to: "2.0.0", from: "1.0.0" },
    provider: "fake",
    model: "claude-opus-5-5",
    prompt_versions: {},
    state,
    from: "1.0.0",
    change_record: {
      schema: "change-record/1",
      package: "pkg:npm/left-pad",
      from: "1.0.0",
      to: "2.0.0",
      record_version: 1,
      changes: [
        {
          id: "c1",
          kind: "removed",
          symbols: ["default"],
          before: "",
          after: "",
          instruction: "Use the named export.",
          evidence: [{ url: "https://x", quote: "removed" }],
          detected_by: ["changelog"],
          confidence: "high",
          deadline: null,
        },
      ],
      codemods: [],
      min_runtime: {},
      sources: [],
      created_at: "",
    },
    impact: {
      items: [
        { file: "src/index.js", line: 1, symbol: "default", change_id: "c1", snippet: "require" },
      ],
      upgrade_class: "agent",
      reason: "One import uses the removed default export.",
    },
    verdict: {
      passed: true,
      comparisons: [{ name: "test", baseline: true, after: true, flaky: false, regression: false }],
      regressions: [],
      preexistingFailures: [],
    },
    rounds: [],
    edits: [{ path: "src/index.js", allowlisted: true, reason: null }],
    rules: [],
    review: { criteria: [], verdict: "approve", summary: "ok", unverified: [] },
    confidence: "high",
    notes: state === "needs_human" ? ["The tests still fail after three rounds."] : [],
    cost_usd: 0.42,
  }) as unknown as JobRecord;

describe("GitHub Action (fake GitHub)", { timeout: 60_000 }, () => {
  let gh: FakeGitHub;
  let repo: FakeRepo;
  let token: string;
  let botPr: number;
  let nextPatch = PATCH;
  let nextState = "ready";
  const upgrades: Target[] = [];

  beforeAll(async () => {
    gh = new FakeGitHub();
    await gh.start();
    ({ repo } = gh.addRepo({ id: 1, owner: "acme", name: "demo", files: BASE, installationId: 1 }));
    token = gh.issueToken({
      installationId: 1,
      repositoryIds: [1],
      permissions: { contents: "write", pull_requests: "write", metadata: "read", checks: "read" },
    });
  });
  afterAll(async () => gh?.stop());
  beforeEach(() => {
    nextPatch = PATCH;
    nextState = "ready";
    upgrades.length = 0;
  });

  const run = async (event: string, payload: Record<string, unknown>) =>
    runAction({
      gh: tokenClient(token, { baseUrl: gh.url }),
      owner: "acme",
      repo: "demo",
      event,
      payload,
      workDir: await mkdtemp(join(tmpdir(), "bs-action-")),
      maxCostUsd: 5,
      checkout: async (dest) => {
        await mkdir(dest, { recursive: true });
        return { removedSymlinks: [] };
      },
      upgrade: async (t, _repoDir, runsDir) => {
        upgrades.push(t);
        const id = `job-${upgrades.length}-${Date.now()}`;
        await mkdir(join(runsDir, id), { recursive: true });
        await writeFile(join(runsDir, id, "patch.diff"), nextPatch);
        return record(id, nextState);
      },
    });

  const failedRun = () => ({
    workflow_run: { conclusion: "failure", pull_requests: [{ number: botPr }] },
  });

  it("rescues a red Dependabot PR with a verified companion PR built from the default branch", async () => {
    botPr = gh.botPr(repo, {
      title: "Bump left-pad from 1.0.0 to 2.0.0",
      user: "dependabot[bot]",
      branch: "dependabot/npm_and_yarn/left-pad-2.0.0",
      files: { "package.json": BASE["package.json"].replace("^1.0.0", "^2.0.0") },
      red: true,
    });
    const rows = await run("workflow_run", failedRun());
    expect(rows).toHaveLength(1);
    expect(upgrades[0]).toMatchObject({
      packageName: "left-pad",
      from: "1.0.0",
      to: "2.0.0",
      ecosystem: "npm",
      rescueOf: botPr,
    });
    const pr = repo.pulls.find((p) => p.head === "bumpsmith/npm/left-pad-2.0.0");
    expect(pr).toBeTruthy();
    expect(pr?.body).toContain(`Companion to #${botPr}`);
    const head = repo.refs.get("heads/bumpsmith/npm/left-pad-2.0.0") as string;
    expect(gh.commits.get(head)?.verified).toBe(true);
    expect(gh.commits.get(head)?.parents).toEqual([repo.refs.get("heads/main")]);
    expect(gh.fileAt(head, "src/index.js")).toContain("const { pad }");
    expect(
      repo.comments.some((c) => c.issue === botPr && /Bumpsmith opened #\d+/.test(c.body)),
    ).toBe(true);
  });

  it("re-running updates the same PR instead of opening a duplicate", async () => {
    const before = repo.pulls.length;
    const rows = await run("workflow_run", failedRun());
    expect(rows[0]?.result).toMatch(/^updated #/);
    expect(repo.pulls.length).toBe(before);
  });

  it("never overwrites a branch a human pushed to", async () => {
    const humanHead = gh.humanPush(
      repo,
      "bumpsmith/npm/left-pad-2.0.0",
      "src/index.js",
      "// mine\n",
    );
    const rows = await run("workflow_run", failedRun());
    expect(rows[0]?.result).toMatch(/human commits/);
    expect(repo.refs.get("heads/bumpsmith/npm/left-pad-2.0.0")).toBe(humanHead);
  });

  it("never reopens a PR a user closed", async () => {
    for (const p of repo.pulls) if (p.head.startsWith("bumpsmith/")) p.state = "closed";
    const before = repo.pulls.length;
    const rows = await run("workflow_run", failedRun());
    expect(rows[0]?.result).toMatch(/closed by a user/);
    expect(repo.pulls.length).toBe(before);
  });

  it("blocks a patch that touches workflow files before writing anything", async () => {
    const pr = gh.botPr(repo, {
      title: "Bump chalk from 4.0.0 to 5.0.0",
      user: "dependabot[bot]",
      branch: "dependabot/npm_and_yarn/chalk-5",
      files: { "package.json": "{}\n" },
      red: true,
    });
    nextPatch =
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1,2 @@\n on: push\n+# steal\n";
    const writes = () => gh.requests.filter((r) => r.method !== "GET").length;
    const before = writes();
    const rows = await run("workflow_run", {
      workflow_run: { conclusion: "failure", pull_requests: [{ number: pr }] },
    });
    expect(rows[0]?.result).toMatch(/^blocked: rule protected_path/);
    expect(writes()).toBe(before);
  });

  it("comments on the bot PR when no safe fix exists", async () => {
    const pr = gh.botPr(repo, {
      title: "Bump uuid from 9.0.0 to 11.0.0",
      user: "dependabot[bot]",
      branch: "dependabot/npm_and_yarn/uuid-11",
      files: { "package.json": "{}\n" },
      red: true,
    });
    nextPatch = "";
    nextState = "needs_human";
    const rows = await run("workflow_run", {
      workflow_run: { conclusion: "failure", pull_requests: [{ number: pr }] },
    });
    expect(rows[0]?.result).toMatch(/needs a human/);
    expect(repo.comments.find((c) => c.issue === pr)?.body).toContain(
      "could not produce a verified fix",
    );
  });

  it("handles a grouped Dependabot update as one companion PR", async () => {
    const pr = gh.botPr(repo, {
      title: "Bump the npm_and_yarn group with 2 updates",
      user: "dependabot[bot]",
      branch: "dependabot/npm_and_yarn/npm_and_yarn-abc",
      files: { "package.json": "{}\n" },
      red: true,
      body: "Updates `left-pad` from 1.0.0 to 2.0.0\n\nUpdates `chalk` from 5.0.0 to 5.3.0",
    });
    const rows = await run("workflow_run", {
      workflow_run: { conclusion: "failure", pull_requests: [{ number: pr }] },
    });
    expect(upgrades.at(-1)).toMatchObject({
      packageName: "left-pad",
      to: "2.0.0",
      also: [{ name: "chalk", to: "5.3.0" }],
    });
    expect(rows[0]?.result).toMatch(/^opened #/);
    expect(repo.pulls.some((p) => p.head === "bumpsmith/npm/left-pad-group-2.0.0")).toBe(true);
  });

  it("does nothing for green runs or human PRs", async () => {
    expect(
      await run("workflow_run", {
        workflow_run: { conclusion: "success", pull_requests: [{ number: botPr }] },
      }),
    ).toEqual([]);
    const human = gh.botPr(repo, {
      title: "Bump x from 1.0.0 to 2.0.0",
      user: "mallory",
      branch: "feature",
      files: { "package.json": "{}\n" },
      red: true,
    });
    expect(
      await run("workflow_run", {
        workflow_run: { conclusion: "failure", pull_requests: [{ number: human }] },
      }),
    ).toEqual([]);
    expect(upgrades).toEqual([]);
  });

  it("masks the API key and token before doing anything else", async () => {
    const out: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((c: string | Uint8Array) => (out.push(String(c)), true));
    process.env["INPUT_ANTHROPIC-API-KEY"] = "sk-ant-api03-SECRETSECRETSECRETSECRET";
    process.env["INPUT_GITHUB-TOKEN"] = "ghs_SECRETTOKENSECRETTOKEN1234567890";
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    await expect(main()).rejects.toThrow(/GITHUB_REPOSITORY/);
    spy.mockRestore();
    process.env.GITHUB_REPOSITORY = saved;
    expect(out.join("")).toContain("::add-mask::sk-ant-api03-SECRETSECRETSECRETSECRET");
    expect(out.join("")).toContain("::add-mask::ghs_SECRETTOKENSECRETTOKEN1234567890");
  });
});
