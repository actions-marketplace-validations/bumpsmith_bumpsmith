import { describe, expect, it } from "vitest";
import { costUsd } from "../../src/model/pricing.ts";
import { releaseGate } from "../../src/registry/registry.ts";
import { parsePatch } from "../../src/review/patch.ts";
import { filesFromOutput } from "../../src/verify/verify.ts";

describe("release gate", () => {
  const base = {
    ecosystem: "npm" as const,
    name: "x",
    version: "1.0.0",
    yanked: false,
    deprecated: null,
    repositoryUrl: null,
    homepage: null,
    minRuntime: null,
  };
  const now = new Date("2026-11-16T00:00:00Z");
  it("waits for young releases", () => {
    const g = releaseGate(
      { ...base, publishedAt: new Date("2026-11-15T00:00:00Z") },
      { malicious: false, ids: [] },
      3,
      now,
    );
    expect(g.allowed).toBe(false);
  });
  it("refuses malicious and deprecated versions", () => {
    const g = releaseGate(
      { ...base, publishedAt: new Date("2026-01-01"), deprecated: "bad" },
      { malicious: true, ids: ["MAL-1"] },
      3,
      now,
    );
    expect(g.reasons.join(" ")).toMatch(/deprecated.*malicious/s);
  });
  it("allows old, clean releases", () => {
    expect(
      releaseGate(
        { ...base, publishedAt: new Date("2026-01-01") },
        { malicious: false, ids: [] },
        3,
        now,
      ).allowed,
    ).toBe(true);
  });
});

describe("helpers", () => {
  it("prices tokens at list price", () => {
    expect(
      costUsd("claude-opus-5-5", {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }),
    ).toBe(4);
    expect(
      Number.isNaN(
        costUsd("unknown", {
          input_tokens: 1,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
      ),
    ).toBe(true);
  });
  it("extracts file paths from compiler output", () => {
    const out =
      "src/ids.ts(1,40): error TS2307: Cannot find module 'nanoid/async'\n/workspace/lib/x.py:12: in test\nnode_modules/a/b.js:1:1";
    expect(filesFromOutput(out)).toEqual(["src/ids.ts", "lib/x.py"]);
  });
  it("parses added files in patches", () => {
    const f = parsePatch(
      "diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n",
    );
    expect(f[0]).toMatchObject({ path: "n.ts", status: "added", added: ["x"] });
  });
});

describe("patch filtering and private registries", () => {
  it("drops build artifacts from the patch", async () => {
    const { filterPatch } = await import("../../src/review/patch.ts");
    const patch =
      "diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/tsconfig.tsbuildinfo b/tsconfig.tsbuildinfo\n+y\n";
    const r = filterPatch(patch, (p) => p === "src/a.ts");
    expect(r.patch).toBe("diff --git a/src/a.ts b/src/a.ts\n+x\n");
    expect(r.excluded).toEqual(["tsconfig.tsbuildinfo"]);
  });
  it("detects lockfiles that use a private registry", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { privateRegistryHost } = await import("../../src/pipeline.ts");
    const dir = await mkdtemp(join(tmpdir(), "bumpsmith-lock-"));
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/a": {
            resolved: "https://ms-feed.pkgs.visualstudio.com/_packaging/npm/a-1.0.0.tgz",
          },
        },
      }),
    );
    expect(await privateRegistryHost(dir, ["package-lock.json"])).toBe(
      "ms-feed.pkgs.visualstudio.com",
    );
    await writeFile(
      join(dir, "package-lock.json"),
      JSON.stringify({
        packages: { "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" } },
      }),
    );
    expect(await privateRegistryHost(dir, ["package-lock.json"])).toBeNull();
    // pnpm lockfiles carry no URLs; a scoped registry in .npmrc is the only signal.
    await writeFile(join(dir, ".npmrc"), "@navikt:registry=https://npm.pkg.github.com\n");
    expect(await privateRegistryHost(dir, [])).toBe("npm.pkg.github.com");
    await writeFile(join(dir, ".npmrc"), "registry=https://registry.npmjs.org/\n");
    expect(await privateRegistryHost(dir, [])).toBeNull();
  });
});

describe("unsupported dependency sources and deadlines", () => {
  it("finds git and URL dependencies", async () => {
    const { nonRegistryDependencies } = await import("../../src/pipeline.ts");
    const pkg = JSON.stringify({
      dependencies: {
        a: "^1",
        b: "fogproject/sails-mongo",
        c: "git+https://x/y.git",
        d: "github:o/r#v1",
      },
    });
    expect(nonRegistryDependencies(pkg)).toEqual([
      "b (fogproject/sails-mongo)",
      "c (git+https://x/y.git)",
      "d (github:o/r#v1)",
    ]);
  });
  it("caps steps by the remaining job time and stops when it runs out", async () => {
    const { Deadline, TimeBudgetExceeded } = await import("../../src/verify/verify.ts");
    expect(new Deadline(45).allow(900)).toBe(900);
    expect(new Deadline(1).allow(900)).toBeLessThanOrEqual(60);
    expect(() => new Deadline(0).allow(900)).toThrow(TimeBudgetExceeded);
  });
});

describe("fix batch helpers", () => {
  it("picks the sandbox Node major from .nvmrc / engines", async () => {
    const { nodeMajorFor } = await import("../../src/inventory/inventory.ts");
    expect(nodeMajorFor(undefined)).toBe(22);
    expect(nodeMajorFor(">=18")).toBe(22);
    expect(nodeMajorFor("20.11.0")).toBe(22);
    expect(nodeMajorFor("v24.11.1")).toBe(24);
    expect(nodeMajorFor(">=24")).toBe(24);
    expect(nodeMajorFor("^22 || ^24")).toBe(22);
  });
  it("builds yarn-berry add argv", async () => {
    const { npmUpgradeArgv } = await import("../../src/inventory/bump.ts");
    expect(
      npmUpgradeArgv(
        "yarn-berry",
        "execa",
        "9.0.0",
        { field: "devDependencies", prefix: "^" },
        new Date(),
        true,
      ),
    ).toEqual(["yarn-berry", "add", "--dev", "execa@9.0.0"]);
  });
  it("caps extractor sources", async () => {
    const { capSources } = await import("../../src/change/extract.ts");
    const s = [{ text: "a".repeat(300_000) }, { text: "b".repeat(1000) }];
    capSources(s, 150_000);
    expect(s[0]?.text.length).toBeLessThanOrEqual(150_000);
    expect(s[1]?.text.length).toBe(1000);
  });
  it("sizes agent check timeouts from baseline and deadline", async () => {
    const { agentCheckTimeout } = await import("../../src/agent/tools.ts");
    const ctx = { baselineMs: { test: 60_000 }, remainingSec: () => 3600 } as never;
    expect(agentCheckTimeout(ctx, "test")).toBe(300);
    expect(
      agentCheckTimeout({ ...(ctx as object), remainingSec: () => 400 } as never, "test"),
    ).toBe(160);
  });
  it("detects subscription limit text", async () => {
    const { USAGE_LIMIT_RE } = await import("../../src/model/provider.ts");
    expect(USAGE_LIMIT_RE.test("You've hit your session limit · resets 3pm")).toBe(true);
    expect(USAGE_LIMIT_RE.test("TypeError: x is undefined")).toBe(false);
  });
});

describe("snapshot exclusions", () => {
  it("never copies Bumpsmith's own output folder into a job", async () => {
    const { EXPORT_EXCLUDES } = await import("../../src/sandbox/sandbox.ts");
    expect(EXPORT_EXCLUDES).toContain(".bumpsmith");
  });
});

describe("monorepo directories", () => {
  it("normalises Dependabot directories and refuses traversal", async () => {
    const { normaliseSubdir } = await import("../../src/pipeline.ts");
    const { branchName } = await import("../../src/github/publish/pr-body.ts");
    expect(normaliseSubdir("/")).toBe("");
    expect(normaliseSubdir(undefined)).toBe("");
    expect(normaliseSubdir("/packages/api/")).toBe("packages/api");
    expect(() => normaliseSubdir("/packages/../../etc")).toThrow(/invalid directory/);
    expect(branchName("npm", "zod", "4.0.1", "packages/api")).toBe(
      "bumpsmith/npm/zod-4.0.1-in-packages-api",
    );
    expect(branchName("npm", "@scope/x", "2.0.0")).toBe("bumpsmith/npm/scope-x-2.0.0");
  });
});

describe("PyPI source repository", () => {
  it("prefers the Source link and ignores Funding/sponsor pages", async () => {
    const { pickPypiRepo } = await import("../../src/registry/registry.ts");
    expect(
      pickPypiRepo({
        Changelog: "https://docs.pydantic.dev/latest/changelog/",
        Funding: "https://github.com/sponsors/samuelcolvin",
        Homepage: "https://github.com/pydantic/pydantic",
        Source: "https://github.com/pydantic/pydantic",
      }),
    ).toBe("https://github.com/pydantic/pydantic");
    expect(
      pickPypiRepo({ Funding: "https://github.com/sponsors/x", Docs: "https://x.readthedocs.io" }),
    ).toBeNull();
    expect(pickPypiRepo({ Homepage: "https://gitlab.com/group/project" })).toBe(
      "https://gitlab.com/group/project",
    );
  });
});

describe("subscription sign-in detection", () => {
  it("recognises an expired sign-in but not ordinary errors", async () => {
    const { SIGN_IN_RE } = await import("../../src/model/provider.ts");
    expect(
      SIGN_IN_RE.test("Failed to authenticate: OAuth session expired and could not be refreshed"),
    ).toBe(true);
    expect(SIGN_IN_RE.test("TypeError: cannot read properties of undefined")).toBe(false);
  });
});

describe("verification gate", () => {
  it("is unverified without a passing install and at least one real check after the upgrade", async () => {
    const { isVerified } = await import("../../src/pipeline.ts");
    const check = (name: string, passed: boolean) =>
      ({
        name,
        passed,
        command: "",
        exit_code: passed ? 0 : 1,
        duration_ms: 1,
        timed_out: false,
        output_tail: "",
      }) as never;
    const cmp = (name: string, after: boolean) =>
      ({ name, baseline: true, after, flaky: false, regression: false }) as never;
    const verdict = (c: never[]) => ({ passed: true, comparisons: c }) as never;
    expect(isVerified([check("install", false)], verdict([]))).toBe(false);
    expect(isVerified([check("install", true)], verdict([cmp("install", true)]))).toBe(false);
    expect(
      isVerified([check("install", true)], verdict([cmp("install", true), cmp("test", true)])),
    ).toBe(true);
  });
});

describe("fixes from the second held-out run", () => {
  it("ignores paths from check output that point outside the workspace", async () => {
    const { EditPolicy } = await import("../../src/agent/policy.ts");
    const p = new EditPolicy(["src/a.py", "../../home/sandbox/.local/lib/x.py", "/usr/lib/y.py"]);
    expect(() => p.addAllowed("../outside.py")).not.toThrow();
    expect(() => p.checkEdit("src/a.py", "test")).not.toThrow();
  });
  it("uses the Python manifests for a PyPI upgrade in a repo that also has package.json", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { inventory } = await import("../../src/inventory/inventory.ts");
    const dir = await mkdtemp(join(tmpdir(), "bs-inv-"));
    await writeFile(join(dir, "package.json"), '{"name":"web","dependencies":{"react":"18.0.0"}}');
    await writeFile(join(dir, "requirements.in"), "marshmallow>=3.26.2,<4\n");
    await writeFile(join(dir, "requirements.txt"), "marshmallow==3.26.2\n");
    expect((await inventory(dir, "pypi")).ecosystem).toBe("pypi");
    expect((await inventory(dir, "pypi")).manifests).toEqual([
      "requirements.txt",
      "requirements.in",
    ]);
    expect((await inventory(dir)).ecosystem).toBe("npm");
  });
});

describe("vendored Yarn releases", () => {
  it("uses Yarn 2+ flags for a vendored Yarn 4 and Yarn 1 flags for a vendored Yarn 1", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { inventory } = await import("../../src/inventory/inventory.ts");
    for (const [release, pm] of [
      ["yarn-4.7.0.cjs", "yarn-berry"],
      ["yarn-1.22.22.cjs", "yarn"],
    ]) {
      const dir = await mkdtemp(join(tmpdir(), "bs-yarn-"));
      await mkdir(join(dir, ".yarn/releases"), { recursive: true });
      await writeFile(join(dir, `.yarn/releases/${release}`), "");
      await writeFile(join(dir, ".yarnrc.yml"), `yarnPath: .yarn/releases/${release}\n`);
      await writeFile(join(dir, "yarn.lock"), "");
      await writeFile(join(dir, "package.json"), '{"name":"x","packageManager":"yarn@4.7.0"}');
      if (pm === "yarn")
        await writeFile(join(dir, "package.json"), '{"name":"x","packageManager":"yarn@1.22.22"}');
      expect((await inventory(dir)).packageManager).toBe(pm);
    }
  });
});

describe("which requirement files to install", () => {
  it("installs the app and dev/test files, not CI or docs pins", async () => {
    const { installSet } = await import("../../src/inventory/inventory.ts");
    expect(
      installSet([
        "ci-requirements.txt",
        "dev-requirements.txt",
        "docs-requirements.txt",
        "requirements.txt",
      ]),
    ).toEqual(["requirements.txt", "dev-requirements.txt"]);
    expect(
      installSet(["requirements-dev.txt", "requirements.txt", "requirements-test.txt"]),
    ).toEqual(["requirements.txt", "requirements-dev.txt", "requirements-test.txt"]);
    expect(installSet(["requirements-prod.txt"])).toEqual(["requirements-prod.txt"]);
  });
});
