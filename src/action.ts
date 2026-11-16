/**
 * Bumpsmith GitHub Action.
 *
 * Runs in the user's own CI with the user's own model key. Trust model:
 *  - It never checks out or executes the bot PR's head. It rebuilds the upgrade from the
 *    default branch with the release-age-gated version from the public registry.
 *  - Tokens stay in this process (masked in logs). Untrusted install/test steps run in a
 *    Docker container with no environment variables and no network except a read-only
 *    registry mirror.
 *  - Everything it writes goes through the shared publishing core (hash check, rule re-run,
 *    strict patch application, branch guard, never reopen).
 */
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATHS, parseConfig, type RepoConfig } from "./config/repo-config.ts";
import { type GitHubClient, tokenClient } from "./github/client.ts";
import { cloneAtCommit } from "./github/clone.ts";
import {
  headWrittenByBumpsmith,
  needsHumanComment,
  publishPatch,
  tokenLogin,
} from "./github/publish/core.ts";
import { branchName } from "./github/publish/pr-body.ts";
import { AnthropicProvider } from "./model/anthropic.ts";
import { compatibleProvider, PRESETS } from "./model/openai-compatible.ts";
import type { ModelProvider } from "./model/provider.ts";
import { type JobRecord, normaliseSubdir, runJob } from "./pipeline.ts";
import { BOT_AUTHORS, parseBotPr } from "./rescue/bot-pr.ts";
import { botPrEcosystem, exactTarget } from "./rescue/resolve.ts";
import { maskSecrets } from "./security/secrets.ts";
import { sha256Hex } from "./util/hash.ts";

// ------------------------------------------------------------------ workflow commands

export const esc = (s: string) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const log = (m: string) => process.stdout.write(`${maskSecrets(m).text}\n`);
const notice = (m: string) => log(`::notice::${esc(m)}`);
const warning = (m: string) => log(`::warning::${esc(m)}`);
const mask = (secret: string) => secret && process.stdout.write(`::add-mask::${esc(secret)}\n`);

export function input(name: string, fallback = ""): string {
  return (process.env[`INPUT_${name.toUpperCase().replace(/ /g, "_")}`] ?? fallback).trim();
}

async function output(name: string, value: string) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value.replace(/\n/g, " ")}\n`);
}

async function summary(md: string) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

// ------------------------------------------------------------------ helpers

async function readRepoConfig(
  gh: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoConfig> {
  for (const path of CONFIG_PATHS) {
    try {
      const r = await gh.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        ref,
        headers: { accept: "application/vnd.github.raw+json" },
      });
      const parsed = parseConfig(String(r.data));
      for (const p of parsed.problems) warning(`${path}:${p.line ?? 1} ${p.path} ${p.message}`);
      // An invalid file means safe defaults; the Action still runs (it was explicitly configured in a workflow).
      return parsed.config;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  return parseConfig(null).config;
}

export interface Target {
  packageName: string;
  from: string | null;
  to: string;
  ecosystem: "npm" | "pypi";
  rescueOf: number | null;
  /** Monorepo sub-directory ("" = root). */
  dir?: string;
}

/** Work out what to upgrade from the event. Returns null when there is nothing to do. */
export interface ModeOptions {
  mode: "rescue" | "fix";
  dir?: string;
  package?: string;
  version?: string;
  ecosystem?: "npm" | "pypi";
}

export function modeFromInputs(): ModeOptions {
  return {
    mode: input("mode", "rescue") === "fix" ? "fix" : "rescue",
    package: input("package"),
    version: input("version"),
    ecosystem: input("ecosystem", "npm") === "pypi" ? "pypi" : "npm",
  };
}

export async function resolveTargets(
  gh: GitHubClient,
  owner: string,
  repo: string,
  event: string,
  payload: Record<string, any>,
  opts: ModeOptions = modeFromInputs(),
): Promise<Target[]> {
  if (opts.mode === "fix") {
    if (!opts.package || !opts.version) throw new Error("mode fix needs a package and a version");
    return [
      {
        packageName: opts.package,
        from: null,
        to: opts.version,
        ecosystem: opts.ecosystem ?? "npm",
        rescueOf: null,
        dir: normaliseSubdir(opts.dir),
      },
    ];
  }
  let prNumbers: number[] = [];
  if (event === "workflow_run") {
    const run = payload.workflow_run ?? {};
    if (run.conclusion !== "failure" && run.conclusion !== "timed_out") return [];
    prNumbers = ((run.pull_requests ?? []) as { number: number }[]).map((p) => p.number);
  } else if (event === "workflow_dispatch" || event === "schedule") {
    // Look at open bot PRs whose checks are red.
    const pulls = (
      await gh.request("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        state: "open",
        per_page: 100,
      })
    ).data;
    for (const p of pulls) {
      if (!BOT_AUTHORS.has(p.user?.login ?? "")) continue;
      const runs = (
        await gh.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
          owner,
          repo,
          ref: p.head.sha,
          per_page: 100,
        })
      ).data.check_runs;
      if (
        runs.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out") &&
        !runs.some((c) => c.status !== "completed")
      )
        prNumbers.push(p.number);
    }
  }
  const out: Target[] = [];
  for (const n of prNumbers) {
    const pr = (
      await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: n,
      })
    ).data;
    if (pr.state !== "open" || !BOT_AUTHORS.has(pr.user?.login ?? "")) continue;
    const parsed = parseBotPr(pr.title, pr.user?.login ?? "");
    if (!parsed) {
      notice(`#${n}: not a single-package update (grouped updates are not supported yet); skipped`);
      continue;
    }
    const to = await exactTarget(gh, owner, repo, pr.head.sha, parsed.pkg, parsed.to);
    if (!to) continue;
    out.push({
      packageName: parsed.pkg,
      from: parsed.from,
      to,
      ecosystem: await botPrEcosystem(gh, owner, repo, n, pr.head.ref),
      rescueOf: n,
      dir: normaliseSubdir(parsed.dir),
    });
  }
  return out;
}

// ------------------------------------------------------------------ main

export interface ActionDeps {
  gh: GitHubClient;
  owner: string;
  repo: string;
  event: string;
  payload: Record<string, any>;
  workDir: string;
  maxCostUsd: number;
  mode?: ModeOptions;
  /** Fetch the default branch at `sha` into `dest` (no token ever reaches the sandbox). */
  checkout(dest: string, sha: string): Promise<{ removedSymlinks: string[] }>;
  /** Run the analyse → fix → verify → review pipeline. */
  upgrade(t: Target, repoDir: string, runsDir: string, config: RepoConfig): Promise<JobRecord>;
}

export interface ActionRow {
  target: Target;
  state: string;
  confidence: string | null;
  cost: number;
  result: string;
  prNumber?: number;
  prUrl?: string;
}

export async function runAction(d: ActionDeps): Promise<ActionRow[]> {
  const { gh, owner, repo } = d;
  const meta = (await gh.request("GET /repos/{owner}/{repo}", { owner, repo })).data;
  const baseSha = (
    await gh.request("GET /repos/{owner}/{repo}/branches/{branch}", {
      owner,
      repo,
      branch: meta.default_branch,
    })
  ).data.commit.sha;
  const config = await readRepoConfig(gh, owner, repo, baseSha);
  const targets = await resolveTargets(gh, owner, repo, d.event, d.payload, d.mode);
  const rows: ActionRow[] = [];
  if (!targets.length) return rows;
  const selfLogin = await tokenLogin(gh);
  const open = (
    await gh.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      state: "open",
      per_page: 100,
    })
  ).data.filter((p) => p.head.ref.startsWith("bumpsmith/"));
  for (const t of targets.slice(0, 3)) {
    const branch = branchName(t.ecosystem, t.packageName, t.to, t.dir ?? "");
    const branchSuffix = branch.slice(branch.lastIndexOf("/") + 1);
    const existing = open.some((p) => p.head.ref === branch);
    if (!existing && open.length >= config.limits.open_pull_requests) {
      notice(
        `Open Bumpsmith pull request limit (${config.limits.open_pull_requests}) reached; ${t.packageName} skipped.`,
      );
      rows.push({
        target: t,
        state: "skipped",
        confidence: null,
        cost: 0,
        result: "open pull request limit reached",
      });
      continue;
    }
    log(
      `::group::${t.packageName} ${t.from ?? ""} → ${t.to}${t.rescueOf ? ` (rescuing #${t.rescueOf})` : ""}`,
    );
    const dir = join(d.workDir, branchSuffix);
    const checkout = await d.checkout(join(dir, "repo"), baseSha);
    const record = await d.upgrade(t, join(dir, "repo"), join(dir, "runs"), config);
    if (checkout.removedSymlinks.length)
      record.notes.push(
        `${checkout.removedSymlinks.length} symlink(s) pointing outside the repository were ignored.`,
      );
    const patch = await readFile(join(dir, "runs", record.id, "patch.diff"), "utf8").catch(
      () => "",
    );
    log("::endgroup::");
    const row: ActionRow = {
      target: t,
      state: record.state,
      confidence: record.confidence ?? null,
      cost: record.cost_usd ?? 0,
      result: record.state,
    };
    if ((record.state === "ready" || record.state === "needs_human") && patch.trim()) {
      const r = await publishPatch({
        gh,
        owner,
        repo,
        baseSha,
        patch,
        patchSha256: sha256Hex(patch),
        record,
        outcome: record.state,
        confidence: record.confidence ?? "low",
        config,
        ecosystem: t.ecosystem,
        packageName: t.packageName,
        toVersion: t.to,
        dir: t.dir ?? "",
        jobId: record.id,
        commandPrefix: "bumpsmith",
        rescueOf: t.rescueOf,
        isOurHead: (sha) => headWrittenByBumpsmith(gh, owner, repo, sha, selfLogin),
      });
      if (r.state === "published") {
        row.result = `${r.updated ? "updated" : "opened"} #${r.prNumber}${r.draft ? " (draft)" : ""}`;
        row.prNumber = r.prNumber;
        row.prUrl = r.url;
        notice(`${t.packageName} ${t.to}: ${row.result} ${r.url}`);
      } else if (r.state === "human_touched") {
        row.result = "branch has human commits; not overwritten";
        warning(`${t.packageName} ${t.to}: ${row.result}`);
      } else {
        row.result = `${r.state}: ${r.reason}`;
        warning(`${t.packageName} ${t.to}: ${row.result}`);
      }
    } else if (t.rescueOf && record.state === "needs_human") {
      await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: t.rescueOf,
        body: needsHumanComment(record),
      });
      row.result = "needs a human (comment posted)";
    }
    rows.push(row);
  }
  return rows;
}

export async function main(): Promise<void> {
  const providerName = input("provider", "anthropic");
  const apiKey = input("api-key") || input("anthropic-api-key");
  const token = input("github-token");
  mask(apiKey);
  mask(token);
  if (!apiKey && !(providerName in PRESETS && PRESETS[providerName]?.local))
    throw new Error("api-key is required (or anthropic-api-key for the default provider)");
  if (!token) throw new Error("github-token is required");
  if (token === input("default-token"))
    warning(
      "Using GITHUB_TOKEN: pull requests it opens will not trigger your CI. Use a GitHub App token for full verification: https://github.com/bumpsmith/bumpsmith#tokens",
    );
  const model = input("model", providerName === "anthropic" ? "claude-opus-5-5" : "");
  const makeProvider = (): ModelProvider => {
    if (providerName === "anthropic") {
      process.env.ANTHROPIC_API_KEY = apiKey;
      return new AnthropicProvider(model);
    }
    return compatibleProvider(providerName, model, input("base-url") || undefined, apiKey);
  };

  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/") as [string, string];
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is not set");
  const host = new URL(process.env.GITHUB_SERVER_URL ?? "https://github.com").host;
  const gh = tokenClient(token, {
    baseUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
    userAgent: "bumpsmith-action",
    log: (m) => warning(m),
  });
  const payload = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const work = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "bumpsmith-"));
  process.env.BUMPSMITH_DATA_DIR ??= join(work, "data");
  const maxCost = Number(input("max-cost-usd", "5")) || 5;
  let rows: ActionRow[] = [];
  try {
    rows = await runAction({
      gh,
      owner,
      repo,
      event: process.env.GITHUB_EVENT_NAME ?? "",
      payload,
      workDir: work,
      maxCostUsd: maxCost,
      checkout: (dest, sha) =>
        cloneAtCommit({ token, fullName: `${owner}/${repo}`, sha, dest, apiHost: host }),
      upgrade: (t, repoDir, runsDir, config) =>
        runJob(
          {
            repo: repoDir,
            packageName: t.packageName,
            to: t.to,
            from: t.from ?? undefined,
            ecosystem: t.ecosystem,
            dir: t.dir,
          },
          { provider: makeProvider(), runsDir, budgetUsd: maxCost, config, log },
        ),
    });
    if (!rows.length)
      notice("Nothing to do: no red Dependabot/Renovate pull request in this event.");
    const last = rows.at(-1);
    await output("state", last?.state ?? "nothing");
    if (last?.prNumber) await output("pr-number", String(last.prNumber));
    if (last?.prUrl) await output("pr-url", last.prUrl);
  } finally {
    await summary(
      [
        "## Bumpsmith",
        "",
        "| Package | Upgrade | Result | Confidence | Model cost | Action |",
        "|---|---|---|---|---|---|",
        ...rows.map(
          (r) =>
            `| ${r.target.packageName} | ${r.target.from ?? "?"} → ${r.target.to} | ${r.state} | ${r.confidence ?? "–"} | $${r.cost.toFixed(2)} | ${r.result} |`,
        ),
      ].join("\n"),
    );
    await rm(work, { recursive: true, force: true });
  }
}
