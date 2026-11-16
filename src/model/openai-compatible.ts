import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import { z } from "zod";
import type { UsageEntry } from "../schemas/job.ts";
import type {
  AgentRequest,
  AgentResult,
  Effort,
  ModelProvider,
  Role,
  StructuredRequest,
  StructuredResult,
} from "./provider.ts";
import { RefusalError } from "./provider.ts";

/**
 * Any OpenAI-compatible chat-completions endpoint: OpenAI, Google Gemini, OpenRouter, Groq,
 * Together, DeepSeek, Ollama, LM Studio or a custom URL. Uses the official `openai` SDK.
 *
 * Tool use runs in Bumpsmith's own loop, so every tool call is validated against its Zod
 * schema before it runs, and the same turn, time and budget limits apply as for Claude.
 */

export interface Preset {
  baseURL: string;
  keyEnv: string | null;
  /** Local servers need no key. */
  local?: boolean;
}

export const PRESETS: Record<string, Preset> = {
  openai: { baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyEnv: "GEMINI_API_KEY",
  },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY" },
  groq: { baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY" },
  together: { baseURL: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY" },
  deepseek: { baseURL: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY" },
  ollama: { baseURL: "http://localhost:11434/v1", keyEnv: null, local: true },
  lmstudio: { baseURL: "http://localhost:1234/v1", keyEnv: null, local: true },
};

/** Only HTTPS, except for servers on this machine (local models). */
export function assertSafeBaseUrl(url: string): void {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    throw new Error(`refusing non-HTTPS model endpoint ${u.origin}`);
}

export interface OpenAICompatibleOptions {
  preset: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  /** Price per million tokens, for budget enforcement; unknown models count as 0. */
  pricing?: { input: number; output: number };
  client?: OpenAI;
}

const EFFORT: Record<Effort, "low" | "medium" | "high"> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private readonly client: OpenAI;
  private readonly pricing: { input: number; output: number } | null;
  private reasoningSupported = true;

  constructor(opts: OpenAICompatibleOptions) {
    const preset = PRESETS[opts.preset];
    const baseURL = opts.baseURL ?? preset?.baseURL;
    if (!baseURL)
      throw new Error(
        `unknown provider preset "${opts.preset}"; use --base-url for a custom endpoint`,
      );
    if (!opts.model)
      throw new Error(
        `--model is required for ${opts.preset} (e.g. the model ID from the provider's docs)`,
      );
    assertSafeBaseUrl(baseURL);
    const apiKey =
      opts.apiKey ??
      (preset?.keyEnv ? process.env[preset.keyEnv] : undefined) ??
      (preset?.local ? "local" : undefined);
    if (!apiKey && !opts.client)
      throw new Error(`set ${preset?.keyEnv ?? "OPENAI_API_KEY"} for ${opts.preset}`);
    this.name = opts.preset;
    this.model = opts.model;
    this.pricing = opts.pricing ?? null;
    this.client =
      opts.client ?? new OpenAI({ apiKey, baseURL, maxRetries: 3, timeout: 10 * 60_000 });
  }

  private usage(role: Role, u: OpenAI.CompletionUsage | undefined, started: number): UsageEntry {
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    const input = (u?.prompt_tokens ?? 0) - cached;
    const output = u?.completion_tokens ?? 0;
    const cost = this.pricing
      ? ((input + cached) * this.pricing.input + output * this.pricing.output) / 1e6
      : 0;
    return {
      role,
      provider: this.name,
      model: this.model,
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cached,
      api_equivalent_usd: Number(cost.toFixed(6)),
      duration_ms: Date.now() - started,
    };
  }

  private async complete(
    body: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, "model">,
    effort: Effort,
  ) {
    const withEffort = this.reasoningSupported
      ? { ...body, reasoning_effort: EFFORT[effort] }
      : body;
    try {
      return await this.client.chat.completions.create({ model: this.model, ...withEffort });
    } catch (err) {
      // Many compatible servers do not accept reasoning_effort; retry once without it.
      if (
        this.reasoningSupported &&
        (err as { status?: number }).status === 400 &&
        /reasoning/i.test(String((err as Error).message))
      ) {
        this.reasoningSupported = false;
        return this.client.chat.completions.create({ model: this.model, ...body });
      }
      throw err;
    }
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const schema = z.toJSONSchema(req.schema as z.ZodType, { target: "draft-7" }) as Record<
      string,
      unknown
    >;
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `${req.system}\n\nRespond with one JSON object that validates against this JSON Schema:\n${JSON.stringify(schema)}`,
      },
      { role: "user", content: req.user },
    ];
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: OpenAI.ChatCompletion;
      try {
        res = await this.complete(
          {
            messages,
            response_format: {
              type: "json_schema",
              json_schema: { name: "output", schema, strict: false },
            },
            max_completion_tokens: 16_000,
          },
          req.effort,
        );
      } catch (err) {
        if ((err as { status?: number }).status !== 400) throw err;
        // Endpoint without JSON-schema support: plain JSON mode, validated below.
        res = await this.complete(
          { messages, response_format: { type: "json_object" }, max_completion_tokens: 16_000 },
          req.effort,
        );
      }
      const msg = res.choices[0]?.message;
      if (msg?.refusal) throw new RefusalError(null);
      const text = (msg?.content ?? "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "");
      try {
        const parsed = req.schema.safeParse(JSON.parse(text));
        if (parsed.success)
          return { data: parsed.data, usage: this.usage(req.role, res.usage, started) };
        lastError = parsed.error.message.slice(0, 400);
      } catch (err) {
        lastError = (err as Error).message.slice(0, 200);
      }
      messages.push(
        { role: "assistant", content: text },
        {
          role: "user",
          content: `That did not validate (${lastError}). Reply with corrected JSON only.`,
        },
      );
    }
    throw new Error(`structured output failed validation: ${lastError}`);
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    const deadline = started + (req.timeoutSec ?? 60 * 60) * 1000;
    const tools: ChatCompletionTool[] = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: z.toJSONSchema(t.input, { target: "draft-7" }) as Record<string, unknown>,
      },
    }));
    const byName = new Map(req.tools.map((t) => [t.name, t]));
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ];
    const usage: UsageEntry[] = [];
    const spent = () => usage.reduce((n, u) => n + u.api_equivalent_usd, 0);
    for (let turn = 0; turn < req.maxTurns; turn++) {
      if (Date.now() > deadline)
        return { finalText: "", stop: "error", usage, error: "time limit reached" };
      if (spent() >= req.budgetUsd) return { finalText: "", stop: "budget", usage };
      const t0 = Date.now();
      const res = await this.complete(
        { messages, tools, tool_choice: "auto", max_completion_tokens: 32_000 },
        req.effort,
      );
      usage.push(this.usage(req.role, res.usage, t0));
      const msg = res.choices[0]?.message;
      if (!msg) return { finalText: "", stop: "error", usage, error: "empty response" };
      if (msg.refusal) return { finalText: msg.refusal, stop: "refusal", usage };
      const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
      if (!calls.length) return { finalText: msg.content ?? "", stop: "completed", usage };
      messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const tool = byName.get(call.function.name);
        let result: string;
        if (!tool) result = `ERROR: unknown tool ${call.function.name}`;
        else {
          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = undefined;
          }
          const parsed = tool.input.safeParse(args);
          result = parsed.success
            ? await tool.run(parsed.data as never)
            : `ERROR: invalid arguments for ${tool.name}: ${parsed.error.message.slice(0, 300)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    return { finalText: "", stop: "max_turns", usage };
  }
}

/** Build any non-Anthropic API provider by preset name ("custom" needs a base URL). */
export function compatibleProvider(
  preset: string,
  model: string,
  baseURL?: string,
  apiKey?: string,
): OpenAICompatibleProvider {
  if (preset === "custom") {
    if (!baseURL) throw new Error("--provider custom needs --base-url");
    return new OpenAICompatibleProvider({
      preset: "custom",
      model,
      baseURL,
      apiKey: apiKey ?? process.env.OPENAI_API_KEY,
    });
  }
  return new OpenAICompatibleProvider({ preset, model, baseURL, apiKey });
}
