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
  `git\\+(https://(?:${HOSTS})/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\\.git)?(?=[@#\\s"';,]|$)`,
  "g",
);

/** Public git repository URLs (canonical, without ".git") referenced by these texts. */
export function gitDependencyUrls(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(GIT_URL)) if (m[1]) out.add(m[1]);
  return [...out].sort().slice(0, 10);
}

export interface FetchedGitDep {
  url: string;
  /** Bare repository directory on the host. */
  hostDir: string;
  name: string;
}

/** Clone each URL on the host as a bare repository. Failures are returned, not thrown. */
export async function fetchGitDeps(
  urls: string[],
  workDir: string,
): Promise<{ fetched: FetchedGitDep[]; failed: string[] }> {
  const fetched: FetchedGitDep[] = [];
  const failed: string[] = [];
  await mkdir(workDir, { recursive: true });
  for (const [i, url] of urls.entries()) {
    const name = `${i}-${url
      .split("/")
      .slice(-1)[0]
      ?.replace(/[^A-Za-z0-9_.-]/g, "_")}.git`;
    const hostDir = join(workDir, name);
    const r = await run(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "clone",
        "--bare",
        "--quiet",
        `${url}.git`,
        hostDir,
      ],
      {
        timeoutMs: 5 * 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
      },
    );
    if (r.exitCode === 0) fetched.push({ url, hostDir, name });
    else
      failed.push(`${url} (${r.stderr.trim().split("\n").pop()?.slice(0, 120) ?? "clone failed"})`);
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
