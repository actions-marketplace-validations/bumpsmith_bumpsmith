#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import semver from "semver";
import { type BenchTask, mine, saveTasks } from "./bench/mine.ts";
import { runBench, summarise } from "./bench/run.ts";
import { npmApiDiff, renderApiDiff } from "./change/dts-diff.ts";
import { buildChangeRecord } from "./change/extract.ts";
import { CONFIG_PATHS, parseConfig } from "./config/repo-config.ts";
import { buildImpactMap } from "./impact/impact.ts";
import { computeDebt } from "./inventory/debt.ts";
import { inventory } from "./inventory/inventory.ts";
import { collectComponents, cycloneDx } from "./inventory/sbom.ts";
import { AnthropicProvider } from "./model/anthropic.ts";
import { ClaudeCodeProvider } from "./model/claude-code.ts";
import { Ledger } from "./model/ledger.ts";
import type { Effort, ModelProvider } from "./model/provider.ts";
import { runJob } from "./pipeline.ts";
import { getRelease } from "./registry/registry.ts";
import { cleanupStale } from "./sandbox/docker.ts";
import { runOk } from "./util/proc.ts";

const HELP = `bumpsmith — fix your code when a dependency ships a breaking change

Usage (run inside your repository):
  bumpsmith fix <package>@<version> [--apply]   upgrade + fix + verify in a sandbox; writes a patch and evidence
  bumpsmith explain <package>@<version>         what breaks upstream and where your code is affected
  bumpsmith scan                                inventory, SBOM and upgrade-debt report (no AI; only package names are looked up on the public registry)

Options: --repo <dir> (default .), --provider anthropic-api|claude-code, --model, --budget <usd>

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
  claude-code    Your local Claude Code login (personal use on your own code).

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

function provider(name: string, model?: string): ModelProvider {
  if (name === "anthropic-api") return new AnthropicProvider(model);
  if (name === "claude-code") return new ClaudeCodeProvider(model);
  throw new Error(`unknown provider ${name}`);
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
      apply: { type: "boolean", default: false },
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
  const prov = () => provider(values.provider ?? defaultProvider(), values.model);
  switch (cmd) {
    case "fix": {
      const { name, version } = parseSpec(args[0]);
      const dir = resolve(values.repo ?? ".");
      const runsDir = join(dir, ".bumpsmith", "runs");
      const job = await runJob(
        { repo: dir, packageName: name, to: version, from: values.from },
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
        const tasks = await mine({
          ecosystem: eco,
          want: Number(values.want),
          log,
          onTask: (t) => saveTasks(out, t),
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
