import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../util/proc.ts";
import type { Sandbox } from "./sandbox.ts";

/**
 * Public git dependencies (`pkg @ git+https://github.com/o/r@ref`). The sandbox has no
 * route to GitHub, so the trusted host clones each one (https, public hosts only, hooks
 * off, no credentials) and copies it in; git inside the sandbox is pointed at the local
 * copy with `url.<local>.insteadOf`. Nothing from the sandbox ever reaches these hosts.
 */

const HOSTS = "github\\.com|gitlab\\.com|bitbucket\\.org|codeberg\\.org";
const GIT_URL = new RegExp(
  `git\\+(https://(?:${HOSTS})/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\\.git)?(?:@([^#\\s"';,]+))?(?=[#\\s"';,]|$)`,
  "g",
);

export interface GitDep {
  /** Canonical https URL without ".git". */
  url: string;
  /** Branches, tags or commits referenced with "@ref"; empty means the default branch. */
  refs: string[];
}

/** Public git dependencies (URL and refs) referenced by these texts. */
export function gitDependencies(texts: string[]): GitDep[] {
  const byUrl = new Map<string, Set<string>>();
  for (const t of texts)
    for (const m of t.matchAll(GIT_URL)) {
      if (!m[1]) continue;
      const refs = byUrl.get(m[1]) ?? new Set<string>();
      if (m[2] && /^[\w./-]{1,100}$/.test(m[2])) refs.add(m[2]);
      byUrl.set(m[1], refs);
    }
  return [...byUrl.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 10)
    .map(([url, refs]) => ({ url, refs: [...refs].sort() }));
}

/** Just the URLs, for messages and tests. */
export function gitDependencyUrls(texts: string[]): string[] {
  return gitDependencies(texts).map((d) => d.url);
}

export interface FetchedGitDep {
  url: string;
  /** Bare repository directory on the host. */
  hostDir: string;
  name: string;
}

const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" };
const git = (args: string[], timeoutMs = 5 * 60_000) =>
  run("git", ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...args], {
    timeoutMs,
    env: gitEnv,
  });

/**
 * Fetch only what the manifests reference (depth 1) into a bare repository on the host:
 * the default branch, and each @ref as a branch, a tag or a commit. Large repositories
 * stay cheap. Failures are returned, not thrown.
 */
export async function fetchGitDeps(
  deps: GitDep[],
  workDir: string,
): Promise<{ fetched: FetchedGitDep[]; failed: string[] }> {
  const fetched: FetchedGitDep[] = [];
  const failed: string[] = [];
  await mkdir(workDir, { recursive: true });
  for (const [i, dep] of deps.entries()) {
    const name = `${i}-${dep.url
      .split("/")
      .pop()
      ?.replace(/[^A-Za-z0-9_.-]/g, "_")}.git`;
    const hostDir = join(workDir, name);
    const remote = `${dep.url}.git`;
    await git(["init", "--bare", "-q", hostDir]);
    const fetch = (spec: string) =>
      git(["-C", hostDir, "fetch", "--quiet", "--depth", "1", "--no-tags", remote, spec]);
    const head = await fetch("+HEAD:refs/heads/bumpsmith-default");
    let ok = head.exitCode === 0;
    if (ok) await git(["-C", hostDir, "symbolic-ref", "HEAD", "refs/heads/bumpsmith-default"]);
    let lastErr = head.stderr;
    for (const ref of dep.refs) {
      const attempts = [
        `+refs/heads/${ref}:refs/heads/${ref}`,
        `+refs/tags/${ref}:refs/tags/${ref}`,
        ...(/^[0-9a-f]{7,40}$/.test(ref)
          ? [`+${ref}:refs/heads/bumpsmith-${ref.slice(0, 12)}`]
          : []),
      ];
      let got = false;
      for (const spec of attempts) {
        const r = await fetch(spec);
        if (r.exitCode === 0) {
          got = true;
          break;
        }
        lastErr = r.stderr;
      }
      ok = ok && got;
    }
    if (ok) fetched.push({ url: dep.url, hostDir, name });
    else
      failed.push(
        `${dep.url} (${lastErr.trim().split("\n").pop()?.slice(0, 120) || "fetch failed"})`,
      );
  }
  return { fetched, failed };
}

const SANDBOX_GIT_DIR = "/workspace/.bumpsmith-cache/git";

/** Git config that serves each fetched URL from its local copy inside the sandbox. */
export function gitInsteadOfConfig(deps: FetchedGitDep[]): string {
  const lines = ['[protocol "file"]', "\tallow = always", "[safe]", "\tdirectory = *"];
  for (const d of deps) {
    lines.push(`[url "file://${SANDBOX_GIT_DIR}/${d.name}"]`);
    for (const v of [d.url, `${d.url}.git`, `${d.url}/`]) lines.push(`\tinsteadOf = ${v}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Copy fetched repositories into the sandbox and install the git config. */
export async function installGitDeps(sb: Sandbox, deps: FetchedGitDep[], workDir: string) {
  if (!deps.length) return;
  await sb.copyIn(workDir, SANDBOX_GIT_DIR);
  await sb.exec(["sh", "-c", 'cat > "$HOME/.gitconfig"'], {
    input: gitInsteadOfConfig(deps),
    timeoutSec: 30,
  });
}

/** Manifest texts of a Python project, for scanning. */
export async function readManifests(root: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    try {
      out.push(await readFile(join(root, f), "utf8"));
    } catch {
      // missing manifest
    }
  }
  return out;
}
