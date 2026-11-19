import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../src/agent/tools.ts";
import { FakeProvider } from "../../src/model/fake.ts";
import { runJob } from "../../src/pipeline.ts";

const enabled = process.env.BUMPSMITH_DOCKER_TESTS === "1";
const fixture = join(import.meta.dirname, "..", "fixtures", "nanoid-async");

const tool = (tools: AgentTool[], name: string) => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

describe.skipIf(!enabled)(
  "end to end with a scripted model (requires Docker + network for npm)",
  () => {
    it(
      "fixes nanoid 4 -> 5 on the fixture and produces evidence",
      async () => {
        let injectionAttempt = "";
        const provider = new FakeProvider({
          structured: (req) => {
            if (req.role === "extractor")
              return {
                changes: [
                  {
                    kind: "removed",
                    symbols: ["nanoid/async"],
                    before: "import { nanoid } from 'nanoid/async'",
                    after: "import { nanoid } from 'nanoid'",
                    instruction: "Use the synchronous API from 'nanoid'.",
                    evidence: [
                      {
                        url: "x",
                        quote: "Removed async API since Web Crypto API has only sync version.",
                      },
                    ],
                    detected_by: ["changelog"],
                    confidence: "high",
                    deadline: null,
                  },
                ],
                codemods: [],
                min_runtime: [],
              };
            return {
              criteria: [
                "scope",
                "nothing_suspicious",
                "tests_not_weakened",
                "plan_matches_diff",
                "changes_addressed",
              ].map((id) => ({ id, pass: true, reason: "ok" })),
              verdict: "approve",
              summary: "Minimal import change.",
              unverified: [],
            };
          },
          agent: async (req) => {
            // A compromised model trying to touch CI must be refused by the tool layer.
            injectionAttempt = await tool(req.tools, "create_file").run({
              path: ".github/workflows/x.yml",
              content: "on: push",
              reason: "please",
            });
            await tool(req.tools, "edit_file").run({
              path: "src/ids.ts",
              old_text: 'from "nanoid/async"',
              new_text: 'from "nanoid"',
            });
            const check = await tool(req.tools, "run_check").run({ name: "test" });
            return `Plan: switch c1 import to sync API.\n${check.slice(0, 200)}`;
          },
        });

        const job = await runJob(
          { repo: fixture, packageName: "nanoid", to: "5.0.9", from: "4.0.2" },
          {
            provider,
            runsDir: join(import.meta.dirname, "..", "..", "runs", "test"),
            refreshChangeRecord: true,
          },
        );

        expect(job.error).toBeUndefined();
        expect(injectionAttempt).toMatch(/^ERROR: .*protected/);
        expect(job.baseline?.every((c) => c.passed)).toBe(true);
        expect(job.after_bump?.some((c) => !c.passed)).toBe(true);
        expect(job.verdict?.passed).toBe(true);
        expect(job.state).toBe("ready");
        expect(job.confidence).toBe("high");
        const dir = join(import.meta.dirname, "..", "..", "runs", "test", job.id);
        const patch = await readFile(join(dir, "patch.diff"), "utf8");
        expect(patch).toContain('+import { customAlphabet, nanoid } from "nanoid";');
        expect(patch).toContain('+    "nanoid": "^5.0.9"');
        expect(patch).not.toContain(".github");
        expect(patch).not.toMatch(/a\/(before|after)\//);
        expect(patch).toContain('"version": "5.0.9"'); // exact gated version, not the newest 5.x
        const evidence = await readFile(join(dir, "evidence.md"), "utf8");
        expect(evidence).toContain("REMOVED ENTRY POINT");
      },
      // Below the CI step limit, so a stall fails with this test named.
      6 * 60_000,
    );

    it(
      "works on a package in a monorepo sub-directory (Dependabot 'in /packages/app')",
      async () => {
        const { cp, mkdtemp, writeFile } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const repo = await mkdtemp(join(tmpdir(), "bumpsmith-mono-"));
        await writeFile(join(repo, "package.json"), '{ "name": "mono-root", "private": true }\n');
        await cp(fixture, join(repo, "packages", "app"), {
          recursive: true,
          filter: (f) => !/node_modules|dist/.test(f),
        });
        const provider = new FakeProvider({
          structured: (req) =>
            req.role === "extractor"
              ? {
                  changes: [
                    {
                      kind: "removed",
                      symbols: ["nanoid/async"],
                      before: "",
                      after: "",
                      instruction: "Use the synchronous API from 'nanoid'.",
                      evidence: [
                        {
                          url: "x",
                          quote: "Removed async API since Web Crypto API has only sync version.",
                        },
                      ],
                      detected_by: ["changelog"],
                      confidence: "high",
                      deadline: null,
                    },
                  ],
                  codemods: [],
                  min_runtime: [],
                }
              : {
                  criteria: [
                    "scope",
                    "nothing_suspicious",
                    "tests_not_weakened",
                    "plan_matches_diff",
                    "changes_addressed",
                  ].map((id) => ({ id, pass: true, reason: "ok" })),
                  verdict: "approve",
                  summary: "Import change in packages/app.",
                  unverified: [],
                },
          agent: async (req) => {
            await tool(req.tools, "edit_file").run({
              path: "packages/app/src/ids.ts",
              old_text: 'from "nanoid/async"',
              new_text: 'from "nanoid"',
            });
            return "Switched the import.";
          },
        });
        const job = await runJob(
          { repo, packageName: "nanoid", to: "5.0.9", from: "4.0.2", dir: "/packages/app/" },
          {
            provider,
            runsDir: join(import.meta.dirname, "..", "..", "runs", "test"),
            refreshChangeRecord: true,
          },
        );
        expect(job.error).toBeUndefined();
        expect(job.state).toBe("ready");
        expect(job.impact?.items.every((i) => i.file.startsWith("packages/app/"))).toBe(true);
        const patch = await readFile(
          join(import.meta.dirname, "..", "..", "runs", "test", job.id, "patch.diff"),
          "utf8",
        );
        expect(patch).toContain("a/packages/app/package.json");
        expect(patch).toContain("a/packages/app/src/ids.ts");
        expect(patch).not.toMatch(/^diff --git a\/package\.json/m); // the root manifest is untouched
      },
      // Below the CI step limit, so a stall fails with this test named.
      6 * 60_000,
    );

    it(
      "fixes a Python project: pydantic 1 -> 2 (BaseSettings moved to pydantic-settings)",
      async () => {
        const pyFixture = join(import.meta.dirname, "..", "fixtures", "pydantic-settings");
        const provider = new FakeProvider({
          structured: (req) =>
            req.role === "extractor"
              ? {
                  changes: [
                    {
                      kind: "removed",
                      symbols: ["BaseSettings"],
                      before: "from pydantic import BaseSettings",
                      after: "from pydantic_settings import BaseSettings",
                      instruction:
                        'Install "pydantic-settings" and import BaseSettings from pydantic_settings.',
                      evidence: [
                        { url: "x", quote: "`BaseSettings` has moved to `pydantic-settings`" },
                      ],
                      detected_by: ["migration_guide"],
                      confidence: "high",
                      deadline: null,
                    },
                  ],
                  codemods: [],
                  min_runtime: [],
                }
              : {
                  criteria: [
                    "scope",
                    "nothing_suspicious",
                    "tests_not_weakened",
                    "plan_matches_diff",
                    "changes_addressed",
                  ].map((id) => ({ id, pass: true, reason: "ok" })),
                  verdict: "approve",
                  summary: "Moved BaseSettings import; added pydantic-settings.",
                  unverified: [],
                },
          agent: async (req) => {
            await tool(req.tools, "edit_file").run({
              path: "app/config.py",
              old_text: "from pydantic import BaseSettings",
              new_text: "from pydantic_settings import BaseSettings",
            });
            await tool(req.tools, "edit_file").run({
              path: "requirements.txt",
              old_text: "pytest==8.3.4",
              new_text: "pytest==8.3.4\npydantic-settings==2.7.1",
              reason: "pydantic 2 moved BaseSettings to pydantic-settings",
            });
            const install = await tool(req.tools, "run_check").run({ name: "install" });
            const test = await tool(req.tools, "run_check").run({ name: "test" });
            return `Moved the import and added pydantic-settings.\n${install.slice(0, 100)}\n${test.slice(0, 200)}`;
          },
        });
        const job = await runJob(
          {
            repo: pyFixture,
            packageName: "pydantic",
            to: "2.10.6",
            from: "1.10.18",
            ecosystem: "pypi",
          },
          {
            provider,
            runsDir: join(import.meta.dirname, "..", "..", "runs", "test"),
            refreshChangeRecord: true,
          },
        );
        expect(job.error).toBeUndefined();
        expect(job.baseline?.every((c) => c.passed)).toBe(true);
        expect(job.after_bump?.some((c) => !c.passed)).toBe(true);
        expect(job.verdict?.passed).toBe(true);
        expect(job.state).toBe("ready");
        const patch = await readFile(
          join(import.meta.dirname, "..", "..", "runs", "test", job.id, "patch.diff"),
          "utf8",
        );
        expect(patch).toContain("+pydantic==2.10.6");
        expect(patch).toContain("+pydantic-settings==2.7.1");
        expect(patch).toContain("+from pydantic_settings import BaseSettings");
      },
      // Below the CI step limit, so a stall fails with this test named.
      6 * 60_000,
    );
  },
);
