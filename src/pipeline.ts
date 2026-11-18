import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import semver from "semver";
import { FIXER_PROMPT_VERSION, fixerUserPrompt, runFixerRound } from "./agent/fixer.ts";
import { EditPolicy, PolicyError } from "./agent/policy.ts";
import { buildTools, type ToolLog } from "./agent/tools.ts";
import { buildChangeRecord, EXTRACTOR_PROMPT_VERSION } from "./change/extract.ts";
import { commandArgv, type RepoConfig } from "./config/repo-config.ts";
import { buildImpactMap } from "./impact/impact.ts";
import {
  bumpFile,
  compareVersions,
  lockedVersions,
  lockfileUpdateArgv,
  npmCompanions,
  npmDepInfo,
  npmUpgradeArgv,
} from "./inventory/bump.ts";
import {
  type Inventory,
  inventory,
  nestedPythonManifestsDeclaring,
  workspaceMembersDeclaring,
} from "./inventory/inventory.ts";
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
import {
  fetchGitDeps,
  gitDependencies,
  installGitDeps,
  readManifests,
} from "./sandbox/git-deps.ts";
import type { Sandbox, SandboxFactory } from "./sandbox/sandbox.ts";
import { detectServices } from "./sandbox/services.ts";
import type { ChangeRecord } from "./schemas/change-record.ts";
import type { CheckName, CheckResult, Ecosystem, ImpactMap, JobState } from "./schemas/job.ts";
import { runOk } from "./util/proc.ts";
import { containedPath } from "./util/safe-fs.ts";
import {
  CHECK_TIMEOUT_SEC,
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
  /**
   * Model-free dry run for compatibility testing: inventory, baseline checks, the version
   * bump and the checks after it, then stop. No Change Record, fixer or review.
   */
  setupOnly?: boolean;
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
    // Clones fail transiently (HTTP/2 stream resets, 5xx): retry, the last time over HTTP/1.1.
    for (let attempt = 1; ; attempt++) {
      try {
        await runOk(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            ...(attempt === 3 ? ["-c", "http.version=HTTP/1.1"] : []),
            "clone",
            "--no-recurse-submodules",
            "--filter=blob:none",
            input.repo,
            dest,
          ],
          { timeoutMs: 10 * 60_000 },
        );
        break;
      } catch (err) {
        await rm(dest, { recursive: true, force: true });
        if (
          attempt >= 3 ||
          /not found|Authentication failed|could not read Username/i.test(String(err))
        )
          throw err;
        await new Promise((r) => setTimeout(r, attempt * 5000));
      }
    }
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
    try {
      const lock = join(inv.root, "package-lock.json");
      if (existsSync(lock)) {
        const j = JSON.parse(await readFile(lock, "utf8")) as {
          packages?: Record<string, { version?: string }>;
        };
        const v = j.packages?.[`node_modules/${pkg}`]?.version;
        if (v) return v;
      }
    } catch {
      // unreadable lockfile: fall back to the declared range
    }
  }
  const range =
    inv.dependencies[pkg] ??
    inv.dependencies[pkg.toLowerCase()] ??
    inv.dependencies[pkg.toLowerCase().replace(/[-_.]+/g, "-")] ??
    inv.dependencies[pkg.toLowerCase().replace(/[-_.]+/g, "_")];
  if (range === undefined) return null;
  return lowestVersion(range);
}

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "pdm.lock",
];

/** Lockfile texts in these directories (first match per name wins). */
async function lockTexts(dirs: string[]): Promise<string> {
  const parts: string[] = [];
  for (const d of dirs)
    for (const f of LOCKFILES) {
      try {
        parts.push(await readFile(join(d, f), "utf8"));
      } catch {
        // no such lockfile
      }
    }
  return parts.join("\n");
}

/** The range a manifest declares for `pkg` (lockfiles not consulted), if any. */
function lowestVersionDeclared(inv: Inventory, pkg: string): string | undefined {
  const lower = pkg.toLowerCase();
  return (
    inv.dependencies[pkg] ??
    inv.dependencies[lower] ??
    inv.dependencies[lower.replace(/[-_.]+/g, "-")] ??
    inv.dependencies[lower.replace(/[-_.]+/g, "_")]
  );
}

/** Lowest version a declared range admits, for npm and Python styles; null if none is named. */
export function lowestVersion(range: string): string | null {
  const r = range.trim().replace(/^(==|===|~=)/, "");
  try {
    const v = semver.minVersion(r)?.version;
    if (v) return v;
  } catch {
    // not an npm range (">=1.2,<2", "~=1.4", "1.2.*")
  }
  const first = /(\d+(?:\.\d+){0,2})/.exec(r)?.[1];
  return first ? (semver.coerce(first)?.version ?? null) : null;
}

/**
 * Plain words for errors that end a job early, so every outcome says why. The raw error
 * stays in job.error for debugging.
 */
export function explainError(message: string): string {
  if (/is not a dependency of this repository/.test(message))
    return "The package is not declared in this directory's manifest; for a monorepo, pass the package's directory (--dir).";
  if (/No supported manifest found/.test(message))
    return "No package.json, pyproject.toml, setup.py, Pipfile or requirements file was found in this directory.";
  if (/is not valid JSON/.test(message)) return `${message.replace(/^Error: /, "")}.`;
  if (/could not install .*ETARGET|No matching version|notarget/i.test(message))
    return "The target version is not on the registry.";
  if (/could not install/.test(message))
    return "The package manager could not apply the version bump; the output is in the job record.";
  if (/could not find .* in /.test(message))
    return "The package is declared in a form Bumpsmith cannot rewrite yet (for example a URL or a file path).";
  if (/clone|Repository not found|exit code 128/i.test(message))
    return "The repository could not be cloned (private, deleted, or too large).";
  if (/exit code 137|OOM|out of memory/i.test(message)) return "The machine ran out of memory.";
  if (/Cannot connect to the Docker daemon|docker: not found|ENOENT.*docker/i.test(message))
    return "Docker is not running; Bumpsmith needs Docker for its sandbox.";
  if (/404|not found on (npm|pypi)|registry/i.test(message))
    return "The package or version could not be found on the public registry.";
  return "An unexpected error stopped the job; the details are in the job record.";
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

/** Plain-words reason for the common ways a dependency install fails in the sandbox. */
export function installFailureReason(baseline: CheckResult[]): string {
  const out = baseline.find((c) => c.name === "install")?.output_tail ?? "";
  if (
    /Could not resolve host: (github\.com|gitlab\.com|bitbucket\.org)|git fetch|git clone/i.test(
      out,
    )
  )
    return " (a dependency is fetched from a git repository that is private or not on GitHub, GitLab, Bitbucket or Codeberg; the sandbox cannot reach it)";
  if (/No space left on device|ENOSPC/.test(out))
    return " (the dependencies are larger than the sandbox disk limit, e.g. GPU builds of torch)";
  if (/E401|E403|401 Unauthorized|403 Forbidden|authentication required/i.test(out))
    return " (a private registry needs credentials; configure registries in .bumpsmith.yml)";
  const failedBuild =
    /Failed to build '?([\w.-]+)'?|Failed to build wheel for ([\w.-]+)|failed to build `?([\w.-]+)/i.exec(
      out,
    );
  if (failedBuild && !/fatal error: [\w/.-]+\.h: No such file/.test(out))
    return ` (${failedBuild[1] ?? failedBuild[2] ?? failedBuild[3]} has no prebuilt package for this Python and platform, and building it from source failed; a newer version of it usually ships prebuilt packages)`;
  if (/fatal error: [\w/.-]+\.h: No such file/.test(out))
    return " (a package is built from source and needs a system library the sandbox does not have)";
  if (
    /no wheels with a matching platform tag|Wheels are available for .* on the following platforms|Unsupported platform|EBADPLATFORM/i.test(
      out,
    )
  )
    return ` (a pinned package has no build for this machine's CPU (${process.arch}); it installs on x86_64 machines such as GitHub Actions runners)`;
  if (/No solution found when resolving|ResolutionImpossible|unsatisfiable/i.test(out))
    return " (the repository's pinned requirements cannot be resolved together)";
  if (/ERESOLVE|conflicting peer dependency/i.test(out))
    return " (the repository's own dependencies conflict before the upgrade)";
  if (/timed out|ETIMEDOUT/i.test(out) || baseline.some((c) => c.name === "install" && c.timed_out))
    return " (it did not finish within the time limit)";
  return "";
}

/** Plain words for checks that already fail before the upgrade, when the cause is recognisable. */
export function checkFailureReason(baseline: CheckResult[]): string | null {
  const failing = baseline.filter((c) => c.name !== "install" && !c.passed && !c.timed_out);
  if (!failing.length) return null;
  const out = failing.map((c) => c.output_tail).join("\n");
  const names = failing.map((c) => c.name).join(", ");
  if (
    /ECONNREFUSED[^\n]*:(5432|3306|6379|27017)|could not connect to server|Connection refused[^\n]*(5432|3306|6379|27017)|OperationalError: (connection|could not connect)|Can't connect to MySQL|Error 111 connecting|ServerSelectionTimeoutError|redis\.exceptions\.ConnectionError/i.test(
      out,
    )
  )
    return `Before the upgrade, ${names} already failed because the tests need a database or cache that the CI workflow does not declare as a service; declare it under services: in the workflow, or set checks in .bumpsmith.yml.`;
  if (
    /Could not resolve host|getaddrinfo (ENOTFOUND|EAI_AGAIN)|Temporary failure in name resolution|network is unreachable/i.test(
      out,
    )
  )
    return `Before the upgrade, ${names} already failed because it downloads from the internet while running, which the sandbox does not allow; Bumpsmith verifies with the other checks.`;
  if (/ModuleNotFoundError|Cannot find module|ERR_MODULE_NOT_FOUND/.test(out))
    return `Before the upgrade, ${names} already failed: a module is missing (often a package installed only in CI, or a generated file).`;
  if (/command not found|not found: |ENOENT.*spawn/i.test(out))
    return `Before the upgrade, ${names} already failed: a program the check calls is not installed in the sandbox.`;
  if (
    /(API|SECRET|TOKEN|KEY)[A-Z_]* (is )?(not set|missing|required)|KeyError: '[A-Z_]+'|environment variable/i.test(
      out,
    )
  )
    return `Before the upgrade, ${names} already failed: the tests expect an environment variable or secret that only CI has.`;
  return `Before the upgrade, ${names} already failed; Bumpsmith compares against that and only counts new failures.`;
}

/** True when the dependencies installed and at least one real check passed after the upgrade. */
export function isVerified(baseline: CheckResult[], verdict: Verdict): boolean {
  if (!baseline.find((c) => c.name === "install")?.passed) return false;
  return verdict.comparisons.some(
    (c) => c.name !== "install" && (c.after === true || c.sameFailures !== undefined),
  );
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
    let inv = await inventory(repoDir, input.ecosystem);
    /** The package is a member of a workspace whose lockfile lives at the repository root. */
    let workspaceMember = false;
    if (sub) {
      workspaceMember =
        inv.ecosystem === "npm" &&
        !inv.lockfiles.length &&
        ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].some((f) =>
          existsSync(join(repoRoot, f)),
        );
      if (workspaceMember) {
        // Install from the root with the root's package manager; other checks and the
        // bump run in the member's own directory.
        const rootInv = await inventory(repoRoot, "npm");
        inv = await inventory(repoDir, "npm", { packageManager: rootInv.packageManager });
        inv.lockfiles = [];
        inv.nodeMajor = Math.max(inv.nodeMajor, rootInv.nodeMajor) as 22 | 24 | 26;
        inv.runtime.node ??= rootInv.runtime.node;
        for (const c of inv.checks)
          c.cwd = c.name === "install" ? "/workspace" : `/workspace/${sub}`;
        const install = inv.checks.find((c) => c.name === "install");
        const rootInstall = rootInv.checks.find((c) => c.name === "install");
        if (install && rootInstall) install.argv = rootInstall.argv;
        job.notes.push(
          `${sub} is a workspace member: dependencies install from the repository root with ${rootInv.packageManager}.`,
        );
      } else for (const c of inv.checks) c.cwd = `/workspace/${sub}`;
    }
    if (
      !inv.checks.some((c) => c.name !== "install") &&
      !Object.keys(opts.config?.checks ?? {}).length
    )
      job.notes.push(
        "This repository has no build, typecheck, lint or test command Bumpsmith could find, so only the install can be checked; add checks to .bumpsmith.yml to verify more.",
      );
    // Configured check commands replace detected ones (argv only, validated in config).
    for (const [name, cmd] of Object.entries(opts.config?.checks ?? {})) {
      if (!cmd) continue;
      const argv = commandArgv(cmd);
      const existing = inv.checks.find((c) => c.name === name);
      if (existing) existing.argv = argv;
      else inv.checks.push({ name: name as CheckName, argv });
    }
    const eco = input.ecosystem ?? inv.ecosystem;
    // A root-level bot PR for a package that workspace members declare: bump every member.
    const members =
      eco === "npm" &&
      !sub &&
      (inv.workspaces.length > 0 || existsSync(join(repoDir, "pnpm-workspace.yaml")))
        ? await workspaceMembersDeclaring(repoDir, input.packageName)
        : [];
    if (members.length)
      job.notes.push(
        `Workspace members that declare ${input.packageName}: ${members.map((m) => m.dir).join(", ")}.`,
      );
    const declaredVersion = await currentVersion(inv, input.packageName);
    // Not declared anywhere but present in a lockfile: a transitive dependency (Dependabot
    // security updates). The lockfile moves; manifests stay as they are.
    let transitive = false;
    // Python: a package declared only in a nested file (tools/docs-requirements.txt).
    let nested: string[] = [];
    if (eco === "pypi" && declaredVersion === null) {
      nested = await nestedPythonManifestsDeclaring(repoDir, input.packageName);
      if (nested.length) {
        inv.manifests.push(...nested.filter((f) => !inv.manifests.includes(f)));
        job.notes.push(`${input.packageName} is declared in ${nested.join(", ")}.`);
        if (!input.from) {
          const text = await readFile(join(repoDir, nested[0] ?? ""), "utf8");
          const spec = new RegExp(
            `${input.packageName.replace(/[-_.]/g, "[-_.]")}\\s*(?:\\[[^\\]]*\\])?\\s*([=<>~!]=?\\s*[\\w.*]+)`,
            "i",
          ).exec(text)?.[1];
          if (spec) input.from = lowestVersion(spec) ?? undefined;
        }
      }
    }
    const declaredInManifest =
      lowestVersionDeclared(inv, input.packageName) !== undefined || members.length > 0;
    if (!declaredInManifest && !nested.length) {
      const locked = lockedVersions(await lockTexts([repoDir, repoRoot]), input.packageName);
      if (locked.length) {
        transitive = true;
        job.notes.push(
          `${input.packageName} is a transitive dependency (locked at ${locked.join(", ")}); only the lockfile is updated.`,
        );
        input.from ??= locked[0];
      }
    }
    const from =
      input.from ?? declaredVersion ?? (members[0] ? lowestVersion(members[0].range) : null);
    if (!from) throw new Error(`${input.packageName} is not a dependency of this repository`);
    job.from = from;

    // Phase 0 sandboxes can only reach the public registries.
    const privateHost =
      eco === "npm"
        ? workspaceMember
          ? await privateRegistryHost(
              repoRoot,
              ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"].filter((f) =>
                existsSync(join(repoRoot, f)),
              ),
            )
          : await privateRegistryHost(repoDir, inv.lockfiles)
        : null;
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
    if (eco === "npm" && nodeWanted > 26) {
      job.state = "blocked_policy";
      job.notes.push(
        `Unsupported: the repo requires Node ${inv.runtime.node}; sandboxes provide Node 22, 24 and 26.`,
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

    if (opts.setupOnly) {
      job.impact = {
        package: input.packageName,
        from,
        to: input.to,
        items: [],
        files_importing_package: [],
        upgrade_class: "safe",
        reason: "setup-only run",
      };
    } else {
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
    }
    job.state = "analysed";
    log(`job ${id}: ${job.impact.items.length} impact item(s), class ${job.impact.upgrade_class}`);

    // Sandbox: baseline
    // Databases and caches the tests need, as the repository's CI starts them.
    const svc = inv.checks.some((c) => c.name === "test")
      ? await detectServices(repoRoot)
      : { services: [], env: {}, skipped: [] };
    sb = await (opts.sandboxFactory ?? dockerSandboxFactory)({
      ecosystem: eco,
      nodeMajor: inv.nodeMajor,
      label: id,
      services: svc.services,
      env: svc.env,
    });
    const started = sb.startedServices ?? [];
    const failed = sb.failedServices ?? [];
    if (started.length)
      job.notes.push(`Started the services the CI workflow uses for tests: ${started.join(", ")}.`);
    if (failed.length) job.notes.push(`Could not start CI services: ${failed.join("; ")}.`);
    if (svc.skipped.length)
      job.notes.push(
        `CI services not run in the sandbox (only official postgres, mysql, mariadb, redis, valkey and mongo images are): ${svc.skipped.join(", ")}.`,
      );
    await sb.copyIn(repoRoot);
    // A local one-commit git repository: version plugins (setuptools-scm, hatch-vcs) and
    // some test setups ask git about the checkout. It never leaves the sandbox (.git is
    // excluded from copy-out and patches) and needs no network.
    await sb.exec(
      [
        "sh",
        "-c",
        "git init -q && git add -A && git -c user.name=bumpsmith -c user.email=bumpsmith@localhost commit -q --no-verify -m baseline",
      ],
      { timeoutSec: 300 },
    );
    // Public git dependencies: fetched by the host, served to the sandbox from a local copy.
    if (eco === "pypi") {
      const deps = gitDependencies(await readManifests(repoDir, inv.manifests));
      if (deps.length) {
        const gitDir = join(dir, "git-deps");
        const { fetched, failed } = await fetchGitDeps(deps, gitDir);
        await installGitDeps(sb, fetched, gitDir);
        if (fetched.length)
          job.notes.push(
            `Fetched git dependencies on the host and served them to the sandbox: ${fetched.map((f) => f.url).join(", ")}.`,
          );
        if (failed.length)
          job.notes.push(
            `Could not fetch git dependencies (private or missing?): ${failed.join("; ")}.`,
          );
      }
    }
    const wd = sub ? `/workspace/${sub}` : undefined;
    log(`job ${id}: baseline checks`);
    job.baseline = await runChecks(sb, inv.checks, deadline);
    if (!job.baseline.find((c) => c.name === "install")?.passed)
      job.notes.push(
        `Baseline install failed${installFailureReason(job.baseline)}; running in limited mode (static checks only, draft output).`,
      );
    const why = checkFailureReason(job.baseline);
    if (why) job.notes.push(why);
    // A check that cannot finish within its limit at baseline cannot verify anything later.
    const timedOut = job.baseline.filter((c) => c.timed_out).map((c) => c.name);
    // Build, typecheck and lint that already fail before the upgrade cannot show a
    // difference after it (only tests are compared one by one), so they are not re-run:
    // on large repositories that halves the time.
    const alreadyFailing = job.baseline
      .filter((c) => !c.passed && !c.timed_out && c.name !== "install" && c.name !== "test")
      .map((c) => c.name);
    const installOk = !!job.baseline.find((c) => c.name === "install")?.passed;
    const checks = inv.checks.filter(
      (c) => !timedOut.includes(c.name) && !(installOk && alreadyFailing.includes(c.name)),
    );
    if (installOk && alreadyFailing.length)
      job.notes.push(
        `Not re-run after the upgrade, because they already failed before it and cannot show a difference: ${alreadyFailing.join(", ")}.`,
      );
    if (timedOut.length)
      job.notes.push(
        `Skipped checks that take longer than the ${CHECK_TIMEOUT_SEC / 60}-minute limit: ${timedOut.join(", ")}. Set a faster command (for example a subset of the tests) under checks: in .bumpsmith.yml.`,
      );

    /** Lockfile-only update of a transitive dependency, then report what version it reached. */
    const updateTransitive = async (pm: string, cwd: string | undefined) => {
      const argv = lockfileUpdateArgv(pm, input.packageName);
      if (!argv) {
        job.notes.push(
          `${input.packageName} is not pinned by any file here, so installs already take the newest version its dependents allow; nothing to change.`,
        );
        return;
      }
      const r = await sb?.exec(argv, { network: true, timeoutSec: 15 * 60, cwd });
      if (!r || r.exitCode !== 0)
        throw new Error(
          `could not update ${input.packageName} in the lockfile: ${(r?.stderr || r?.stdout || "").slice(-1200)}`,
        );
      const texts = [];
      for (const f of LOCKFILES) {
        const c = await sb?.exec(["cat", "--", f], { cwd: cwd ?? "/workspace" });
        if (c?.exitCode === 0) texts.push(c.stdout);
      }
      const now = lockedVersions(texts.join("\n"), input.packageName);
      const reached = now.some((v) => compareVersions(v, input.to) >= 0);
      job.notes.push(
        reached
          ? `Lockfile now resolves ${input.packageName} to ${now.join(", ")}.`
          : `The lockfile could only move ${input.packageName} to ${now.join(", ") || "an unknown version"}: a package that depends on it allows nothing newer. Upgrading that parent package is needed to reach ${input.to}.`,
      );
    };

    // Bump the version inside the sandbox
    // When the dependencies cannot install even before the upgrade, a failing bump is the
    // same problem, not a crash: say so and stop.
    const baselineInstalled = !!job.baseline.find((c) => c.name === "install")?.passed;
    try {
      const manifest = "package.json";
      const cur =
        eco === "npm" ? await sb.exec(["cat", "--", manifest], { cwd: wd }) : { stdout: "" };
      if (eco === "npm") {
        const before = new Date(Date.now() - minAge * 86_400_000);
        // "yarn" can be Yarn 1 handing off to a vendored Yarn 2+ (yarnPath in .yarnrc.yml);
        // Yarn 2+ adds to the workspace in cwd and rejects Yarn 1's -W.
        const vendoredBerry =
          inv.packageManager === "yarn" &&
          (existsSync(join(repoDir, ".yarnrc.yml")) || existsSync(join(repoRoot, ".yarnrc.yml")));
        const isWorkspaceRoot =
          existsSync(join(repoDir, "pnpm-workspace.yaml")) || inv.workspaces.length > 0;
        // Where the package is declared: this directory, and/or workspace members under it.
        const targets: { dir: string; member: boolean; text: string }[] = [];
        if (npmDepInfo(cur.stdout, input.packageName))
          targets.push({ dir: sub, member: workspaceMember, text: cur.stdout });
        for (const m of members) {
          const text = (
            await sb.exec(["cat", "--", "package.json"], { cwd: `/workspace/${m.dir}` })
          ).stdout;
          targets.push({ dir: m.dir, member: true, text });
        }
        if (!targets.length && !transitive)
          throw new Error(`could not find ${input.packageName} in ${manifest}`);
        if (transitive)
          await updateTransitive(inv.packageManager, workspaceMember ? undefined : wd);

        // Grouped updates: every extra package must pass the same release gate.
        const extras: string[] = [];
        for (const extra of input.alsoUpgrade ?? []) {
          try {
            const xrel = await getRelease("npm", extra.name, extra.to);
            const xgate = releaseGate(
              xrel,
              await checkMalicious("npm", extra.name, extra.to),
              minAge,
            );
            if (xgate.allowed) extras.push(`${extra.name}@${extra.to}`);
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
        const gatedCompanions = new Map<string, boolean>();
        const companionOk = async (c: string) => {
          if (!gatedCompanions.has(c)) {
            try {
              const crel = await getRelease("npm", c, input.to);
              gatedCompanions.set(
                c,
                releaseGate(crel, await checkMalicious("npm", c, input.to), minAge).allowed,
              );
            } catch {
              gatedCompanions.set(c, false); // no such version of the companion
            }
          }
          return gatedCompanions.get(c) === true;
        };

        for (const t of targets) {
          const info = npmDepInfo(t.text, input.packageName);
          if (!info) continue;
          // Companions must exist at the target version and pass the same release gate;
          // grouped extras move only where this manifest already declares them.
          const companions: string[] = [];
          for (const c of npmCompanions(t.text, input.packageName, from))
            if (await companionOk(c)) companions.push(c);
          for (const x of extras) {
            const name = x.slice(0, x.lastIndexOf("@"));
            if (npmDepInfo(t.text, name)) companions.push(x);
          }
          if (companions.length)
            job.notes.push(
              `Upgraded together with ${input.packageName}${t.dir ? ` in ${t.dir}` : ""}: ${companions.join(", ")}.`,
            );
          const workspaceRoot = !t.member && !vendoredBerry && isWorkspaceRoot;
          // npm adds to a workspace member from the root with --workspace.
          const npmMember = t.member && inv.packageManager === "npm";
          const upArgv = [
            ...npmUpgradeArgv(
              inv.packageManager,
              input.packageName,
              input.to,
              info,
              before,
              workspaceRoot,
              companions,
            ),
            ...(npmMember ? ["--workspace", t.dir] : []),
          ];
          const upOpts = {
            network: true,
            timeoutSec: 15 * 60,
            cwd: npmMember || !t.dir ? undefined : `/workspace/${t.dir}`,
          };
          let up = await sb.exec(upArgv, upOpts);
          if (up.exitCode !== 0 && inv.packageManager === "npm") {
            const noBefore = upArgv.filter((a) => !a.startsWith("--before"));
            const peerConflict = /ERESOLVE|peer dep/i.test(`${up.stdout}${up.stderr}`);
            if (peerConflict) {
              job.notes.push(
                "npm reported a peer dependency conflict; installed with --legacy-peer-deps, as the project's own install does.",
              );
              up = await sb.exec([...upArgv, "--legacy-peer-deps"], upOpts);
              if (up.exitCode !== 0)
                up = await sb.exec([...noBefore, "--legacy-peer-deps"], upOpts);
            } else {
              job.notes.push(
                "npm could not apply the release-age limit to transitive dependencies (--before); installed without it.",
              );
              up = await sb.exec(noBefore, upOpts);
            }
          }
          if (up.exitCode !== 0)
            throw new Error(
              `could not install ${input.packageName}@${input.to}${t.dir ? ` in ${t.dir}` : ""}: ${(up.stderr || up.stdout).slice(-1500)}`,
            );
        }
      } else {
        // Every manifest that declares the package moves together (requirements*.txt,
        // requirements*.in, pyproject.toml); one stale file would reinstall the old version.
        const extras: { name: string; to: string }[] = [];
        for (const extra of input.alsoUpgrade ?? []) {
          const xrel = await getRelease("pypi", extra.name, extra.to).catch(() => null);
          const ok =
            xrel &&
            releaseGate(xrel, await checkMalicious("pypi", extra.name, extra.to), minAge).allowed;
          if (ok) extras.push(extra);
          else job.notes.push(`Not upgraded with the group: ${extra.name}@${extra.to}.`);
        }
        const touched: string[] = [];
        for (const m of inv.manifests) {
          const text = (await sb.exec(["cat", "--", m], { cwd: wd })).stdout;
          let next = bumpFile(eco, m, text, input.packageName, input.to);
          if (!next) continue;
          for (const x of extras) next = bumpFile(eco, m, next, x.name, x.to) ?? next;
          await sb.exec(["sh", "-c", 'cat > "$1"', "sh", m], { input: next, cwd: wd });
          touched.push(m);
        }
        if (!touched.length && transitive) await updateTransitive(inv.packageManager, wd);
        else if (!touched.length)
          throw new Error(
            `could not find ${input.packageName} in ${inv.manifests.join(", ") || "any manifest"}`,
          );
        // pip-tools: hash-pinned requirements compiled from a .in file are regenerated from
        // it (uv keeps every other pin as it was); editing the version alone breaks the hashes.
        for (const m of touched.filter((f) => f.endsWith(".txt"))) {
          const text = (await sb.exec(["cat", "--", m], { cwd: wd })).stdout;
          if (!text.includes("--hash=")) continue;
          const source = m.replace(/\.txt$/, ".in");
          if (!inv.manifests.includes(source)) {
            job.notes.push(
              `${m} pins hashes but has no ${source} to compile from; its hashes were not regenerated.`,
            );
            continue;
          }
          const r = await sb.exec(
            ["uv", "pip", "compile", "--quiet", "--generate-hashes", source, "-o", m],
            { network: true, timeoutSec: 10 * 60, cwd: wd },
          );
          if (r.exitCode !== 0)
            job.notes.push(`Could not recompile ${m} from ${source}: ${r.stderr.slice(-300)}`);
        }
      }
    } catch (err) {
      if (baselineInstalled) throw err;
      job.state = "needs_human";
      job.notes.push(
        `The version bump could not be applied either, because the dependencies do not install in the sandbox (see the baseline install). Details: ${String((err as Error).message ?? err).slice(0, 300)}`,
      );
      return job;
    }
    job.after_bump = await runChecks(sb, checks, deadline);
    job.state = "verifying";
    let verdict = await compareWithBaseline(sb, checks, job.baseline, job.after_bump, deadline);
    if (opts.setupOnly) {
      job.verdict = verdict;
      job.state = isVerified(job.baseline, verdict) ? "safe" : "needs_human";
      return job;
    }
    const record = job.change_record;
    if (!record) throw new Error("no Change Record");

    // Fix loop (FIX-1..8)
    const allow = new Set<string>([
      ...members.map((m) => `${m.dir}/package.json`),
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
          record,
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
      ...(workspaceMember ? ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock"] : []),
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
    const readSnap = async (side: string, path: string) => {
      const f = join(dir, side, path);
      return existsSync(f) ? await readFile(f, "utf8") : null;
    };
    const manifests = await Promise.all(
      files
        .filter((f) => /(^|\/)package\.json$/.test(f.path))
        .map(async (f) => ({
          path: f.path,
          before: await readSnap("before", f.path),
          after: await readSnap("after", f.path),
        })),
    );
    job.rules = applyRules({
      ecosystem: eco,
      packageName: input.packageName,
      files,
      manifests,
      record,
      edits: job.edits,
      peerDependencies: eco === "npm" ? await npmPeerDependencies(input.packageName, input.to) : [],
      protectedPaths: opts.config?.rules.protected_paths ?? [],
    });
    if (patch.trim() && !ledger.exhausted) {
      job.review = await review({
        provider: opts.provider,
        ledger,
        patch,
        record,
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

    // Never claim more than was proven: with no check beyond install passing after the
    // upgrade (or no install at all), the change is unverified, whatever the review says.
    const verified = isVerified(job.baseline, verdict);
    if (!verified) {
      job.confidence = "low";
      job.notes.push(
        "Not verified: no build, typecheck or test passed in the sandbox after the upgrade (see Verification). Opened for a human to check.",
      );
    }

    if (job.rules.some((r) => r.severity === "block")) job.state = "blocked_policy";
    else if (!verdict.passed || !verified) job.state = "needs_human";
    else if (!patch.trim()) job.state = "safe";
    else if (job.review && job.review.verdict !== "approve") job.state = "needs_human";
    else job.state = "ready";
    return job;
  } catch (err) {
    job.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (!(err instanceof TimeBudgetExceeded)) job.notes.push(`Stopped: ${explainError(job.error)}`);
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
