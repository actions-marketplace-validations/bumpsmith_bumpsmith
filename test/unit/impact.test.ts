import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildImpactMap, parseSymbol } from "../../src/impact/impact.ts";
import type { ChangeRecord } from "../../src/schemas/change-record.ts";

const fixture = join(import.meta.dirname, "..", "fixtures", "nanoid-async");
const record = (symbols: string[]): ChangeRecord => ({
  schema: "change-record/1",
  package: "pkg:npm/nanoid",
  from: "4.0.2",
  to: "5.0.9",
  record_version: 1,
  changes: [
    {
      id: "c1",
      kind: "removed",
      symbols,
      before: "",
      after: "",
      instruction: "",
      evidence: [{ url: "u", quote: "q" }],
      detected_by: ["api_diff"],
      confidence: "high",
      deadline: null,
    },
  ],
  codemods: [],
  min_runtime: {},
  sources: [],
  created_at: "x",
});

describe("impact map", () => {
  it("parses symbols", () => {
    expect(parseSymbol("pkg/sub:Cls.m")).toEqual({ module: "pkg/sub", path: ["Cls", "m"] });
    expect(parseSymbol("@scope/pkg")).toEqual({ module: "@scope/pkg", path: [] });
  });
  it("finds the removed entry point and its uses in the fixture", async () => {
    const map = await buildImpactMap(fixture, "npm", "nanoid", record(["nanoid/async"]));
    expect(map.files_importing_package).toEqual(["src/ids.ts"]);
    expect(map.upgrade_class).toBe("agent");
    const lines = map.items.map((i) => i.line);
    expect(lines).toContain(1); // the import
    expect(lines).toContain(3); // customAlphabet(...)
    expect(lines).toContain(6); // await nanoid()
  });
  it("is safe when changed symbols are unused", async () => {
    const map = await buildImpactMap(fixture, "npm", "nanoid", record(["nanoid:urlAlphabet"]));
    expect(map.items).toHaveLength(0);
    expect(map.upgrade_class).toBe("safe");
  });
});
