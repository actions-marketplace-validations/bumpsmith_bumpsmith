import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import semver from "semver";
import { gh, rawFile } from "../util/github.ts";

/**
 * Mines benchmark tasks the way DEPBENCH did (arXiv 2608.30300): merged Dependabot
 * pull requests for a major version where a human pushed extra commits that changed
 * source code before merge. The human commits are the reference fix.
 * Uses the public GitHub API only (GITHUB_TOKEN raises rate limits; read-only).
 */

export interface BenchTask {
  id: string;
  ecosystem: "npm" | "pypi";
  repo: string; // https clone URL
  ref: string; // commit the Dependabot change was based on
  packageName: string;
  from: string;
  to: string;
  pr_url: string;
  human_files: string[]; // source files the human fix touched (reference)
  merged_at: string;
}

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

interface PrCommit {
  sha: string;
  author: { login: string } | null;
  commit: { author: { name: string } | null; message: string };
  parents: { sha: string }[];
}

interface CommitDetail {
  files?: { filename: string; status: string }[];
}

const TITLE =
  /^(?:\[[^\]]*\]\s*)?(?:build\(deps(?:-dev)?\):\s*|chore\(deps(?:-dev)?\):\s*|deps(?:-dev)?:\s*)?bump\s+(\S+)\s+from\s+v?([\w.\-+]+)\s+to\s+v?([\w.\-+]+)(\s+in\s+(\S+))?/i;
const MANIFEST =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|setup\.(py|cfg))$/;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/;

export function parseTitle(
  title: string,
): { pkg: string; from: string; to: string; dir: string | null } | null {
  const m = TITLE.exec(title.trim());
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { pkg: m[1], from: m[2], to: m[3], dir: m[5] ?? null };
}

function isMajor(from: string, to: string): boolean {
  const a = semver.coerce(from);
  const b = semver.coerce(to);
  if (!a || !b) return false;
  return b.major > a.major || (a.major === 0 && b.major === 0 && b.minor > a.minor);
}

/**
 * Held-out targets: libraries that do NOT appear in the dev set (NPM_TARGETS /
 * bench/tasks-npm.json). Bumpsmith has never been tuned on upgrades of these.
 */
export const NPM_HELDOUT_TARGETS = [
  "lru-cache",
  "@types/node",
  "eslint-plugin-react-hooks",
  "typescript-eslint",
  "@typescript-eslint/eslint-plugin",
  "camelcase",
  "find-up",
  "globby",
  "pretty-bytes",
  "boxen",
  "conf",
  "meow",
  "log-symbols",
  "strip-ansi",
  "wrap-ansi",
  "string-width",
  "file-type",
  "got-scraping",
  "ky",
  "node-cron",
  "dayjs",
  "luxon",
  "bcrypt",
  "jsonwebtoken",
  "helmet",
  "cors",
  "multer",
  "socket.io",
  "axios",
  "nodemailer",
  "@aws-sdk/client-s3",
  "firebase-admin",
  "prisma",
  "drizzle-orm",
  "@tanstack/react-query",
  "tailwindcss",
  "vite",
  "webpack",
  "prettier",
  "ts-node",
  "tsx",
  "esbuild",
  "rollup",
  "@vitejs/plugin-react",
  "storybook",
  "cypress",
  "playwright",
  "supertest",
  "nock",
  "sinon",
];

export const PYPI_HELDOUT_TARGETS = [
  "pydantic",
  "sqlalchemy",
  "httpx",
  "openai",
  "numpy",
  "pandas",
  "flask",
  "werkzeug",
  "pytest",
  "click",
  "marshmallow",
  "django",
  "celery",
  "black",
  "ruff",
  "mypy",
  "requests",
  "aiohttp",
  "fastapi",
  "starlette",
  "jinja2",
  "pyyaml",
  "redis",
  "psycopg",
  "alembic",
  "typer",
  "rich",
  "structlog",
  "tenacity",
  "pytest-asyncio",
  "anthropic",
  "langchain",
  "boto3",
  "protobuf",
  "grpcio",
];

/** Popular libraries with breaking majors; one targeted search each finds majors far more often. */
export const NPM_TARGETS = [
  "zod",
  "uuid",
  "commander",
  "chalk",
  "eslint",
  "vitest",
  "jest",
  "yargs",
  "inquirer",
  "node-fetch",
  "got",
  "execa",
  "ora",
  "glob",
  "rimraf",
  "mongodb",
  "mongoose",
  "ioredis",
  "openai",
  "stripe",
  "date-fns",
  "marked",
  "puppeteer",
  "msw",
  "@sentry/node",
  "express",
  "react-router-dom",
  "cheerio",
  "nanoid",
  "p-limit",
  "@octokit/rest",
  "dotenv",
  "typeorm",
  "sharp",
  "pino",
  "joi",
  "redis",
  "undici",
];
export const PYPI_TARGETS = [
  "pydantic",
  "sqlalchemy",
  "fastapi",
  "httpx",
  "openai",
  "numpy",
  "pandas",
  "flask",
  "werkzeug",
  "pytest",
  "click",
  "marshmallow",
  "django",
  "celery",
  "boto3",
  "black",
  "langchain",
  "anthropic",
];

async function isRootDependency(
  ecosystem: "npm" | "pypi",
  repoPath: string,
  ref: string,
  pkg: string,
): Promise<boolean> {
  const [owner, repo] = repoPath.split("/") as [string, string];
  if (ecosystem === "npm") {
    const text = await rawFile(owner, repo, "package.json", ref);
    if (!text) return false;
    try {
      const p = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
      return ["dependencies", "devDependencies", "optionalDependencies"].some((f) => !!p[f]?.[pkg]);
    } catch {
      return false;
    }
  }
  for (const f of ["pyproject.toml", "requirements.txt"]) {
    const text = await rawFile(owner, repo, f, ref);
    if (text && new RegExp(`["'\\s^]${pkg.replace(/[-_.]/g, "[-_.]")}\\b`, "im").test(`\n${text}`))
      return true;
  }
  return false;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mine(opts: {
  ecosystem: "npm" | "pypi";
  want: number;
  targets?: string[];
  log?: (m: string) => void;
  /** Called after each new task so progress survives interruptions. */
  onTask?: (tasks: BenchTask[]) => Promise<void>;
  /** Repositories never to use (e.g. the dev set, so the held-out set shares nothing with it). */
  excludeRepos?: Set<string>;
  /** GitHub search date filter on merge time, e.g. ">=2026-05-01". */
  merged?: string;
  /** Tasks per library, to spread the set across many libraries. */
  perTarget?: number;
}): Promise<BenchTask[]> {
  const log = opts.log ?? (() => {});
  const targets = opts.targets ?? (opts.ecosystem === "npm" ? NPM_TARGETS : PYPI_TARGETS);
  const tasks: BenchTask[] = [];
  const seenRepos = new Set<string>(opts.excludeRepos ?? []);
  for (const target of targets) {
    if (tasks.length >= opts.want) break;
    const q = encodeURIComponent(
      `is:pr is:merged author:app/dependabot in:title "bump ${target} from"${opts.merged ? ` merged:${opts.merged}` : ""}`,
    );
    // Search API allows ~30 requests/minute when authenticated; stay well under it.
    await pause(2500);
    let items: SearchItem[] = [];
    try {
      items = (
        await gh<{ items: SearchItem[] }>(
          `/search/issues?q=${q}&sort=updated&order=desc&per_page=100`,
          3600,
        )
      ).items;
    } catch (err) {
      log(`  ! search ${target}: ${err instanceof Error ? err.message.slice(0, 120) : err}`);
      continue;
    }
    let found = 0;
    for (const item of items) {
      if (tasks.length >= opts.want || found >= (opts.perTarget ?? 2)) break; // spread tasks across libraries
      const t = parseTitle(item.title);
      if (!t || t.dir || t.pkg.toLowerCase() !== target.toLowerCase() || !isMajor(t.from, t.to))
        continue;
      const repoPath = item.repository_url.replace("https://api.github.com/repos/", "");
      if (seenRepos.has(repoPath)) continue;
      try {
        await pause(300);
        const commits = await gh<PrCommit[]>(
          `/repos/${repoPath}/pulls/${item.number}/commits?per_page=50`,
        );
        if (commits.length < 2 || commits.length > 10) continue;
        const first = commits[0];
        const base = first?.parents[0]?.sha;
        if (!first || !base || !/dependabot/i.test(first.author?.login ?? "")) continue;
        const human = commits
          .slice(1)
          .filter(
            (c) => !/dependabot|\[bot\]/i.test(c.author?.login ?? c.commit.author?.name ?? ""),
          );
        if (!human.length) continue;
        const files = new Set<string>();
        for (const c of human) {
          await pause(300);
          const d = await gh<CommitDetail>(`/repos/${repoPath}/commits/${c.sha}`);
          for (const f of d.files ?? [])
            if (SOURCE.test(f.filename) && !MANIFEST.test(f.filename)) files.add(f.filename);
        }
        if (!files.size || files.size > 15) continue;
        // Dependabot titles look the same in every ecosystem: confirm the package is a
        // root dependency of this ecosystem's manifest at the base commit.
        if (!(await isRootDependency(opts.ecosystem, repoPath, base, t.pkg))) continue;
        seenRepos.add(repoPath);
        found += 1;
        tasks.push({
          id: `${repoPath.replace("/", "__")}__${item.number}`,
          ecosystem: opts.ecosystem,
          repo: `https://github.com/${repoPath}.git`,
          ref: base,
          packageName: t.pkg,
          from: semver.coerce(t.from)?.version ?? t.from,
          to: t.to,
          pr_url: item.html_url,
          human_files: [...files].sort(),
          merged_at: item.pull_request?.merged_at ?? "",
        });
        await opts.onTask?.(tasks);
        log(
          `  + ${repoPath}#${item.number}: ${t.pkg} ${t.from} -> ${t.to} (${files.size} human-fixed files)`,
        );
      } catch (err) {
        log(
          `  ! ${repoPath}#${item.number}: ${err instanceof Error ? err.message.slice(0, 120) : err}`,
        );
      }
    }
    log(`${target}: ${items.length} PRs searched, ${found} task(s); total ${tasks.length}`);
  }
  return tasks;
}

export async function saveTasks(path: string, tasks: BenchTask[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(tasks, null, 2)}\n`);
}
