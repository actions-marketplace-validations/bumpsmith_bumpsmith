#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import semver from "semver";
import { type ModeOptions, runAction } from "./action.ts";
import {
  type BenchTask,
  mine,
  NPM_HELDOUT_TARGETS,
  PYPI_HELDOUT_TARGETS,
  saveTasks,
} from "./bench/mine.ts";
import { runBench, summarise } from "./bench/run.ts";
import { npmApiDiff, renderApiDiff } from "./change/dts-diff.ts";
import { buildChangeRecord } from "./change/extract.ts";
import { CONFIG_PATHS, parseConfig } from "./config/repo-config.ts";
import { tokenClient } from "./github/client.ts";
import { cloneAtCommit } from "./github/clone.ts";
import { buildImpactMap } from "./impact/impact.ts";
import { computeDebt } from "./inventory/debt.ts";
import { inventory } from "./inventory/inventory.ts";
import { collectComponents, cycloneDx } from "./inventory/sbom.ts";
import { AnthropicProvider } from "./model/anthropic.ts";
import { ClaudeCodeProvider } from "./model/claude-code.ts";
import { CodexProvider } from "./model/codex.ts";
import { Ledger } from "./model/ledger.ts";
import { compatibleProvider, PRESETS } from "./model/openai-compatible.ts";
import type { Effort, ModelProvider } from "./model/provider.ts";
import { runJob } from "./pipeline.ts";
import { getRelease } from "./registry/registry.ts";
import { cleanupStale } from "./sandbox/docker.ts";
import { run, runOk } from "./util/proc.ts";

const HELP = `bumpsmith — fix your code when a dependency ships a breaking change

Usage (run inside your repository):
  bumpsmith fix <package>@<version> [--apply]   upgrade + fix + verify in a sandbox; writes a patch and evidence
  bumpsmith fix <package>@<version> --github owner/repo
                                                same, then open a pull request on GitHub from your machine
  bumpsmith rescue --github owner/repo          fix red Dependabot/Renovate PRs with companion pull requests
  bumpsmith init                                add the GitHub Action workflow and a starter .bumpsmith.yml
  bumpsmith explain <package>@<version>         what breaks upstream and where your code is affected
  bumpsmith scan                                inventory, SBOM and upgrade-debt report (no AI; only package names are looked up on the public registry)

Options: --repo <dir> (default .), --dir <sub-directory> (monorepos), --provider <name>, --model <id>, --base-url <url>, --budget <usd>

Advanced:
  bumpsmith inspect <repo-dir>
  bumpsmith diff <npm-package> <from> <to>
  bumpsmith change <npm|pypi> <package> <from> <to> [--provider p] [--refresh]
  bumpsmith run --repo <dir|https-url> --package <name> --to <version> [--from v] [--ref sha]
             [--provider claude-code|anthropic-api] [--model id] [--budget 8] [--rounds 3]
             [--turns 40] [--effort high] [--min-age-days 3]
  bumpsmith bench mine [--ecosystem npm|pypi] [--want 30] [--out bench/tasks.json]
  bumpsmith bench run [--tasks bench/tasks.json] [--limit N] [--only id,id] [--provider p] [--budget 8]
  bumpsmith cleanup

Providers:
  anthropic-api  Claude API with your ANTHROPIC_API_KEY (default when the variable is set).
  claude-code    Your own Claude Code login (Pro/Max plan); counts against your plan's limits.
  codex          Your own Codex CLI login (ChatGPT plan); counts against your plan's limits.
  Subscription providers run the official CLI you signed in to; Bumpsmith never sees your login.
  openai | gemini | openrouter | groq | together | deepseek   API key in OPENAI_API_KEY,
                 GEMINI_API_KEY, OPENROUTER_API_KEY, ... ; --model is required.
  ollama | lmstudio   local models on this machine; --model is required.
  custom         any OpenAI-compatible endpoint: --base-url https://... (key in OPENAI_API_KEY).

GitHub (--github, rescue): uses GITHUB_TOKEN, or your GitHub CLI login (gh auth token).

Requires Docker (untrusted install/test steps run in an isolated container).`;

function defaultProvider(): string {
  return process.env.ANTHROPIC_API_KEY ? "anthropic-api" : "claude-code";
}

function parseSpec(spec: string | undefined): { name: string; version: string } {
  const m = /^(@?[^@\s]+)@(\d[\w.+-]*)$/.exec(spec ?? "");
  if (!m?.[1] || !m[2]) throw new Error("expected <package>@<version>, e.g. zod@4.1.0");
  return { name: m[1], version: m[2] };
}

async function repoConfig(dir: string) {
  for (const f of CONFIG_PATHS) {
    try {
      const r = parseConfig(await readFile(join(dir, f), "utf8"));
      for (const p of r.problems)
        process.stderr.write(`${f}:${p.line ?? "?"} ${p.path} ${p.message}\n`);
      return r.config;
    } catch {
      // not present
    }
  }
  return parseConfig(null).config;
}

function provider(name: string, model?: string, baseURL?: string): ModelProvider {
  if (name in PRESETS || name === "custom") return compatibleProvider(name, model ?? "", baseURL);
  if (name === "anthropic-api") return new AnthropicProvider(model);
  if (name === "claude-code") return new ClaudeCodeProvider(model);
  if (name === "codex") return new CodexProvider(model);
  throw new Error(`unknown provider ${name}`);
}

const INIT_CONFIG = `# Bumpsmith configuration (optional). Reference: https://github.com/bumpsmith/bumpsmith#configuration-bumpsmithyml-optional
version: 1
release_age_days: 3
limits:
  open_pull_requests: 3
pull_requests:
  labels: [dependencies, bumpsmith]
  draft_below: medium
`;

function initWorkflow(ciName: string): string {
  return `# Bumpsmith: when your CI fails on a Dependabot/Renovate PR, open a companion PR with the fix.
name: bumpsmith
on:
  workflow_run:
    workflows: [${JSON.stringify(ciName)}]
    types: [completed]
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  checks: read
concurrency:
  group: bumpsmith
  cancel-in-progress: false
jobs:
  bumpsmith:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (github.event.workflow_run.conclusion == 'failure' &&
       contains(fromJSON('["dependabot[bot]","renovate[bot]"]'), github.event.workflow_run.actor.login))
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    steps:
      - uses: bumpsmith/bumpsmith@main   # pin to a release commit SHA once v1 is tagged
        with:
          provider: anthropic            # or openai, gemini, openrouter, groq, together, deepseek
          api-key: \${{ secrets.ANTHROPIC_API_KEY }}
`;
}

async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const r = await run("gh", ["auth", "token"]).catch(() => null);
  const t = r?.stdout.trim();
  if (!r || r.exitCode !== 0 || !t)
    throw new Error("set GITHUB_TOKEN or sign in with the GitHub CLI (gh auth login)");
  return t;
}

/** Open pull requests on GitHub from this machine, through the same path as the Action. */
async function githubRun(
  target: string,
  mode: ModeOptions,
  prov: ModelProvider,
  budget: number,
  log: (m: string) => void,
) {
  const [owner, repo] = target.split("/");
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
    throw new Error("--github expects owner/repo");
  const token = await githubToken();
  const gh = tokenClient(token, { userAgent: "bumpsmith-cli", log });
  const work = await mkdtemp(join(tmpdir(), "bumpsmith-gh-"));
  try {
    const rows = await runAction({
      gh,
      owner,
      repo,
      event: "workflow_dispatch",
      payload: {},
      workDir: work,
      maxCostUsd: budget,
      mode,
      checkout: (dest, sha) => cloneAtCommit({ token, fullName: `${owner}/${repo}`, sha, dest }),
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
          { provider: prov, runsDir, budgetUsd: budget, config, log },
        ),
    });
    if (!rows.length) log("nothing to do: no red Dependabot/Renovate pull requests");
    for (const r of rows)
      log(
        `${r.target.packageName} ${r.target.from ?? "?"} -> ${r.target.to}: ${r.state} (${r.confidence ?? "n/a"}) ${r.result}${r.prUrl ? ` ${r.prUrl}` : ""}`,
      );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      ref: { type: "string" },
      package: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      provider: { type: "string" },
      github: { type: "string" },
      "base-url": { type: "string" },
      dir: { type: "string" },
      apply: { type: "boolean", default: false },
      heldout: { type: "boolean", default: false },
      model: { type: "string" },
      budget: { type: "string", default: "8" },
      rounds: { type: "string", default: "3" },
      turns: { type: "string", default: "40" },
      effort: { type: "string", default: "high" },
      "min-age-days": { type: "string", default: "3" },
      refresh: { type: "boolean", default: false },
      ecosystem: { type: "string", default: "npm" },
      want: { type: "string", default: "30" },
      out: { type: "string" },
      tasks: { type: "string", default: "bench/tasks.json" },
      limit: { type: "string" },
      only: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  const log = (m: string) => process.stderr.write(`${m}\n`);
  const prov = () =>
    provider(values.provider ?? defaultProvider(), values.model, values["base-url"]);
  switch (cmd) {
    case "init": {
      const dir = resolve(values.repo ?? ".");
      const wfDir = join(dir, ".github", "workflows");
      let ciName = "CI";
      try {
        const { readdir } = await import("node:fs/promises");
        for (const f of await readdir(wfDir)) {
          if (!/\.ya?ml$/.test(f) || /bumpsmith/.test(f)) continue;
          const text = await readFile(join(wfDir, f), "utf8");
          if (/pull_request/.test(text)) {
            ciName =
              /^name:\s*["']?([^"'\n]+)/m.exec(text)?.[1]?.trim() ?? f.replace(/\.ya?ml$/, "");
            break;
          }
        }
      } catch {
        // no workflows yet
      }
      const wfPath = join(wfDir, "bumpsmith.yml");
      const cfgPath = join(dir, ".bumpsmith.yml");
      const { existsSync } = await import("node:fs");
      await mkdir(wfDir, { recursive: true });
      if (!existsSync(wfPath)) await writeFile(wfPath, initWorkflow(ciName));
      if (!existsSync(cfgPath)) await writeFile(cfgPath, INIT_CONFIG);
      log(
        `wrote ${wfPath} (runs after your "${ciName}" workflow fails on a Dependabot/Renovate PR)`,
      );
      log(`wrote ${cfgPath}`);
      log("\nNext:");
      log(
        "  1. Add a repository secret with your model key, e.g. ANTHROPIC_API_KEY (Settings → Secrets → Actions).",
      );
      log(
        "     Other providers: set provider/api-key in the workflow (openai, gemini, openrouter, ...).",
      );
      log(
        "  2. Optional, recommended: a GitHub App token so Bumpsmith's PRs trigger your CI (see README → Tokens).",
      );
      log("  3. Commit both files. No API key? Run it from your machine instead:");
      log("     npx bumpsmith rescue --github <owner>/<repo> --provider claude-code");
      return;
    }
    case "rescue": {
      if (!values.github) throw new Error("usage: bumpsmith rescue --github owner/repo");
      await githubRun(values.github, { mode: "rescue" }, prov(), Number(values.budget), log);
      return;
    }
    case "fix": {
      const { name, version } = parseSpec(args[0]);
      if (values.github) {
        await githubRun(
          values.github,
          { mode: "fix", package: name, version },
          prov(),
          Number(values.budget),
          log,
        );
        return;
      }
      const dir = resolve(values.repo ?? ".");
      const runsDir = join(dir, ".bumpsmith", "runs");
      const job = await runJob(
        { repo: dir, packageName: name, to: version, from: values.from, dir: values.dir },
        {
          provider: prov(),
          runsDir,
          budgetUsd: Number(values.budget),
          config: await repoConfig(dir),
          log,
        },
      );
      const out = join(runsDir, job.id);
      log(
        `\n${job.state.toUpperCase()} (confidence ${job.confidence ?? "n/a"}, $${(job.cost_usd ?? 0).toFixed(2)})`,
      );
      log(`evidence: ${join(out, "evidence.md")}`);
      const patchFile = join(out, "patch.diff");
      const patch = await readFile(patchFile, "utf8").catch(() => "");
      if (patch.trim()) {
        log(`patch:    ${patchFile}`);
        if (values.apply) {
          if (job.state !== "ready")
            log("not applying: the result is not verified (use the patch by hand if you want it)");
          else {
            await runOk("git", ["-C", dir, "apply", "--index", patchFile]);
            log("applied to your working tree (staged). Review with: git diff --cached");
          }
        } else log("apply with: git apply " + patchFile);
      }
      process.exitCode = job.state === "ready" || job.state === "safe" ? 0 : 2;
      return;
    }
    case "explain": {
      const { name, version } = parseSpec(args[0]);
      const dir = resolve(values.repo ?? ".");
      const inv = await inventory(dir);
      const eco = inv.ecosystem;
      const from = semver.minVersion(inv.dependencies[name] ?? "")?.version;
      if (!from) throw new Error(`${name} is not a direct dependency of this repository`);
      const rel = await getRelease(eco, name, version);
      const ledger = new Ledger(Number(values.budget));
      const rec = await buildChangeRecord({
        ecosystem: eco,
        name,
        from,
        to: version,
        repositoryUrl: rel.repositoryUrl,
        provider: prov(),
        ledger,
      });
      const impact = await buildImpactMap(dir, eco, name, rec);
      console.log(
        `${name} ${from} → ${version}: ${rec.changes.length} breaking change(s); ${impact.items.length} place(s) in this repository\n`,
      );
      for (const c of rec.changes)
        console.log(`  ${c.id} ${c.kind.toUpperCase()} ${c.symbols.join(", ")} — ${c.instruction}`);
      console.log("");
      for (const i of impact.items.slice(0, 50))
        console.log(`  ${i.file}:${i.line} [${i.change_id}] ${i.snippet}`);
      log(`\ncost: $${ledger.totalUsd.toFixed(3)}`);
      return;
    }
    case "scan": {
      const dir = resolve(values.repo ?? ".");
      const inv = await inventory(dir);
      const { components, complete } = await collectComponents(inv);
      const resolved = new Map(components.filter((c) => c.direct).map((c) => [c.name, c.version]));
      const cfg = await repoConfig(dir);
      const report = await computeDebt({
        inv,
        commit: "working-tree",
        resolved,
        botPrs: [],
        unsupported: [],
        minReleaseAgeDays: cfg.release_age_days,
      });
      const outDir = join(dir, ".bumpsmith");
      await mkdir(outDir, { recursive: true });
      await writeFile(
        join(outDir, "sbom.cdx.json"),
        JSON.stringify(
          cycloneDx({ repoFullName: basename(dir), commit: "working-tree", components, complete }),
          null,
          2,
        ),
      );
      await writeFile(join(outDir, "debt.json"), JSON.stringify(report, null, 2));
      console.log(
        `${inv.ecosystem} (${inv.packageManager}), ${report.directDependencies} direct dependencies, ${report.behind.length} a major version or more behind:\n`,
      );
      for (const b of report.behind)
        console.log(
          `  ${b.package.padEnd(32)} ${String(b.current).padEnd(12)} → ${b.latest}  (${b.majorsBehind} major${b.majorsBehind > 1 ? "s" : ""})${b.latestEligible ? "" : "  [newest release under the release-age wait]"}`,
        );
      log(`\nwrote .bumpsmith/sbom.cdx.json (CycloneDX 1.7) and .bumpsmith/debt.json`);
      return;
    }
    case "inspect": {
      const inv = await inventory(args[0] ?? ".");
      console.log(
        JSON.stringify(
          { ...inv, agentsMd: inv.agentsMd ? `${inv.agentsMd.length} chars` : null },
          null,
          2,
        ),
      );
      return;
    }
    case "diff": {
      const [name, from, to] = args;
      if (!name || !from || !to) throw new Error("usage: bumpsmith diff <pkg> <from> <to>");
      console.log(renderApiDiff(await npmApiDiff(name, from, to)));
      return;
    }
    case "change": {
      const [eco, name, from, to] = args;
      if ((eco !== "npm" && eco !== "pypi") || !name || !from || !to)
        throw new Error("usage: bumpsmith change <npm|pypi> <pkg> <from> <to>");
      const rel = await getRelease(eco, name, to);
      const ledger = new Ledger(5);
      const rec = await buildChangeRecord({
        ecosystem: eco,
        name,
        from,
        to,
        repositoryUrl: rel.repositoryUrl,
        provider: prov(),
        ledger,
        refresh: values.refresh,
      });
      console.log(JSON.stringify(rec, null, 2));
      log(`cost (API list price): $${ledger.totalUsd.toFixed(3)}`);
      if (values.repo)
        console.log(JSON.stringify(await buildImpactMap(values.repo, eco, name, rec), null, 2));
      return;
    }
    case "run": {
      if (!values.repo || !values.package || !values.to)
        throw new Error("run needs --repo, --package and --to");
      const job = await runJob(
        {
          repo: values.repo,
          ref: values.ref,
          packageName: values.package,
          to: values.to,
          from: values.from,
        },
        {
          provider: prov(),
          budgetUsd: Number(values.budget),
          maxRounds: Number(values.rounds),
          maxTurnsPerRound: Number(values.turns),
          effort: values.effort as Effort,
          minReleaseAgeDays: Number(values["min-age-days"]),
          refreshChangeRecord: values.refresh,
          log,
        },
      );
      console.log(
        JSON.stringify(
          {
            id: job.id,
            state: job.state,
            confidence: job.confidence,
            cost_usd: job.cost_usd,
            error: job.error,
          },
          null,
          2,
        ),
      );
      process.exitCode = job.state === "ready" || job.state === "safe" ? 0 : 2;
      return;
    }
    case "bench": {
      if (args[0] === "mine") {
        const eco = values.ecosystem === "pypi" ? "pypi" : "npm";
        const out = values.out ?? `bench/tasks-${eco}.json`;
        // Held-out: different libraries, no repository from the dev set, recent merges only.
        const dev = values.heldout
          ? (JSON.parse(await readFile("bench/tasks-npm.json", "utf8")) as BenchTask[])
          : [];
        const tasks = await mine({
          ecosystem: eco,
          want: Number(values.want),
          log,
          onTask: (t) => saveTasks(out, t),
          ...(values.heldout
            ? {
                targets: eco === "npm" ? NPM_HELDOUT_TARGETS : PYPI_HELDOUT_TARGETS,
                excludeRepos: new Set(
                  dev.map((t) => t.repo.replace("https://github.com/", "").replace(/\.git$/, "")),
                ),
                merged: ">=2026-03-01",
                perTarget: 1,
              }
            : {}),
        });
        await saveTasks(out, tasks);
        log(`saved ${tasks.length} task(s) to ${out}`);
        return;
      }
      if (args[0] === "run") {
        let tasks = JSON.parse(
          await readFile(values.tasks ?? "bench/tasks.json", "utf8"),
        ) as BenchTask[];
        if (values.only) {
          const ids = new Set(values.only.split(","));
          tasks = tasks.filter((t) => ids.has(t.id));
        }
        if (values.limit) tasks = tasks.slice(0, Number(values.limit));
        const { file, outcomes } = await runBench({
          tasks,
          provider: prov(),
          outDir: "bench",
          budgetUsd: Number(values.budget),
          log,
        });
        console.log(JSON.stringify(summarise(outcomes), null, 2));
        log(`results: ${file}`);
        return;
      }
      throw new Error("usage: bumpsmith bench mine|run");
    }
    case "cleanup":
      await cleanupStale();
      return;
    default:
      console.log(HELP);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
