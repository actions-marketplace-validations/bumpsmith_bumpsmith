import { describe, expect, it } from "vitest";
import { bumpPackageJson, bumpPythonText, bumpRange } from "../../src/inventory/bump.ts";

describe("bumpRange", () => {
  it.each([
    ["^4.0.2", "^5.0.9"],
    ["~4.0.2", "~5.0.9"],
    ["4.0.2", "5.0.9"],
    [">=4", "^5.0.9"],
    ["4.x", "^5.0.9"],
  ])("%s", (range, want) => expect(bumpRange(range, "5.0.9")).toBe(want));
});

describe("bumpPackageJson", () => {
  it("updates deps, keeps indentation, ignores peer and workspace ranges", () => {
    const text =
      JSON.stringify(
        {
          dependencies: { nanoid: "^4.0.2", x: "workspace:*" },
          peerDependencies: { nanoid: ">=4" },
        },
        null,
        4,
      ) + "\n";
    const out = bumpPackageJson(text, "nanoid", "5.0.9");
    expect(out).toContain('    "nanoid": "^5.0.9"');
    expect(out).toContain('"nanoid": ">=4"');
    expect(out?.endsWith("\n")).toBe(true);
    expect(bumpPackageJson(text, "missing", "1.0.0")).toBeNull();
  });
});

describe("bumpPythonText", () => {
  it("rewrites pins and keeps extras", () => {
    expect(bumpPythonText("requests==2.31.0\nflask>=2\n", "requests", "2.32.3")).toBe(
      "requests==2.32.3\nflask>=2\n",
    );
    expect(bumpPythonText('dependencies = ["pydantic[email]>=1.10,<2"]', "pydantic", "2.9.2")).toBe(
      'dependencies = ["pydantic[email]>=2.9.2"]',
    );
  });
});

describe("npmUpgradeArgv", () => {
  it("installs the exact gated version with workspace-root flags", async () => {
    const { npmUpgradeArgv } = await import("../../src/inventory/bump.ts");
    const d = new Date("2026-11-13T00:00:00Z");
    expect(
      npmUpgradeArgv(
        "pnpm",
        "commander",
        "15.0.0",
        { field: "dependencies", prefix: "^" },
        d,
        true,
      ),
    ).toEqual(["pnpm", "add", "--ignore-scripts", "--workspace-root", "commander@15.0.0"]);
    expect(
      npmUpgradeArgv("npm", "x", "2.0.0", { field: "devDependencies", prefix: "" }, d),
    ).toEqual([
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--before=2026-11-13T00:00:00.000Z",
      "--save-dev",
      "--save-exact",
      "x@2.0.0",
    ]);
  });
});

describe("npmCompanions", () => {
  it("finds same-family packages pinned to the same version", async () => {
    const { npmCompanions } = await import("../../src/inventory/bump.ts");
    const pkg = JSON.stringify({
      devDependencies: {
        vitest: "^4.1.12",
        "@vitest/coverage-v8": "^4.1.12",
        "@vitest/ui": "4.0.0",
        vite: "^6",
      },
    });
    expect(npmCompanions(pkg, "vitest", "4.1.12")).toEqual(["@vitest/coverage-v8"]);
    const sentry = JSON.stringify({
      dependencies: {
        "@sentry/node": "10.75.3",
        "@sentry/profiling-node": "10.75.3",
        "@sentry/cli": "2.0.0",
      },
    });
    expect(npmCompanions(sentry, "@sentry/node", "10.75.3")).toEqual(["@sentry/profiling-node"]);
  });
});
