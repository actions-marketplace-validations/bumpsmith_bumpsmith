import type { UsageEntry } from "../schemas/job.ts";

/** Collects every model call in a job and enforces the per-job spend cap (FIX-8). */
export class Ledger {
  readonly entries: UsageEntry[] = [];
  constructor(readonly capUsd: number) {}

  add(entry: UsageEntry): void {
    this.entries.push(entry);
  }

  get totalUsd(): number {
    return this.entries.reduce(
      (sum, e) => sum + (Number.isNaN(e.api_equivalent_usd) ? 0 : e.api_equivalent_usd),
      0,
    );
  }

  get remainingUsd(): number {
    return Math.max(0, this.capUsd - this.totalUsd);
  }

  get exhausted(): boolean {
    return this.totalUsd >= this.capUsd;
  }

  summary(): Record<string, { calls: number; usd: number; input: number; output: number }> {
    const out: Record<string, { calls: number; usd: number; input: number; output: number }> = {};
    for (const e of this.entries) {
      const s = out[e.role] ?? { calls: 0, usd: 0, input: 0, output: 0 };
      out[e.role] = s;
      s.calls += 1;
      s.usd += Number.isNaN(e.api_equivalent_usd) ? 0 : e.api_equivalent_usd;
      s.input += e.input_tokens + e.cache_creation_input_tokens + e.cache_read_input_tokens;
      s.output += e.output_tokens;
    }
    return out;
  }
}
