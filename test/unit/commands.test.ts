import { describe, expect, it } from "vitest";
import { canCommand, parseCommand } from "../../src/github/commands.ts";
import { parseBotPr } from "../../src/rescue/bot-pr.ts";

describe("comment commands", () => {
  it("parses commands addressed to the app", () => {
    expect(parseCommand("@bumpsmith-dev explain", "bumpsmith-dev")).toEqual({ name: "explain" });
    expect(parseCommand("thanks!\n@Bumpsmith-Dev[bot] ignore this major", "bumpsmith-dev")).toEqual(
      {
        name: "ignore_major",
      },
    );
    expect(parseCommand("@bumpsmith-dev ignore this version please", "bumpsmith-dev")).toEqual({
      name: "ignore_version",
    });
    expect(parseCommand("@bumpsmith-dev fix this", "bumpsmith-dev")).toEqual({ name: "fix" });
  });
  it("ignores quotes, code blocks, other apps and unknown verbs", () => {
    expect(parseCommand("> @bumpsmith-dev retry", "bumpsmith-dev")).toBeNull();
    expect(parseCommand("```\n@bumpsmith-dev retry\n```", "bumpsmith-dev")).toBeNull();
    expect(parseCommand("@bumpsmith-devil retry", "bumpsmith-dev")).toBeNull();
    expect(parseCommand("@bumpsmith-dev delete everything", "bumpsmith-dev")).toBeNull();
    expect(parseCommand("please @bumpsmith-dev retry", "bumpsmith-dev")).toBeNull();
  });
  it("only write, maintain and admin may command", () => {
    for (const p of ["admin", "maintain", "write"]) expect(canCommand(p)).toBe(true);
    for (const p of ["triage", "read", "none", ""]) expect(canCommand(p)).toBe(false);
  });
});

describe("bot pull requests", () => {
  it("parses Dependabot and Renovate titles", () => {
    expect(parseBotPr("Bump zod from 3.23.8 to 4.0.1", "dependabot[bot]")).toMatchObject({
      pkg: "zod",
      from: "3.23.8",
      to: "4.0.1",
    });
    expect(
      parseBotPr("chore(deps): bump @types/node from 20.1.0 to 22.0.0 in /web", "dependabot[bot]"),
    ).toMatchObject({ pkg: "@types/node", dir: "/web" });
    expect(parseBotPr("Update dependency vitest to v5", "renovate[bot]")).toMatchObject({
      pkg: "vitest",
      from: null,
      to: "5",
    });
    expect(parseBotPr("fix(deps): update @octokit/core to v7.0.8", "renovate[bot]")).toMatchObject({
      pkg: "@octokit/core",
      to: "7.0.8",
    });
  });
  it("refuses grouped updates and non-bot authors", () => {
    expect(parseBotPr("Bump the npm group with 3 updates", "dependabot[bot]")).toBeNull();
    expect(parseBotPr("Bump zod from 3 to 4", "mallory")).toBeNull();
    expect(parseBotPr("Lock file maintenance", "renovate[bot]")).toBeNull();
  });
});

describe("grouped updates", () => {
  it("reads Dependabot and Renovate group bodies", async () => {
    const { parseGroupedUpdates } = await import("../../src/rescue/bot-pr.ts");
    const dependabot = `Bumps the npm_and_yarn group with 2 updates: [eslint](https://x) and [@eslint/js](https://y).\n\nUpdates \`eslint\` from 8.57.0 to 9.1.0\n- [Release notes](https://x)\n\nUpdates \`@eslint/js\` from 8.57.0 to 9.1.0`;
    expect(parseGroupedUpdates(dependabot)).toEqual([
      { pkg: "eslint", from: "8.57.0", to: "9.1.0" },
      { pkg: "@eslint/js", from: "8.57.0", to: "9.1.0" },
    ]);
    const renovate =
      "| Package | Change |\n|---|---|\n| [vitest](https://v) | `^4.1.0` -> `^5.0.2` |\n| [@vitest/coverage-v8](https://c) | `4.1.0` -> `5.0.2` |";
    expect(parseGroupedUpdates(renovate)).toEqual([
      { pkg: "vitest", from: "4.1.0", to: "5.0.2" },
      { pkg: "@vitest/coverage-v8", from: "4.1.0", to: "5.0.2" },
    ]);
  });
  it("installs grouped companions at their own versions", async () => {
    const { npmUpgradeArgv } = await import("../../src/inventory/bump.ts");
    const argv = npmUpgradeArgv(
      "pnpm",
      "eslint",
      "9.1.0",
      { field: "devDependencies", prefix: "^" },
      new Date(),
      false,
      ["@eslint/js@9.2.0", "eslint-config-x"],
    );
    expect(argv.slice(-3)).toEqual(["eslint@9.1.0", "@eslint/js@9.2.0", "eslint-config-x@9.1.0"]);
  });
});
