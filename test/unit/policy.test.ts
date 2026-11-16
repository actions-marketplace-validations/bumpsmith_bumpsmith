import { describe, expect, it } from "vitest";
import { EditPolicy, isDenied, normalisePath, PolicyError } from "../../src/agent/policy.ts";

describe("normalisePath", () => {
  it.each(["../etc/passwd", "a/../../x", "/etc/passwd", "%2e%2e/x", "a\0b", ""])(
    "rejects %j",
    (p) => {
      expect(() => normalisePath(p)).toThrow(PolicyError);
    },
  );
  it("normalises /workspace prefixes and dots", () => {
    expect(normalisePath("/workspace/src/./a.ts")).toBe("src/a.ts");
    expect(normalisePath("src//b/../a.ts")).toBe("src/a.ts");
  });
});

describe("denylist", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".env",
    "apps/web/.env.local",
    ".npmrc",
    "deploy/x.sh",
    "certs/server.key",
    "LICENSE",
    "Dockerfile",
    ".git/config",
    "AGENTS.md",
    ".bumpsmith.yml",
  ])("protects %s", (p) => expect(isDenied(p)).toBe(true));
  it.each(["src/index.ts", "package.json", "tests/test_api.py", "README.md"])("allows %s", (p) =>
    expect(isDenied(p)).toBe(false),
  );
});

describe("EditPolicy", () => {
  it("allows allowlisted files, requires a reason otherwise, never allows protected files", () => {
    const p = new EditPolicy(["src/a.ts", "package.json"]);
    expect(p.checkEdit("src/a.ts")).toBe("src/a.ts");
    expect(() => p.checkEdit("src/b.ts")).toThrow(/reason/);
    expect(p.checkEdit("src/b.ts", "re-export moved")).toBe("src/b.ts");
    expect(p.edits.get("src/b.ts")?.allowlisted).toBe(false);
    expect(() => p.checkEdit(".github/workflows/ci.yml", "needed")).toThrow(/protected/);
  });
});
