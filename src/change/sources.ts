import semver from "semver";
import { listReleases, parseGithubRepo, rawFile } from "../util/github.ts";

export interface SourceDoc {
  kind: "migration_guide" | "changelog" | "release_notes" | "api_diff";
  url: string;
  text: string;
}

const MAX_SOURCE_CHARS = 60_000;

function versionOf(tag: string): string | null {
  const cleaned = tag.replace(/^[^\d]*/, "");
  return semver.valid(semver.coerce(cleaned, { includePrerelease: false })?.version ?? null);
}

/**
 * Cut a CHANGELOG down to the sections for versions in (from, to].
 * Headings like "## 5.0", "## [5.0.0] - 2023", "# v5.0.0" are recognised.
 */
export function sliceChangelog(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const sections: { version: string | null; start: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^#{1,3}\s+\[?v?(\d+\.\d+(?:\.\d+)?)/.exec(line);
    if (m?.[1]) sections.push({ version: semver.coerce(m[1])?.version ?? null, start: i });
  });
  if (!sections.length) return text.slice(0, MAX_SOURCE_CHARS);
  const keep: string[] = [];
  sections.forEach((s, idx) => {
    if (!s.version) return;
    if (semver.gt(s.version, from) && semver.lte(s.version, to)) {
      const end = sections[idx + 1]?.start ?? lines.length;
      keep.push(lines.slice(s.start, end).join("\n"));
    }
  });
  return keep.join("\n").slice(0, MAX_SOURCE_CHARS);
}

const CHANGELOG_NAMES = [
  "CHANGELOG.md",
  "CHANGES.md",
  "HISTORY.md",
  "changelog.md",
  "CHANGELOG.rst",
  "docs/changelog.md",
];
const MIGRATION_NAMES = [
  "MIGRATION.md",
  "UPGRADING.md",
  "UPGRADE.md",
  "docs/migration.md",
  "docs/MIGRATION.md",
];

/** Gather upstream sources for a version pair (CHG-2). Public data only. */
export async function gatherSources(
  repositoryUrl: string | null,
  from: string,
  to: string,
): Promise<SourceDoc[]> {
  const gh = parseGithubRepo(repositoryUrl);
  if (!gh) return [];
  const docs: SourceDoc[] = [];

  for (const name of MIGRATION_NAMES) {
    const text = await rawFile(gh.owner, gh.repo, name);
    if (text) {
      docs.push({
        kind: "migration_guide",
        url: `https://github.com/${gh.owner}/${gh.repo}/blob/HEAD/${name}`,
        text: text.slice(0, MAX_SOURCE_CHARS),
      });
      break;
    }
  }

  for (const name of CHANGELOG_NAMES) {
    const text = await rawFile(gh.owner, gh.repo, name);
    if (text) {
      const sliced = sliceChangelog(text, from, to);
      if (sliced.trim())
        docs.push({
          kind: "changelog",
          url: `https://github.com/${gh.owner}/${gh.repo}/blob/HEAD/${name}`,
          text: sliced,
        });
      break;
    }
  }

  try {
    const releases = await listReleases(gh.owner, gh.repo);
    const inRange = releases
      .filter((r) => !r.draft && !r.prerelease)
      .map((r) => ({ r, v: versionOf(r.tag_name) }))
      .filter(
        (x): x is { r: typeof x.r; v: string } =>
          !!x.v && semver.gt(x.v, from) && semver.lte(x.v, to),
      )
      .sort((a, b) => semver.compare(a.v, b.v));
    let budget = MAX_SOURCE_CHARS;
    for (const { r, v } of inRange) {
      const body = (r.body ?? "").trim();
      if (!body || budget <= 0) continue;
      const text = `## ${v}\n${body}`.slice(0, budget);
      budget -= text.length;
      docs.push({ kind: "release_notes", url: r.html_url, text });
    }
  } catch {
    // Releases are optional; rate limits or missing repos should not fail the job.
  }
  return docs;
}
