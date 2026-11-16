import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import semver from "semver";
import { FIXER_PROMPT_VERSION, fixerUserPrompt, runFixerRound } from "./agent/fixer.ts";
import { EditPolicy, PolicyError } from "./agent/policy.ts";
import { buildTools, type ToolLog } from "./agent/tools.ts";
import { buildChangeRecord, EXTRACTOR_PROMPT_VERSION } from "./change/extract.ts";
import { commandArgv, type RepoConfig } from "./config/repo-config.ts";
import { buildImpactMap } from "./impact/impact.ts";
import { bumpFile, npmCompanions, npmDepInfo, npmUpgradeArgv } from "./inventory/bump.ts";
import { type Inventory, inventory } from "./inventory/inventory.ts";
import { Ledger } from "./model/ledger.ts";
import type { AgentStop, Effort, ModelProvider } from "./model/provider.ts";
import {
  checkMalicious,
  type GateResult,
  getRelease,
  npmPeerDependencies,
  npmPeerRanges,
  releaseGate,
} from "./registry/registry.ts";
import { renderEvidence } from "./report/evidence.ts";
import { computePatch, filterPatch, parsePatch, snapshot } from "./review/patch.ts";
import { REVIEWER_PROMPT_VERSION, type ReviewResult, review } from "./review/reviewer.ts";
import { applyRules, type RuleFinding } from "./review/rules.ts";
import { dockerSandboxFactory } from "./sandbox/docker.ts";
import type { Sandbox, SandboxFactory } from "./sandbox/sandbox.ts";
import type { ChangeRecord } from "./schemas/change-record.ts";
import type { CheckName, CheckResult, Ecosystem, ImpactMap, JobState } from "./schemas/job.ts";
import { runOk } from "./util/proc.ts";
import { containedPath } from "./util/safe-fs.ts";
import {
  compareWithBaseline,
  Deadline,
  filesFromOutput,
  runChecks,
  TimeBudgetExceeded,
  type Verdict,
} from "./verify/verify.ts";

export interface JobInput {
  repo: string; // local path or https git URL
  ref?: string;
  packageName: string;
  to: string;
  from?: string;
  ecosystem?: Ecosystem;
  /** Sub-directory of the package within the repository (monorepos), e.g. "packages/api". */
  dir?: string;
  /** Other packages upgraded in the same change (grouped Dependabot/Renovate updates). */
  alsoUpgrade?: { name: string; to: string }[];
}

export interface JobOptions {
  provider: ModelProvider;
  runsDir?: string;
  minReleaseAgeDays?: number;
  budgetUsd?: number;
  maxRounds?: number;
  maxTurnsPerRound?: number;
  effort?: Effort;
  /** Wall-clock budget for the whole job in minutes (VER-7). */
  jobMinutes?: number;
  refreshChangeRecord?: boolean;
  log?: (msg: string) => void;
  /** Effective repository config (.bumpsmith.yml from the default branch, safety-merged). */
  config?: RepoConfig;
  /** Maintainer review comments to address (review rounds, PR-8). */
  reviewerFeedback?: string;
  /** Use this id (the service's job id) instead of generating one. */
  jobId?: string;
  /** Where untrusted code runs (Docker locally, E2B micro-VMs in production). */
  sandboxFactory?: SandboxFactory;
}

export type ConfidenceBand = "high" | "medium" | "low";

export interface RoundRecord {
  round: number;
  stop: AgentStop;
  error?: string;
  summary: string;
  checks: CheckResult[];
}

export interface JobRecord {
  id: string;
  created_at: string;
  finished_at?: string;
  input: JobInput;
  provider: string;
  model: string;
  prompt_versions: Record<string, string>;
  state: JobState;
  from?: string;
  gate?: GateResult;
  change_record?: ChangeRecord;
  impact?: ImpactMap;
  baseline?: CheckResult[];
  after_bump?: CheckResult[];
  rounds: RoundRecord[];
  verdict?: Verdict;
  rules?: RuleFinding[];
  review?: ReviewResult;
  confidence?: ConfidenceBand;
  edits?: { path: string; allowlisted: boolean; reason: string | null }[];
  tool_log?: ToolLog[];
  usage?: Ledger["entries"];
  cost_usd?: number;
  duration_ms?: number;
  patch_lines?: number;
  error?: string;
  notes: string[];
}

async function prepareRepo(input: JobInput, dir: string): Promise<string> {
  const dest = join(dir, "repo");
  if (/^https:\/\//.test(input.repo)) {
    await runOk(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-recurse-submodules",
        "--filter=blob:none",
        input.repo,
        dest,
      ],
      { timeoutMs: 10 * 60_000 },
    );
    if (input.ref)
      await runOk("git", [
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        dest,
        "checkout",
        "--quiet",
        input.ref,
      ]);
  } else {
    await snapshot(resolve(input.repo), dest);
  }
  return dest;
}

/** "/packages/x/", "packages/x" -> "packages/x"; "/" or empty -> "". Refuses "..". */
export function normaliseSubdir(dir: string | undefined | null): string {
  const d = (dir ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!d || d === ".") return "";
  if (d.split("/").some((p) => p === ".." || p === "")) throw new Error(`invalid directory ${dir}`);
  return d;
}

async function currentVersion(inv: Inventory, pkg: string): Promise<string | null> {
  if (inv.ecosystem === "npm") {
    const lock = join(inv.root, "package-lock.json");
    if (existsSync(lock)) {
      const j = JSON.parse(await readFile(lock, "utf8")) as {
        packages?: Record<string, { version?: string }>;
      };
      const v = j.packages?.[`node_modules/${pkg}`]?.version;
      if (v) return v;
    }
  }
  const range = inv.dependencies[pkg] ?? inv.dependencies[pkg.toLowerCase()];
  if (!range) return null;
  return semver.minVersion(range.replace(/^==/, ""))?.version ?? null;
}

const PUBLIC_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
]);

/** First non-public registry host referenced by a lockfile, if any. */
export async function privateRegistryHost(
  repoDir: string,
  lockfiles: string[],
): Promise<string | null> {
  const isPrivate = (host: string) =>
    !PUBLIC_HOSTS.has(host) &&
    // git dependencies (github.com, codeload, raw) are handled separately; GitHub
    // Packages (npm.pkg.github.com) is a private registry.
    !/^(github\.com|codeload\.github\.com|.*\.githubusercontent\.com)$/.test(host);
  for (const f of lockfiles) {
    if (f.endsWith(".lockb")) continue;
    const text = await readFile(join(repoDir, f), "utf8");
    for (const m of text.matchAll(/(?:resolved|tarball)["':\s]+"?(https?:\/\/[^/"'\s]+)/g)) {
      const host = new URL(m[1] ?? "http://x").host;
      if (isPrivate(host)) return host;
    }
  }
  // Registry config: pnpm lockfiles carry no URLs, so scoped registries only show up here.
  for (const f of [".npmrc", ".yarnrc.yml", ".yarnrc"]) {
    let text: string;
    try {
      text = await readFile(join(repoDir, f), "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(
      /(?:registry|npmRegistryServer|npmPublishRegistry)["'\s]*[=:]\s*["']?(https?:\/\/[^/"'\s]+)/gi,
    )) {
      if (/npmPublishRegistry/i.test(m[0])) continue; // publishing only, not installs
      const host = new URL(m[1] ?? "http://x").host;
      if (isPrivate(host)) return host;
    }
  }
  return null;
}

/** Dependencies installed from git or a URL instead of a registry, which the sandbox cannot reach. */
export function nonRegistryDependencies(packageJsonText: string): string[] {
  const pkg = JSON.parse(packageJsonText) as Record<string, Record<string, string> | undefined>;
  const out: string[] = [];
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {}))
      if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:)|^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec))
        out.push(`${name} (${spec})`);
  }
  return out;
}

export function confidenceBand(r: {
  baseline: CheckResult[];
  verdict: Verdict;
  rules: RuleFinding[];
  review: ReviewResult | undefined;
  impact: ImpactMap;
}): ConfidenceBand {
  const hasTests = r.baseline.some((c) => c.name === "test");
  const baselineHealthy = r.baseline.every((c) => c.passed);
  const warns = r.rules.filter((f) => f.severity === "warn").length;
  if (!r.verdict.passed || r.review?.verdict !== "approve") return "low";
  // Behaviour changes are only as safe as the tests that exercise them.
  if (r.impact.upgrade_class === "human") return hasTests && baselineHealthy ? "medium" : "low";
  if (hasTests && baselineHealthy && warns === 0) return "high";
  return "medium";
}

/** Run one upgrade job end to end. Produces runs/<id>/{job.json, patch.diff, evidence.md}. */
export async function runJob(input: JobInput, opts: JobOptions): Promise<JobRecord> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const id =
    opts.jobId ??
    `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomUUID().slice(0, 6)}`;
  const dir = join(opts.runsDir ?? join(process.cwd(), "runs"), id);
  await mkdir(dir, { recursive: true });
  const ledger = new Ledger(opts.budgetUsd ?? 8);
  const job: JobRecord = {
    id,
    created_at: new Date().toISOString(),
    input,
    provider: opts.provider.name,
    model: opts.provider.model,
    prompt_versions: {
      extractor: EXTRACTOR_PROMPT_VERSION,
      fixer: FIXER_PROMPT_VERSION,
      reviewer: REVIEWER_PROMPT_VERSION,
    },
    state: "detected",
    rounds: [],
    notes: [],
  };
  const save = async () => {
    job.usage = ledger.entries;
    job.cost_usd = Number(ledger.totalUsd.toFixed(4));
    job.duration_ms = Date.now() - started;
    await writeFile(join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  };

  let sb: Sandbox | null = null;
  const deadline = new Deadline(opts.jobMinutes ?? 45);
  const minAge = Math.max(3, opts.config?.release_age_days ?? opts.minReleaseAgeDays ?? 3);
  try {
    log(`job ${id}: preparing repository`);
    const repoRoot = await prepareRepo(input, dir);
    const sub = normaliseSubdir(input.dir);
    const repoDir = sub ? containedPath(repoRoot, sub) : repoRoot;
    if (!existsSync(repoDir)) throw new Error(`directory ${sub} does not exist in the repository`);
    const inv = await inventory(repoDir);
    if (sub) {
      // Checks and the version bump run in the package's own directory.
      for (const c of inv.checks) c.cwd = `/workspace/${sub}`;
      const sharesRootLock =
        inv.ecosystem === "npm" &&
        !inv.lockfiles.length &&
        ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"].some((f) =>
          existsSync(join(repoRoot, f)),
        );
      if (sharesRootLock) {
        job.state = "blocked_policy";
        job.notes.push(
          `Unsupported (for now): ${sub} is a workspace member that shares the repository's root lockfile. Packages with their own lockfile in a sub-directory are supported.`,
        );
        return job;
      }
    }
    // Configured check commands replace detected ones (argv only, validated in config).
    for (const [name, cmd] of Object.entries(opts.config?.checks ?? {})) {
      if (!cmd) continue;
      const argv = commandArgv(cmd);
      const existing = inv.checks.find((c) => c.name === name);
      if (existing) existing.argv = argv;
      else inv.checks.push({ name: name as CheckName, argv });
    }
    const eco = input.ecosystem ?? inv.ecosystem;
    const from = input.from ?? (await currentVersion(inv, input.packageName));
    if (!from) throw new Error(`${input.packageName} is not a dependency of this repository`);
    job.from = from;

    // Phase 0 sandboxes can only reach the public registries.
    const privateHost = eco === "npm" ? await privateRegistryHost(repoDir, inv.lockfiles) : null;
    if (privateHost) {
      job.state = "blocked_policy";
      job.notes.push(
        `Unsupported: the lockfile installs packages from a private registry (${privateHost}). Sandboxes only reach the public npm registry.`,
      );
      return job;
    }
    if (eco === "npm") {
      const gitDeps = nonRegistryDependencies(
        await readFile(join(repoDir, "package.json"), "utf8"),
      );
      if (gitDeps.length) {
        job.state = "blocked_policy";
        job.notes.push(
          `Unsupported: dependencies installed from git or a URL (${gitDeps.join(", ")}). Sandboxes only reach the public npm registry.`,
        );
        return job;
      }
    }
    // Preflight before any model spend: the sandbox must be able to run this repo.
    const nodeWanted = Number(/(\d+)/.exec(inv.runtime.node ?? "")?.[1] ?? 0);
    if (eco === "npm" && nodeWanted > 24) {
      job.state = "blocked_policy";
      job.notes.push(
        `Unsupported: the repo requires Node ${inv.runtime.node}; sandboxes provide Node 22 and 24.`,
      );
      return job;
    }

    // Release gate (CHG-9, CHG-10)
    const rel = await getRelease(eco, input.packageName, input.to);
    const mal = await checkMalicious(eco, input.packageName, input.to);
    job.gate = releaseGate(rel, mal, minAge);
    if (!job.gate.allowed) {
      job.state = job.gate.reasons.some((r) => r.startsWith("published"))
        ? "waiting_release_age"
        : "blocked_policy";
      job.notes.push(...job.gate.reasons);
      return job;
    }

    // Change intelligence + impact (public data + host-side parsing only)
    log(`job ${id}: building Change Record ${input.packageName} ${from} -> ${input.to}`);
    job.change_record = await buildChangeRecord({
      ecosystem: eco,
      name: input.packageName,
      from,
      to: input.to,
      repositoryUrl: rel.repositoryUrl,
      provider: opts.provider,
      ledger,
      refresh: opts.refreshChangeRecord,
    });
    job.impact = await buildImpactMap(repoDir, eco, input.packageName, job.change_record);
    if (sub) for (const it of job.impact.items) it.file = `${sub}/${it.file}`;
    job.state = "analysed";
    log(`job ${id}: ${job.impact.items.length} impact item(s), class ${job.impact.upgrade_class}`);

    // Sandbox: baseline
    sb = await (opts.sandboxFactory ?? dockerSandboxFactory)({
      ecosystem: eco,
      nodeMajor: inv.nodeMajor,
      label: id,
    });
    await sb.copyIn(repoRoot);
    const wd = sub ? `/workspace/${sub}` : undefined;
    log(`job ${id}: baseline checks`);
    job.baseline = await runChecks(sb, inv.checks, deadline);
    if (!job.baseline.find((c) => c.name === "install")?.passed)
      job.notes.push(
        "Baseline install failed; running in limited mode (static checks only, draft output).",
      );
    // A check that cannot finish within its limit at baseline cannot verify anything later.
    const timedOut = job.baseline.filter((c) => c.timed_out).map((c) => c.name);
    const checks = inv.checks.filter((c) => !timedOut.includes(c.name));
    if (timedOut.length)
      job.notes.push(`Skipped checks that timed out at baseline: ${timedOut.join(", ")}.`);

    // Bump the version inside the sandbox
    const manifest =
      eco === "npm"
        ? "package.json"
        : (inv.manifests.find((m) => m.endsWith(".txt")) ?? "pyproject.toml");
    const cur = await sb.exec(["cat", "--", manifest], { cwd: wd });
    if (eco === "npm") {
      const info = npmDepInfo(cur.stdout, input.packageName);
      if (!info) throw new Error(`could not find ${input.packageName} in ${manifest}`);
      const before = new Date(Date.now() - minAge * 86_400_000);
      const workspaceRoot =
        existsSync(join(repoDir, "pnpm-workspace.yaml")) || inv.workspaces.length > 0;
      // Companions must exist at the target version and pass the same release gate.
      const companions: string[] = [];
      for (const c of npmCompanions(cur.stdout, input.packageName, from)) {
        try {
          const crel = await getRelease("npm", c, input.to);
          const cgate = releaseGate(crel, await checkMalicious("npm", c, input.to), minAge);
          if (cgate.allowed) companions.push(c);
        } catch {
          // no such version of the companion; leave it alone
        }
      }
      // Grouped updates: every extra package must pass the same release gate.
      for (const extra of input.alsoUpgrade ?? []) {
        try {
          const xrel = await getRelease("npm", extra.name, extra.to);
          const xgate = releaseGate(
            xrel,
            await checkMalicious("npm", extra.name, extra.to),
            minAge,
          );
          if (xgate.allowed) companions.push(`${extra.name}@${extra.to}`);
          else
            job.notes.push(
              `Not upgraded with the group: ${extra.name}@${extra.to} (${xgate.reasons.join("; ")}).`,
            );
        } catch (err) {
          job.notes.push(
            `Not upgraded with the group: ${extra.name}@${extra.to} (${(err as Error).message.slice(0, 120)}).`,
          );
        }
      }
      if (companions.length)
        job.notes.push(`Upgraded together with ${input.packageName}: ${companions.join(", ")}.`);
      let up = await sb.exec(
        npmUpgradeArgv(
          inv.packageManager,
          input.packageName,
          input.to,
          info,
          before,
          workspaceRoot,
          companions,
        ),
        { network: true, timeoutSec: 15 * 60, cwd: wd },
      );
      if (up.exitCode !== 0 && inv.packageManager === "npm") {
        job.notes.push(
          "npm could not apply the release-age limit to transitive dependencies (--before); installed without it.",
        );
        up = await sb.exec(
          npmUpgradeArgv(
            "npm",
            input.packageName,
            input.to,
            info,
            before,
            false,
            companions,
          ).filter((a) => !a.startsWith("--before")),
          { network: true, timeoutSec: 15 * 60, cwd: wd },
        );
      }
      if (up.exitCode !== 0)
        throw new Error(
          `could not install ${input.packageName}@${input.to}: ${(up.stderr || up.stdout).slice(-1500)}`,
        );
    } else {
      const first = bumpFile(eco, manifest, cur.stdout, input.packageName, input.to);
      if (!first) throw new Error(`could not find ${input.packageName} in ${manifest}`);
      let bumped: string = first;
      for (const extra of input.alsoUpgrade ?? []) {
        const xrel = await getRelease("pypi", extra.name, extra.to).catch(() => null);
        const ok =
          xrel &&
          releaseGate(xrel, await checkMalicious("pypi", extra.name, extra.to), minAge).allowed;
        const next: string | null = ok
          ? bumpFile(eco, manifest, bumped, extra.name, extra.to)
          : null;
        if (next) bumped = next;
        else job.notes.push(`Not upgraded with the group: ${extra.name}@${extra.to}.`);
      }
      await sb.exec(["sh", "-c", 'cat > "$1"', "sh", manifest], { input: bumped, cwd: wd });
    }
    job.after_bump = await runChecks(sb, checks, deadline);
    job.state = "verifying";
    let verdict = await compareWithBaseline(sb, checks, job.baseline, job.after_bump, deadline);

    // Fix loop (FIX-1..8)
    const allow = new Set<string>([
      ...inv.manifests,
      ...inv.lockfiles,
      ...job.impact.items.map((i) => i.file),
    ]);
    for (const c of job.after_bump)
      if (!c.passed) for (const f of filesFromOutput(c.output_tail)) allow.add(f);
    const policy = new EditPolicy(allow, opts.config?.rules.protected_paths ?? []);
    const toolLog: ToolLog[] = [];
    const tools = buildTools({
      sandbox: sb,
      policy,
      checks,
      log: toolLog,
      remainingSec: () => deadline.remainingSec(),
      baselineMs: Object.fromEntries(job.baseline.map((c) => [c.name, c.duration_ms])),
    });
    const peers = eco === "npm" ? await npmPeerRanges(input.packageName, input.to) : {};
    let lastChecks = job.after_bump;
    let previous: string | null = null;
    const needsFix = !verdict.passed || job.impact.items.length > 0;
    const maxRounds = opts.maxRounds ?? 3;
    for (let round = 1; needsFix && round <= maxRounds; round++) {
      if (ledger.exhausted) {
        job.notes.push(`Spend cap of $${ledger.capUsd} reached before round ${round}.`);
        break;
      }
      if (deadline.remainingSec() < 5 * 60) {
        job.notes.push(`Time budget nearly used up before round ${round}; stopping.`);
        break;
      }
      job.state = "fixing";
      log(`job ${id}: fixer round ${round} (spent $${ledger.totalUsd.toFixed(2)})`);
      const res = await runFixerRound({
        provider: opts.provider,
        ledger,
        tools,
        user: fixerUserPrompt({
          inv,
          pkg: input.packageName,
          from,
          to: input.to,
          record: job.change_record,
          impact: job.impact,
          failing: lastChecks,
          round,
          previousSummary: previous,
          peers,
          reviewerFeedback: opts.reviewerFeedback ?? null,
        }),
        effort: opts.effort ?? "high",
        maxTurns: opts.maxTurnsPerRound ?? 40,
        // Leave time for trusted re-verification after the round.
        timeoutSec: Math.max(120, deadline.remainingSec() - 4 * 60),
      });
      // Trusted re-verification, independent of what the agent claims.
      job.state = "verifying";
      lastChecks = await runChecks(sb, checks, deadline);
      for (const c of lastChecks)
        if (!c.passed) for (const f of filesFromOutput(c.output_tail)) policy.addAllowed(f);
      verdict = await compareWithBaseline(sb, checks, job.baseline, lastChecks, deadline);
      job.rounds.push({
        round,
        stop: res.stop,
        error: res.error,
        summary: res.finalText,
        checks: lastChecks,
      });
      previous = res.finalText;
      await save();
      if (res.stop === "refusal") {
        job.notes.push("The model declined the request.");
        break;
      }
      if (verdict.passed) break;
    }
    job.verdict = verdict;
    job.edits = [...policy.edits.values()];
    job.tool_log = toolLog;

    // Patch on the trusted host
    await sb.copyOut(join(dir, "after"));
    await snapshot(repoRoot, join(dir, "before"));
    const fullPatch = await computePatch(dir, "before", "after");
    // Only the version bump, lockfiles and files the agent edited through its tools go in
    // the patch. Anything else that changed (build output, caches) was produced by
    // running checks and is excluded.
    const inSub = (f: string) => (sub ? `${sub}/${f}` : f);
    const keep = new Set<string>([
      ...inv.manifests.map(inSub),
      ...inv.lockfiles.map(inSub),
      ...[
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "bun.lock",
        "uv.lock",
        "poetry.lock",
      ].map(inSub),
      ...policy.edits.keys(),
    ]);
    const { patch, excluded } = filterPatch(fullPatch, (p) => keep.has(p));
    if (excluded.length)
      job.notes.push(
        `Excluded files changed by builds or tests, not by the fix: ${excluded.join(", ")}.`,
      );
    await writeFile(join(dir, "patch.diff"), patch);
    const files = parsePatch(patch);
    job.patch_lines = files.reduce((n, f) => n + f.added.length + f.removed.length, 0);

    // Diff rules + independent review
    job.state = "reviewing";
    job.rules = applyRules({
      ecosystem: eco,
      packageName: input.packageName,
      files,
      record: job.change_record,
      edits: job.edits,
      peerDependencies: eco === "npm" ? await npmPeerDependencies(input.packageName, input.to) : [],
      protectedPaths: opts.config?.rules.protected_paths ?? [],
    });
    if (patch.trim() && !ledger.exhausted) {
      job.review = await review({
        provider: opts.provider,
        ledger,
        patch,
        record: job.change_record,
        impact: job.impact,
        agentSummary: job.rounds.map((r) => r.summary).join("\n\n---\n\n"),
        checks: verdict.comparisons,
        agentEditedFiles: [...policy.edits.keys()],
        ruleWarnings: job.rules.filter((r) => r.severity === "warn"),
      });
    }
    job.confidence = confidenceBand({
      baseline: job.baseline,
      verdict,
      rules: job.rules,
      review: job.review,
      impact: job.impact,
    });

    if (job.rules.some((r) => r.severity === "block")) job.state = "blocked_policy";
    else if (!verdict.passed) job.state = "needs_human";
    else if (!patch.trim()) job.state = "safe";
    else if (job.review && job.review.verdict !== "approve") job.state = "needs_human";
    else job.state = "ready";
    return job;
  } catch (err) {
    job.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (err instanceof TimeBudgetExceeded)
      job.notes.push("Stopped: the job's time budget ran out.");
    job.state =
      err instanceof PolicyError
        ? "blocked_policy"
        : err instanceof TimeBudgetExceeded
          ? "needs_human"
          : "failed_infra";
    return job;
  } finally {
    if (sb) await sb.destroy();
    job.finished_at = new Date().toISOString();
    await save();
    await writeFile(join(dir, "evidence.md"), renderEvidence(job));
    log(
      `job ${id}: ${job.state} (confidence ${job.confidence ?? "n/a"}, $${ledger.totalUsd.toFixed(2)}) -> ${dir}`,
    );
  }
}
