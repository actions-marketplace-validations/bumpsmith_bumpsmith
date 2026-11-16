import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat, betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { UsageEntry } from "../schemas/job.ts";
import { costUsd } from "./pricing.ts";
import {
  type AgentRequest,
  type AgentResult,
  type ModelProvider,
  RefusalError,
  type Role,
  type StructuredRequest,
  type StructuredResult,
} from "./provider.ts";

/**
 * Production provider on the Claude API (SDK 1.x, API version 2026-10-21).
 * - claude-opus-5-5: thinking is always on (adaptive); effort set explicitly (default would be medium).
 * - No temperature/top_p/top_k (rejected on API version 2026-10-21).
 * - No forced tool_choice (rejected on this model); tools use strict schemas via Zod.
 * - Server-side refusal fallback enabled ("default" routing), refusals surfaced as RefusalError.
 * - Top-level automatic prompt caching; stable system prompt first.
 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic-api";
  private readonly client: Anthropic;

  constructor(
    readonly model = "claude-opus-5-5",
    client?: Anthropic,
  ) {
    // Credentials come from the environment (ANTHROPIC_API_KEY or an `ant auth login` profile).
    this.client = client ?? new Anthropic({ maxRetries: 4 });
  }

  private entry(role: Role, model: string, u: Usage, started: number): UsageEntry {
    const usage = {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    };
    return {
      role,
      provider: this.name,
      model,
      ...usage,
      api_equivalent_usd: costUsd(model, usage),
      duration_ms: Date.now() - started,
    };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16_000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: req.system }],
      messages: [{ role: "user", content: req.user }],
      output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
    });
    if (res.stop_reason === "refusal") throw new RefusalError(res.stop_details?.category ?? null);
    if (res.parsed_output == null)
      throw new Error(`structured output missing (stop_reason=${res.stop_reason})`);
    return {
      data: res.parsed_output as T,
      usage: this.entry(req.role, res.model, res.usage, started),
    };
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const usage: UsageEntry[] = [];
    const tools = req.tools.map((t) =>
      betaZodTool({
        name: t.name,
        description: t.description,
        inputSchema: t.input,
        // Large tool inputs (file contents) stream as generated; the Zod schema validates
        // every parsed input before run() is called.
        eager_input_streaming: true,
        run: (input) => t.run(input),
      }),
    );
    let started = Date.now();
    let spent = 0;
    let turns = 0;
    let finalText = "";
    try {
      // Streaming is required at this max_tokens (the SDK refuses long non-streaming calls).
      const runner = this.client.beta.messages.toolRunner({
        model: this.model,
        max_tokens: 32_000,
        stream: true,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: req.system }],
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: req.effort },
        tools,
        max_iterations: req.maxTurns,
      });
      for await (const stream of runner) {
        const message = await stream.finalMessage();
        const e = this.entry(req.role, message.model, message.usage, started);
        usage.push(e);
        spent += Number.isNaN(e.api_equivalent_usd) ? 0 : e.api_equivalent_usd;
        started = Date.now();
        turns += 1;
        finalText =
          message.content
            .flatMap((b) => (b.type === "text" ? [b.text] : []))
            .join("\n")
            .trim() || finalText;
        if (message.stop_reason === "refusal")
          return {
            finalText,
            stop: "refusal",
            usage,
            error: message.stop_details?.category ?? undefined,
          };
        if (spent >= req.budgetUsd) return { finalText, stop: "budget", usage };
      }
      return { finalText, stop: turns >= req.maxTurns ? "max_turns" : "completed", usage };
    } catch (err) {
      return {
        finalText,
        stop: "error",
        usage,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
