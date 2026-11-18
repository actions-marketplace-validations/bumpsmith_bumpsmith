import { AnthropicProvider } from "./anthropic.ts";
import { ClaudeCodeProvider } from "./claude-code.ts";
import { CodexProvider } from "./codex.ts";
import { compatibleProvider, PRESETS } from "./openai-compatible.ts";
import type { ModelProvider } from "./provider.ts";

/** The provider used when none is named: the API when a key is set, else the local subscription CLI. */
export function defaultProvider(): string {
  return process.env.ANTHROPIC_API_KEY ? "anthropic-api" : "claude-code";
}

export function provider(name: string, model?: string, baseURL?: string): ModelProvider {
  if (name in PRESETS || name === "custom") return compatibleProvider(name, model ?? "", baseURL);
  if (name === "anthropic-api") return new AnthropicProvider(model);
  if (name === "claude-code") return new ClaudeCodeProvider(model);
  if (name === "codex") return new CodexProvider(model);
  throw new Error(`unknown provider ${name}`);
}
