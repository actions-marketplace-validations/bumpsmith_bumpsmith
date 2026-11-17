import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeProvider } from "../model/fake.ts";
import { runJob } from "../pipeline.ts";
import { gh } from "../util/github.ts";
import { parseTitle } from "./mine.ts";

/**
 * The repository zoo: real repositories of every common shape (package manager, workspace
 * layout, Python packaging tool), each with a version bump a bot proposed. A zoo run needs
 * no model: it checks that Bumpsmith can set up the repository, run its checks, bump the
 * package and run the checks again. That is the part that must work on almost any repo.
 */

export type Shape =
  | "npm"
  | "npm-workspace"
  | "pnpm"
  | "pnpm-workspace"
  | "yarn1"
  | "yarn-berry"
  | "bun"
  | "pip-requirements"
  | "pip-requirements-dir"
  | "pip-setup"
  | "poetry"
  | "uv"
  | "pipenv"
  | "pdm"
  | "hatch-pyproject";

export interface ZooTask {
  id: string;
  shape: Shape;
  ecosystem: "npm" | "pypi";
  repo: string;
  ref: string;
  dir: string | null;
  packageName: string;
  from: string;
  to: string;
  pr_url: string;
}

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
}

interface Tree {
  tree: { path: string; type: string }[];
  truncated: boolean;
}

/** Classify a repository (or one of its sub-directories) from its file list. */
export function classify(paths: string[], dir: string): Shape | null {
  const pre = dir ? `${dir}/` : "";
  const has = (f: string) => paths.includes(`${pre}${f}`);
  const rootHas = (f: string) => paths.includes(f);
  if (has("package.json")) {
    const inWorkspace =
      !!dir && !has("package-lock.json") && !has("pnpm-lock.yaml") && !has("yarn.lock");
    if (has("pnpm-lock.yaml") || (inWorkspace && rootHas("pnpm-lock.yaml")))
      return inWorkspace || rootHas("pnpm-workspace.yaml") ? "pnpm-workspace" : "pnpm";
    if (has("bun.lock") || has("bun.lockb")) return "bun";
    if (has("yarn.lock") || (inWorkspace && rootHas("yarn.lock")))
      return paths.includes(".yarnrc.yml") ? "yarn-berry" : "yarn1";
    if (inWorkspace && rootHas("package-lock.json")) return "npm-workspace";
    if (has("package-lock.json")) return "npm";
    return null;
  }
  if (has("poetry.lock")) return "poetry";
  if (has("uv.lock")) return "uv";
  if (has("Pipfile")) return "pipenv";
  if (has("pdm.lock")) return "pdm";
  if (paths.some((p) => p.startsWith(`${pre}requirements/`) && p.endsWith(".txt")))
    return "pip-requirements-dir";
  if (has("requirements.txt")) return "pip-requirements";
  if (has("setup.py") || has("setup.cfg")) return "pip-setup";
  if (has("pyproject.toml")) return "hatch-pyproject";
  return null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const QUERIES: { eco: "npm" | "pypi"; label: string }[] = [
  { eco: "npm", label: "javascript" },
  { eco: "pypi", label: "python" },
];

/** Mine a zoo with up to `perShape` repositories of each shape. */
export async function mineZoo(opts: {
  perShape: number;
  pages: number;
  log: (m: string) => void;
  onTask?: (t: ZooTask[]) => Promise<void>;
}): Promise<ZooTask[]> {
  const out: ZooTask[] = [];
  const count = new Map<Shape, number>();
  const seen = new Set<string>();
  for (const { eco, label } of QUERIES) {
    for (let page = 1; page <= opts.pages; page++) {
      const q = encodeURIComponent(
        `is:pr is:merged author:app/dependabot label:${label} "bump" merged:>=2026-06-01`,
      );
      await pause(2500);
      let items: SearchItem[] = [];
      try {
        items = (
          await gh<{ items: SearchItem[] }>(
            `/search/issues?q=${q}&sort=updated&order=desc&per_page=100&page=${page}`,
          )
        ).items;
      } catch (err) {
        opts.log(`! search ${label} p${page}: ${(err as Error).message.slice(0, 120)}`);
        break;
      }
      for (const item of items) {
        const t = parseTitle(item.title);
        if (!t) continue;
        const repoPath = item.repository_url.replace("https://api.github.com/repos/", "");
        if (seen.has(repoPath)) continue;
        seen.add(repoPath);
        try {
          await pause(250);
          const commits = await gh<{ sha: string; parents: { sha: string }[] }[]>(
            `/repos/${repoPath}/pulls/${item.number}/commits?per_page=5`,
          );
          const base = commits[0]?.parents[0]?.sha;
          if (!base) continue;
          const tree = await gh<Tree>(`/repos/${repoPath}/git/trees/${base}?recursive=1`);
          const paths = tree.tree.filter((e) => e.type === "blob").map((e) => e.path);
          const dir = (t.dir ?? "").replace(/^\/+|\/+$/g, "");
          const shape = classify(paths, dir);
          if (!shape) continue;
          if (
            (shape === "npm" ||
              shape.startsWith("pnpm") ||
              shape.startsWith("yarn") ||
              shape === "bun" ||
              shape === "npm-workspace") !==
            (eco === "npm")
          )
            continue;
          if ((count.get(shape) ?? 0) >= opts.perShape) continue;
          count.set(shape, (count.get(shape) ?? 0) + 1);
          out.push({
            id: `${repoPath.replace("/", "__")}__${item.number}`,
            shape,
            ecosystem: eco,
            repo: `https://github.com/${repoPath}.git`,
            ref: base,
            dir: dir || null,
            packageName: t.pkg,
            from: t.from,
            to: t.to,
            pr_url: item.html_url,
          });
          opts.log(
            `+ ${shape.padEnd(20)} ${repoPath}${dir ? ` (${dir})` : ""}: ${t.pkg} ${t.from} -> ${t.to}`,
          );
          await opts.onTask?.(out);
        } catch (err) {
          opts.log(`! ${repoPath}: ${(err as Error).message.slice(0, 100)}`);
        }
      }
    }
  }
  return out;
}

export interface ZooOutcome {
  task: string;
  shape: Shape;
  state: string;
  /** Could Bumpsmith set the repository up: dependencies installed at baseline. */
  installed: boolean;
  /** Some build, typecheck or test passed after the bump: the upgrade is verifiable. */
  verifiable: boolean;
  checks: string;
  reason: string | null;
  minutes: number;
  job_id: string;
}

/** Run the zoo without a model and write a results file after each repository. */
export async function runZoo(opts: {
  tasks: ZooTask[];
  outFile: string;
  runsDir: string;
  log: (m: string) => void;
}): Promise<ZooOutcome[]> {
  await mkdir(dirname(opts.outFile), { recursive: true });
  const provider = new FakeProvider({});
  const outcomes: ZooOutcome[] = [];
  for (const [i, t] of opts.tasks.entries()) {
    opts.log(`[${i + 1}/${opts.tasks.length}] ${t.shape} ${t.id}`);
    const job = await runJob(
      {
        repo: t.repo,
        ref: t.ref,
        packageName: t.packageName,
        from: t.from,
        to: t.to,
        ecosystem: t.ecosystem,
        dir: t.dir ?? undefined,
      },
      {
        provider,
        runsDir: opts.runsDir,
        setupOnly: true,
        minReleaseAgeDays: 0,
        jobMinutes: 30,
        log: () => {},
      },
    );
    const base = job.baseline ?? [];
    const after = job.after_bump ?? [];
    const fmt = (rs: typeof base) =>
      rs.map((c) => `${c.name}:${c.passed ? "ok" : c.timed_out ? "timeout" : "fail"}`).join(" ");
    const o: ZooOutcome = {
      task: t.id,
      shape: t.shape,
      state: job.state,
      installed: !!base.find((c) => c.name === "install")?.passed,
      verifiable: job.state === "safe",
      checks: `before[${fmt(base)}] after[${fmt(after)}]`,
      reason: job.error ?? (job.state === "safe" ? null : job.notes.join(" | ") || null),
      minutes: Number(((job.duration_ms ?? 0) / 60_000).toFixed(1)),
      job_id: job.id,
    };
    outcomes.push(o);
    opts.log(
      `    -> ${o.state} ${o.checks}${o.reason ? `\n       ${o.reason.slice(0, 300)}` : ""}`,
    );
    await writeFile(
      opts.outFile,
      `${JSON.stringify({ outcomes, summary: summariseZoo(outcomes) }, null, 2)}\n`,
    );
  }
  return outcomes;
}

export function summariseZoo(o: ZooOutcome[]) {
  const byShape: Record<string, { n: number; installed: number; verifiable: number }> = {};
  for (const x of o) {
    const s = byShape[x.shape] ?? { n: 0, installed: 0, verifiable: 0 };
    byShape[x.shape] = s;
    s.n++;
    if (x.installed) s.installed++;
    if (x.verifiable) s.verifiable++;
  }
  return {
    repos: o.length,
    installed: o.filter((x) => x.installed).length,
    verifiable: o.filter((x) => x.verifiable).length,
    crashed: o.filter((x) => x.state === "failed_infra").length,
    by_shape: byShape,
  };
}

export async function saveZoo(path: string, tasks: ZooTask[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(tasks, null, 2)}\n`);
}

export const ZOO_RUNS = join("bench", "zoo-runs");
