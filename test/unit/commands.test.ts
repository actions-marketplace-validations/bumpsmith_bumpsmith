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
