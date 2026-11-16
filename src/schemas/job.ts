import { z } from "zod";
import { Confidence } from "./change-record.ts";

export const Ecosystem = z.enum(["npm", "pypi"]);
export type Ecosystem = z.infer<typeof Ecosystem>;

/** One place in the repository affected by a breaking change (PRD §8.4). */
export const ImpactItem = z.object({
  file: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  symbol: z.string(),
  change_id: z.string(),
  snippet: z.string(),
  confidence: Confidence,
});
export type ImpactItem = z.infer<typeof ImpactItem>;

export const UpgradeClass = z.enum(["safe", "mechanical", "agent", "human"]);
export type UpgradeClass = z.infer<typeof UpgradeClass>;

export const ImpactMap = z.object({
  package: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(ImpactItem),
  files_importing_package: z.array(z.string()),
  upgrade_class: UpgradeClass,
  reason: z.string(),
});
export type ImpactMap = z.infer<typeof ImpactMap>;

export const CheckName = z.enum(["install", "build", "typecheck", "lint", "test"]);
export type CheckName = z.infer<typeof CheckName>;

export const CheckResult = z.object({
  name: CheckName,
  command: z.string(),
  exit_code: z.number().int(),
  passed: z.boolean(),
  duration_ms: z.number(),
  timed_out: z.boolean(),
  output_tail: z.string(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const JobState = z.enum([
  "detected",
  "waiting_release_age",
  "analysed",
  "safe",
  "fixing",
  "verifying",
  "reviewing",
  "ready",
  "needs_human",
  "blocked_policy",
  "failed_infra",
]);
export type JobState = z.infer<typeof JobState>;

export const UsageEntry = z.object({
  role: z.enum(["extractor", "fixer", "reviewer"]),
  provider: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  /** Dollar cost at API list price, even when the run used a subscription. */
  api_equivalent_usd: z.number(),
  duration_ms: z.number(),
});
export type UsageEntry = z.infer<typeof UsageEntry>;
