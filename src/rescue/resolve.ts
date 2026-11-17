import semver from "semver";
import type { GitHubClient } from "../github/client.ts";

/** npm or PyPI: Dependabot encodes it in the branch name; otherwise look at the changed files. */
export async function botPrEcosystem(
  gh: GitHubClient,
  owner: string,
  repo: string,
  prNumber: number,
  headRef: string,
): Promise<"npm" | "pypi" | null> {
  if (/^dependabot\/(npm_and_yarn|bun|npm)\//.test(headRef)) return "npm";
  if (/^dependabot\/(pip|uv|poetry|pipenv)\//.test(headRef)) return "pypi";
  // Any other Dependabot ecosystem (github_actions, go_modules, cargo, maven, docker, ...).
  if (/^dependabot\//.test(headRef)) return null;
  const files = (
    await gh.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    })
  ).data;
  if (
    files.some((f) =>
      /(^|\/)(pyproject\.toml|requirements[^/]*\.(txt|in)|poetry\.lock|uv\.lock|pdm\.lock|Pipfile(\.lock)?|setup\.(py|cfg))$/.test(
        f.filename,
      ),
    )
  )
    return "pypi";
  if (
    files.some((f) =>
      /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(
        f.filename,
      ),
    )
  )
    return "npm";
  return null;
}

/** Dependabot's ecosystem name from its branch, for a plain "not supported" message. */
export function botEcosystemName(headRef: string): string {
  return /^dependabot\/([^/]+)\//.exec(headRef)?.[1]?.replace(/_/g, " ") ?? "this ecosystem";
}

/** Renovate titles may name only a major ("to v5"); read the exact version from the PR's manifest. */
export async function exactTarget(
  gh: GitHubClient,
  owner: string,
  repo: string,
  headSha: string,
  pkg: string,
  to: string,
): Promise<string | null> {
  if (semver.valid(to)) return to;
  try {
    const r = await gh.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: "package.json",
      ref: headSha,
      headers: { accept: "application/vnd.github.raw+json" },
    });
    const pj = JSON.parse(String(r.data)) as Record<string, Record<string, string> | undefined>;
    const range =
      pj.dependencies?.[pkg] ?? pj.devDependencies?.[pkg] ?? pj.optionalDependencies?.[pkg];
    return range ? (semver.minVersion(range)?.version ?? null) : null;
  } catch {
    return null;
  }
}
