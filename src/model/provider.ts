import type { z } from "zod";
import type { AgentTool } from "../agent/tools.ts";
import type { UsageEntry } from "../schemas/job.ts";

export type Role = UsageEntry["role"];
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StructuredRequest<T> {
  role: Role;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort: Effort;
}

export interface StructuredResult<T> {
  data: T;
  usage: UsageEntry;
}

export interface AgentRequest {
  role: Role;
  system: string;
  user: string;
  tools: AgentTool[];
  effort: Effort;
  maxTurns: number;
  /** Stop once this much has been spent (list-price dollars). */
  budgetUsd: number;
  /** Wall-clock cap for the whole agent run. */
  timeoutSec?: number;
}

export type AgentStop = "completed" | "max_turns" | "budget" | "refusal" | "error";

export interface AgentResult {
  finalText: string;
  stop: AgentStop;
  usage: UsageEntry[];
  error?: string;
}

/** A model backend. Production uses the paid API; local testing can use Claude Code. */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  runAgent(req: AgentRequest): Promise<AgentResult>;
}

/** The subscription or account usage limit was reached; retrying now only burns tasks. */
export class UsageLimitError extends Error {
  constructor(detail: string) {
    super(`usage limit reached: ${detail.slice(0, 300)}`);
    this.name = "UsageLimitError";
  }
}

export const USAGE_LIMIT_RE =
  /hit your .{0,40}limit|usage limit|rate[_ ]limit|limit (?:reached|will reset)|resets? at \d/i;

export class RefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`model declined the request${category ? ` (${category})` : ""}`);
    this.name = "RefusalError";
  }
}
