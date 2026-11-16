import { z } from "zod";

/**
 * Change Record: a structured, sourced description of what breaks between two
 * versions of one package (PRD §8.3, appendix C). Contains public data only.
 */

export const BreakingChangeKind = z.enum([
  "removed",
  "renamed",
  "signature_changed",
  "default_changed",
  "behavior_changed",
  "config_changed",
  "min_runtime_raised",
  "deprecated_with_date",
]);
export type BreakingChangeKind = z.infer<typeof BreakingChangeKind>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const Evidence = z.object({
  url: z.string().describe("Where the quote comes from"),
  quote: z.string().min(1).describe("Verbatim text from the source that supports the claim"),
});

export const DetectedBy = z.enum(["api_diff", "migration_guide", "changelog", "release_notes"]);

export const BreakingChange = z.object({
  id: z.string(),
  kind: BreakingChangeKind,
  symbols: z
    .array(z.string())
    .describe("Exported names affected, e.g. 'default', 'Command.option', 'parse'"),
  before: z.string().describe("Short code example of old usage, or empty string"),
  after: z.string().describe("Short code example of new usage, or empty string"),
  instruction: z.string().describe("One or two sentences telling a developer what to change"),
  evidence: z.array(Evidence).min(1),
  detected_by: z.array(DetectedBy).min(1),
  confidence: Confidence,
  deadline: z.string().nullable().describe("ISO date if the source gives a removal date"),
});
export type BreakingChange = z.infer<typeof BreakingChange>;

export const Codemod = z.object({
  command: z.string(),
  source_url: z.string(),
});

export const ChangeRecord = z.object({
  schema: z.literal("change-record/1"),
  package: z.string().describe("Package URL, e.g. pkg:npm/commander"),
  from: z.string(),
  to: z.string(),
  record_version: z.number().int().min(1),
  changes: z.array(BreakingChange),
  codemods: z.array(Codemod),
  min_runtime: z.record(z.string(), z.string()),
  sources: z.array(z.object({ kind: z.string(), url: z.string() })),
  created_at: z.string(),
});
export type ChangeRecord = z.infer<typeof ChangeRecord>;

/**
 * What the Extractor model is asked to return. Kept smaller than ChangeRecord
 * (no ids, versions or timestamps) so the model only fills in facts.
 */
export const ExtractorOutput = z.object({
  changes: z.array(BreakingChange.omit({ id: true })),
  codemods: z.array(Codemod),
  min_runtime: z.array(z.object({ runtime: z.string(), range: z.string() })),
});
export type ExtractorOutput = z.infer<typeof ExtractorOutput>;
