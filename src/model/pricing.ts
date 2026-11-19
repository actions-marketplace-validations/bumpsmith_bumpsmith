/**
 * Anthropic first-party list prices in USD per million tokens.
 * Source: Claude API reference bundled with Claude Code, cached 2026-11-03.
 * Re-check https://platform.claude.com/docs/en/about-claude/pricing before relying on totals.
 */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  /** 5-minute cache writes cost 1.25x input. */
  cacheWrite5m: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125 },
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite5m: 10 },
  // Models a server-side fallback can serve from (refusals-and-fallback docs, 2026-11-20).
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5 },
};

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES[model];
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** Cost at list price; returns NaN when the model has no known price. */
export function costUsd(model: string, u: TokenUsage): number {
  const p = priceFor(model);
  if (!p) return Number.NaN;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_read_input_tokens * p.cacheRead +
      u.cache_creation_input_tokens * p.cacheWrite5m) /
    1_000_000
  );
}
