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
    cwd: check.cwd,
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
  /**
   * The check failed both times, but test by test: the same tests failed before and after,
   * and some passed. The upgrade broke nothing those tests can see.
   */
  sameFailures?: { failing: string[]; passed: number };
  /** Tests that passed before the upgrade and fail after it. */
  newFailures?: string[];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * Failing test IDs and the number of passing tests, read from runner output (pytest,
 * vitest, jest, mocha, TAP / node:test). null when the output is not recognisable.
 */
export function parseTestResults(output: string): { failing: Set<string>; passed: number } | null {
  const text = output.replace(ANSI, "");
  const failing = new Set<string>();
  const clean = (s: string) =>
    s
      .replace(/\s+\(?\d+(\.\d+)?\s*m?s\)?\s*$/, "")
      .replace(/\s+-\s.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  for (const line of text.split("\n")) {
    let m = /^(?:FAILED|ERROR) (\S+)/.exec(line); // pytest -rfE summary
    if (!m) m = /^\s*(?:FAIL|×|✕|✗)\s+(\S.*\S)\s*$/.exec(line); // vitest / jest
    if (!m) m = /^\s*● (\S.*›.*)$/.exec(line); // jest failure headers
    if (!m) m = /^\s*not ok \d+ (?:- )?(.+)$/.exec(line); // TAP, node:test
    if (!m) m = /^\s{2,}\d+\) (\S.*)$/.exec(line); // mocha
    if (m?.[1]) failing.add(clean(m[1]));
  }
  const counts = [
    /(\d+) passed/.exec(text),
    /(\d+) passing/.exec(text),
    /^# pass (\d+)/m.exec(text),
    /^ℹ pass (\d+)/m.exec(text),
  ].filter(Boolean) as RegExpExecArray[];
  if (!counts.length || !failing.size) return null;
  return { failing, passed: Math.max(...counts.map((c) => Number(c[1]))) };
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
    const cmp: Comparison = {
      name: c.name,
      baseline: b ? b.passed : null,
      after: afterPassed,
      flaky,
      regression: b?.passed === true && afterPassed !== true,
    };
    // Already failing before the upgrade: compare test by test instead of pass/fail.
    if (c.name === "test" && b && a && !b.passed && !afterPassed && !b.timed_out && !a.timed_out) {
      const before = parseTestResults(b.output_tail);
      const now = parseTestResults(a.output_tail);
      if (before && now) {
        const added = [...now.failing].filter((t) => !before.failing.has(t));
        if (added.length) {
          cmp.newFailures = added.slice(0, 20);
          cmp.regression = true;
        } else if (now.passed > 0 && now.passed >= before.passed)
          cmp.sameFailures = { failing: [...now.failing].slice(0, 20), passed: now.passed };
      }
    }
    comparisons.push(cmp);
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
