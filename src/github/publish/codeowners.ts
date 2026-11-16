import type { GitHubClient } from "../client.ts";

/**
 * CODEOWNERS reviewers for the touched files (PR-11). GitHub searches .github/, then the
 * root, then docs/. The last matching pattern wins, as in GitHub's own rules.
 */

const LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export interface CodeownersRule {
  pattern: RegExp;
  owners: string[];
}

/** Convert a CODEOWNERS (gitignore-style) pattern to a regular expression over repo paths. */
export function codeownersPattern(p: string): RegExp {
  let pat = p.trim();
  const anchored = pat.startsWith("/") || pat.slice(0, -1).includes("/");
  pat = pat.replace(/^\//, "");
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i] as string;
    if (c === "*" && pat[i + 1] === "*") {
      re += ".*";
      i++;
      if (pat[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({
      pattern: codeownersPattern(pattern),
      owners: owners.filter((o) => /^@[\w.-]+(\/[\w.-]+)?$/.test(o)),
    });
  }
  return rules;
}

export function ownersFor(rules: CodeownersRule[], path: string): string[] {
  let owners: string[] = [];
  for (const r of rules) if (r.pattern.test(path)) owners = r.owners;
  return owners;
}

export async function codeownersReviewers(
  gh: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
  paths: string[],
): Promise<{ users: string[]; teams: string[] }> {
  let text: string | null = null;
  for (const path of LOCATIONS) {
    try {
      const r = await gh.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo,
        path,
        ref,
        headers: { accept: "application/vnd.github.raw+json" },
      });
      text = String(r.data);
      break;
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  if (!text) return { users: [], teams: [] };
  const rules = parseCodeowners(text);
  const users = new Set<string>();
  const teams = new Set<string>();
  for (const p of paths)
    for (const o of ownersFor(rules, p)) {
      const name = o.slice(1);
      if (name.includes("/")) teams.add(name.split("/")[1] as string);
      else if (!name.endsWith("[bot]")) users.add(name);
    }
  return { users: [...users], teams: [...teams] };
}
