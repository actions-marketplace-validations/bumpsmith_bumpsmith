import { parseTitle } from "../bench/mine.ts";

/** Dependency-update bots whose red pull requests Bumpsmith can rescue (PR-5). */
export const BOT_AUTHORS = new Set(["dependabot[bot]", "renovate[bot]"]);

export interface BotUpgrade {
  bot: "dependabot" | "renovate";
  pkg: string;
  /** Renovate titles often omit the old version; the pipeline reads it from the repo. */
  from: string | null;
  to: string;
  /** Sub-directory the bot updated ("/" or null = repository root). */
  dir: string | null;
}

// Renovate: "Update dependency zod to v4", "chore(deps): update dependency @types/node to v22.10.1",
// "fix(deps): update zod to v4.1.0", "Update vitest to v5 (major)".
const RENOVATE =
  /update (?:dependency |module )?(@?[\w.-]+(?:\/[\w.-]+)?) to v?(\d+(?:\.\d+){0,2}[\w.+-]*)/i;

export function parseBotPr(title: string, author: string): BotUpgrade | null {
  if (!BOT_AUTHORS.has(author)) return null;
  if (author === "dependabot[bot]") {
    // Grouped updates ("Bump the npm group with 3 updates") are not single upgrades.
    if (/\bgroup\b/i.test(title)) return null;
    const p = parseTitle(title);
    return p ? { bot: "dependabot", pkg: p.pkg, from: p.from, to: p.to, dir: p.dir } : null;
  }
  if (/\b(lock file maintenance|all non-major|monorepo)\b/i.test(title)) return null;
  const m = RENOVATE.exec(title);
  if (!m?.[1] || !m[2]) return null;
  return { bot: "renovate", pkg: m[1], from: null, to: m[2], dir: null };
}

export interface GroupedUpdate {
  pkg: string;
  from: string | null;
  to: string;
}

/**
 * The packages of a grouped update, from the PR body. Dependabot writes
 * "Updates `eslint` from 8.57.0 to 9.1.0"; Renovate writes a table row with
 * "[pkg](...) | ... | `1.2.3` -> `2.0.0`".
 */
export function parseGroupedUpdates(body: string): GroupedUpdate[] {
  const out = new Map<string, GroupedUpdate>();
  for (const m of body.matchAll(/Updates? `(@?[\w./-]+)` from ([\w.+-]+) to ([\w.+-]+)/g))
    if (m[1] && m[3]) out.set(m[1], { pkg: m[1], from: m[2] ?? null, to: m[3] });
  for (const m of body.matchAll(
    /^\|\s*\[?(@?[\w./-]+)\]?(?:\([^)]*\))?\s*\|.*?`\^?~?v?([\w.+-]+)`\s*(?:->|→)\s*`\^?~?v?([\w.+-]+)`/gm,
  ))
    if (m[1] && m[3] && !out.has(m[1])) out.set(m[1], { pkg: m[1], from: m[2] ?? null, to: m[3] });
  return [...out.values()].slice(0, 20);
}
