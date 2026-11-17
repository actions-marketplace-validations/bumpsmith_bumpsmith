import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelProvider } from "../model/provider.ts";
import { type JobRecord, runJob } from "../pipeline.ts";
import { parsePatch } from "../review/patch.ts";
import type { BenchTask } from "./mine.ts";

export interface TaskOutcome {
  task: string;
  pr_url: string;
  package: string;
  upgrade: string;
  state: string;
  confidence: string | null;
  solved: boolean;
  /** Share of the human fix's source files that our patch also changed. */
  overlap_with_human: number | null;
  rule_blocks: number;
  cost_usd: number;
  minutes: number;
  job_id: string;
  error: string | null;
}

async function overlap(job: JobRecord, runsDir: string, human: string[]): Promise<number | null> {
  if (!human.length) return null;
  try {
    const patch = await readFile(join(runsDir, job.id, "patch.diff"), "utf8");
    const ours = new Set(parsePatch(patch).map((f) => f.path));
    return human.filter((f) => ours.has(f)).length / human.length;
  } catch {
    return null;
  }
}

/** Run benchmark tasks sequentially and write a results file (Phase 0 gate metrics). */
export async function runBench(opts: {
  tasks: BenchTask[];
  provider: ModelProvider;
  outDir: string;
  budgetUsd: number;
  log: (m: string) => void;
}): Promise<{ outcomes: TaskOutcome[]; file: string }> {
  await mkdir(opts.outDir, { recursive: true });
  const runsDir = join(opts.outDir, "runs");
  const file = join(opts.outDir, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const outcomes: TaskOutcome[] = [];
  for (const [i, t] of opts.tasks.entries()) {
    opts.log(`[${i + 1}/${opts.tasks.length}] ${t.id}: ${t.packageName} ${t.from} -> ${t.to}`);
    const job = await runJob(
      {
        repo: t.repo,
        ref: t.ref,
        packageName: t.packageName,
        from: t.from,
        to: t.to,
        ecosystem: t.ecosystem,
      },
      { provider: opts.provider, runsDir, budgetUsd: opts.budgetUsd, log: opts.log },
    );
    if (job.error?.startsWith("UsageLimitError") || job.error?.startsWith("SignInError")) {
      // Not the task's fault: stop instead of burning the remaining tasks against a closed
      // limit or an expired sign-in.
      const why = job.error.startsWith("SignInError")
        ? "sign-in expired"
        : "model usage limit reached";
      opts.log(`stopping: ${why} at ${t.id}; re-run the rest with --only`);
      break;
    }
    const outcome: TaskOutcome = {
      task: t.id,
      pr_url: t.pr_url,
      package: t.packageName,
      upgrade: `${t.from} -> ${t.to}`,
      state: job.state,
      confidence: job.confidence ?? null,
      solved: job.state === "ready",
      overlap_with_human: await overlap(job, runsDir, t.human_files),
      rule_blocks: (job.rules ?? []).filter((r) => r.severity === "block").length,
      cost_usd: job.cost_usd ?? 0,
      minutes: Number(((job.duration_ms ?? 0) / 60_000).toFixed(1)),
      job_id: job.id,
      error: job.error ?? null,
    };
    outcomes.push(outcome);
    await writeFile(
      file,
      `${JSON.stringify({ provider: opts.provider.name, model: opts.provider.model, outcomes, summary: summarise(outcomes) }, null, 2)}\n`,
    );
  }
  return { outcomes, file };
}

export function summarise(o: TaskOutcome[]) {
  const attempted = o.filter(
    (x) => x.state !== "failed_infra" && x.state !== "waiting_release_age",
  );
  const solved = o.filter((x) => x.solved);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const states: Record<string, number> = {};
  for (const x of o) states[x.state] = (states[x.state] ?? 0) + 1;
  return {
    tasks: o.length,
    attempted: attempted.length,
    solved: solved.length,
    solve_rate: attempted.length ? Number((solved.length / attempted.length).toFixed(3)) : 0,
    states,
    rule_blocks: sum(o.map((x) => x.rule_blocks)),
    total_cost_usd: Number(sum(o.map((x) => x.cost_usd)).toFixed(2)),
    cost_per_solved_usd: solved.length
      ? Number((sum(o.map((x) => x.cost_usd)) / solved.length).toFixed(2))
      : null,
    median_minutes: o.length
      ? [...o.map((x) => x.minutes)].sort((a, b) => a - b)[Math.floor(o.length / 2)]
      : null,
  };
}
