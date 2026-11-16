import semver from "semver";
import { latestRelease } from "../registry/registry.ts";
import type { BotUpgrade } from "../rescue/bot-pr.ts";
import type { Inventory } from "./inventory.ts";

/**
 * Upgrade-debt report (INV-7, INV-8): which direct dependencies are a major (or more)
 * behind, how old the newest release is, and which open Dependabot/Renovate PRs are red
 * and could be rescued. Computed from public registry data plus the repo's manifests.
 */

export interface DebtItem {
  package: string;
  current: string | null;
  latest: string | null;
  majorsBehind: number;
  latestPublishedAt: string | null;
  /** Eligible under the release-age rule today. */
  latestEligible: boolean;
}

export interface BotPrItem {
  number: number;
  title: string;
  bot: string;
  package: string | null;
  to: string | null;
  ageDays: number;
  checks: "failing" | "passing" | "pending" | "none";
  attemptable: boolean;
  reason: string | null;
}

export interface DebtReport {
  generatedAt: string;
  commit: string;
  ecosystem: string;
  packageManager: string;
  directDependencies: number;
  behind: DebtItem[];
  botPullRequests: BotPrItem[];
  unsupported: string[];
}

export function majorsBehind(current: string | null, latest: string | null): number {
  const a = semver.coerce(current ?? "");
  const b = semver.coerce(latest ?? "");
  if (!a || !b) return 0;
  if (b.major > a.major) return b.major - a.major;
  // 0.x: a minor bump is breaking.
  if (a.major === 0 && b.major === 0 && b.minor > a.minor) return 1;
  return 0;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx] as T);
      }
    }),
  );
  return out;
}

export async function computeDebt(opts: {
  inv: Inventory;
  commit: string;
  resolved: Map<string, string>;
  botPrs: {
    number: number;
    title: string;
    createdAt: string;
    checks: BotPrItem["checks"];
    parsed: BotUpgrade | null;
  }[];
  unsupported: string[];
  minReleaseAgeDays: number;
  now?: Date;
}): Promise<DebtReport> {
  const now = opts.now ?? new Date();
  const eco = opts.inv.ecosystem;
  const names = Object.keys(opts.inv.dependencies).slice(0, 500);
  const items = await mapLimit(names, 8, async (name): Promise<DebtItem> => {
    const current =
      opts.resolved.get(name) ??
      semver.minVersion(opts.inv.dependencies[name]?.replace(/^==/, "") ?? "")?.version ??
      null;
    const latest = await latestRelease(eco, name);
    const age = latest?.publishedAt
      ? (now.getTime() - latest.publishedAt.getTime()) / 86_400_000
      : null;
    return {
      package: name,
      current,
      latest: latest?.version ?? null,
      majorsBehind: majorsBehind(current, latest?.version ?? null),
      latestPublishedAt: latest?.publishedAt?.toISOString() ?? null,
      latestEligible: age !== null && age >= opts.minReleaseAgeDays,
    };
  });
  const botPullRequests = opts.botPrs.map((p): BotPrItem => {
    const reason = !p.parsed
      ? "not a single-package update"
      : p.parsed.dir && p.parsed.dir !== "/"
        ? `updates a sub-directory (${p.parsed.dir}); not supported yet`
        : opts.unsupported.length
          ? (opts.unsupported[0] ?? null)
          : null;
    return {
      number: p.number,
      title: p.title.slice(0, 200),
      bot: p.parsed?.bot ?? "unknown",
      package: p.parsed?.pkg ?? null,
      to: p.parsed?.to ?? null,
      ageDays: Math.floor((now.getTime() - Date.parse(p.createdAt)) / 86_400_000),
      checks: p.checks,
      attemptable: reason === null && p.checks === "failing",
      reason,
    };
  });
  return {
    generatedAt: now.toISOString(),
    commit: opts.commit,
    ecosystem: eco,
    packageManager: opts.inv.packageManager,
    directDependencies: names.length,
    behind: items.filter((i) => i.majorsBehind > 0).sort((a, b) => b.majorsBehind - a.majorsBehind),
    botPullRequests,
    unsupported: opts.unsupported,
  };
}
