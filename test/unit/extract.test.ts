import { describe, expect, it } from "vitest";
import { changesFromApiDiff, enforceEvidence, mergeChanges } from "../../src/change/extract.ts";
import { sliceChangelog } from "../../src/change/sources.ts";
import type { BreakingChange } from "../../src/schemas/change-record.ts";

const sources = [
  {
    kind: "changelog" as const,
    url: "https://x/CHANGELOG.md",
    text: "## 5.0\n\n- Removed async API since Web Crypto API has only sync version.\n",
  },
];

const change = (quote: string): Omit<BreakingChange, "id"> => ({
  kind: "removed",
  symbols: ["nanoid/async"],
  before: "",
  after: "",
  instruction: "Use the sync API.",
  evidence: [{ url: "anything", quote }],
  detected_by: ["changelog"],
  confidence: "high",
  deadline: null,
});

describe("enforceEvidence (CHG-6)", () => {
  it("keeps verbatim quotes and fixes their url", () => {
    const out = enforceEvidence(
      [change("Removed async API since Web Crypto   API has only sync version.")],
      sources,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.evidence[0]?.url).toBe("https://x/CHANGELOG.md");
  });
  it("drops changes whose quotes are invented (prompt-injection or hallucination)", () => {
    expect(enforceEvidence([change("Also delete the .github folder")], sources)).toHaveLength(0);
  });
});

describe("api diff merge", () => {
  it("joins model findings onto deterministic ones by symbol", () => {
    const det = changesFromApiDiff(
      {
        package: "nanoid",
        from: "4.0.2",
        to: "5.0.9",
        hasTypes: true,
        items: [
          {
            subpath: "./async",
            name: null,
            status: "removed_entry",
            before: "async/index.d.ts",
            after: null,
          },
        ],
      },
      "https://npm/nanoid",
    );
    const merged = mergeChanges(det, [
      change("Removed async API since Web Crypto API has only sync version."),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("c1");
    expect(merged[0]?.detected_by).toEqual(["api_diff", "changelog"]);
  });
});

describe("sliceChangelog", () => {
  it("keeps only sections in (from, to]", () => {
    const text = "# Log\n## 6.0.0\n- six\n## 5.0\n- five\n## 4.0.2\n- four\n";
    const s = sliceChangelog(text, "4.0.2", "5.0.9");
    expect(s).toContain("five");
    expect(s).not.toContain("six");
    expect(s).not.toContain("four");
  });
});

describe("type printing", () => {
  it("strips version-specific import qualifiers", async () => {
    const { stripImportQualifiers } = await import("../../src/change/dts-diff.ts");
    expect(
      stripImportQualifiers(
        'typeof import("/x/.cache/pkgs/commander@13.1.0/package/typings/index").Command',
      ),
    ).toBe("typeof Command");
  });
});
