import type { CheckCommand } from "../inventory/inventory.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import type { CheckName, CheckResult } from "../schemas/job.ts";

const TAIL = 6000;
/** Per-check limit (VER-7). */
export const CHECK_TIMEOUT_SEC = 15 * 60;

export class TimeBudgetExceeded extends Error {
  constructor() {
    super("job time budget exhausted");
    this.name = "TimeBudgetExceeded";
  }
}

/** Wall-clock budget for one job (VER-7: 45 minutes by default). */
export class Deadline {
  private readonly end: number;
  constructor(minutes: number) {
    this.end = Date.now() + minutes * 60_000;
  }
  remainingSec(): number {
    return Math.floor((this.end - Date.now()) / 1000);
  }
  /** Seconds a step may use: its own limit, capped by what is left of the job. */
  allow(limitSec: number): number {
    const left = this.remainingSec();
    if (left < 30) throw new TimeBudgetExceeded();
    return Math.min(limitSec, left);
  }
}

export async function runCheck(
  sb: Sandbox,
  check: CheckCommand,
  deadline?: Deadline,
): Promise<CheckResult> {
  const timeoutSec = deadline ? deadline.allow(CHECK_TIMEOUT_SEC) : CHECK_TIMEOUT_SEC;
  const r = await sb.execCheck(check.argv, {
    network: check.name === "install",
    timeoutSec,
    guardManifest: check.name !== "install",
  });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  return {
    name: check.name,
    command: check.argv.join(" "),
    exit_code: r.exitCode,
    passed: r.exitCode === 0,
    duration_ms: r.durationMs,
    timed_out: r.timedOut,
    output_tail: out.slice(-TAIL),
  };
}

/** Run checks in order (VER-4). Stops after a failed install, since later checks are meaningless. */
export async function runChecks(
  sb: Sandbox,
  checks: CheckCommand[],
  deadline?: Deadline,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const c of checks) {
    const res = await runCheck(sb, c, deadline);
    results.push(res);
    if (c.name === "install" && !res.passed) break;
  }
  return results;
}

export interface Comparison {
  name: CheckName;
  baseline: boolean | null;
  after: boolean | null;
  flaky: boolean;
  regression: boolean;
}

export interface Verdict {
  passed: boolean;
  comparisons: Comparison[];
  regressions: CheckName[];
  preexistingFailures: CheckName[];
}

/**
 * Pass rule (VER-5): no check that passed at baseline may fail after the change.
 * A newly failing check is rerun twice before it counts (VER-6).
 */
export async function compareWithBaseline(
  sb: Sandbox,
  checks: CheckCommand[],
  baseline: CheckResult[],
  after: CheckResult[],
  deadline?: Deadline,
): Promise<Verdict> {
  const comparisons: Comparison[] = [];
  for (const c of checks) {
    const b = baseline.find((x) => x.name === c.name);
    const a = after.find((x) => x.name === c.name);
    let flaky = false;
    let afterPassed = a ? a.passed : null;
    // A hang is not flakiness: only rerun checks that failed without timing out.
    if (b?.passed && a && !a.passed && !a.timed_out && c.name !== "install") {
      for (let i = 0; i < 2 && !afterPassed; i++) {
        const retry = await runCheck(sb, c, deadline);
        if (retry.passed) {
          afterPassed = true;
          flaky = true;
        }
      }
    }
    comparisons.push({
      name: c.name,
      baseline: b ? b.passed : null,
      after: afterPassed,
      flaky,
      regression: b?.passed === true && afterPassed !== true,
    });
  }
  const regressions = comparisons.filter((c) => c.regression).map((c) => c.name);
  return {
    passed:
      regressions.length === 0 && comparisons.every((c) => c.after !== null || c.baseline !== true),
    comparisons,
    regressions,
    preexistingFailures: comparisons.filter((c) => c.baseline === false).map((c) => c.name),
  };
}

/** Pull file paths out of compiler/test output so the agent may edit files that broke (FIX-3). */
export function filesFromOutput(output: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s(])((?:\.\/)?[\w@./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py))(?:[:(]\d+)/gm;
  for (const m of output.matchAll(re)) {
    const p = m[1]?.replace(/^\.\//, "").replace(/^\/workspace\//, "");
    if (p && !p.includes("node_modules/") && !p.startsWith("/")) out.add(p);
  }
  return [...out];
}
