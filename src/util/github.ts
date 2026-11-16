import { fetchJson, fetchText } from "./http.ts";

/** GitHub REST API version (docs.github.com/en/rest/about-the-rest-api/api-versions). */
export const GITHUB_API_VERSION = "2026-03-10";

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": GITHUB_API_VERSION,
  };
  // Host-side only, read-only public data. Never forwarded into a sandbox.
  const token = process.env.GITHUB_TOKEN;
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

export function parseGithubRepo(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /github\.com[/:]([^/]+)\/([^/#?]+)/.exec(url);
  if (!m?.[1] || !m[2]) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

export function gh<T>(path: string, cacheSeconds = 3600): Promise<T> {
  return fetchJson<T>(`https://api.github.com${path}`, { headers: headers(), cacheSeconds });
}

export interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
}

export async function listReleases(owner: string, repo: string, pages = 3): Promise<GhRelease[]> {
  const out: GhRelease[] = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await gh<GhRelease[]>(
      `/repos/${owner}/${repo}/releases?per_page=100&page=${page}`,
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

/** Fetch a file from the default branch via raw.githubusercontent.com; null if missing. */
export async function rawFile(
  owner: string,
  repo: string,
  path: string,
  ref = "HEAD",
): Promise<string | null> {
  try {
    return await fetchText(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, {
      cacheSeconds: 3600,
    });
  } catch {
    return null;
  }
}
