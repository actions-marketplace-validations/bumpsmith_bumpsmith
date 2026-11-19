import type { Ecosystem } from "../schemas/job.ts";
import { fetchJson, HttpError } from "../util/http.ts";

export interface ReleaseInfo {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  publishedAt: Date | null;
  yanked: boolean;
  deprecated: string | null;
  repositoryUrl: string | null;
  homepage: string | null;
  minRuntime: string | null;
}

interface NpmPackument {
  time?: Record<string, string>;
  versions: Record<
    string,
    {
      deprecated?: string;
      repository?: string | { url?: string; directory?: string };
      homepage?: string;
      engines?: { node?: string };
    }
  >;
  repository?: string | { url?: string };
}

interface PypiRelease {
  info: {
    yanked: boolean;
    yanked_reason: string | null;
    requires_python: string | null;
    project_urls: Record<string, string> | null;
    home_page: string | null;
  };
  urls: { upload_time_iso_8601: string }[];
}

export function normaliseRepoUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let url = raw
    .trim()
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  url = url.replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
  url = url.replace(/^git@github\.com:/, "https://github.com/");
  if (/^github:/.test(url)) url = url.replace(/^github:/, "https://github.com/");
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url.startsWith("http") ? url : null;
}

const npmName = (name: string) => name.replace("/", "%2f");

export async function getRelease(
  ecosystem: Ecosystem,
  name: string,
  version: string,
): Promise<ReleaseInfo> {
  if (ecosystem === "npm") {
    const doc = await fetchJson<NpmPackument>(`https://registry.npmjs.org/${npmName(name)}`, {
      cacheSeconds: 3600,
    });
    const v = doc.versions[version];
    if (!v) throw new Error(`npm: ${name}@${version} not found`);
    const repo = typeof v.repository === "string" ? v.repository : v.repository?.url;
    const topRepo = typeof doc.repository === "string" ? doc.repository : doc.repository?.url;
    const t = doc.time?.[version];
    return {
      ecosystem,
      name,
      version,
      publishedAt: t ? new Date(t) : null,
      yanked: false,
      deprecated: v.deprecated ?? null,
      repositoryUrl: normaliseRepoUrl(repo ?? topRepo),
      homepage: v.homepage ?? null,
      minRuntime: v.engines?.node ?? null,
    };
  }
  const doc = await fetchJson<PypiRelease>(
    `https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`,
    { cacheSeconds: 3600 },
  );
  const times = doc.urls.map((u) => Date.parse(u.upload_time_iso_8601)).filter(Number.isFinite);
  const urls = doc.info.project_urls ?? {};
  const repo = pickPypiRepo({
    ...urls,
    ...(doc.info.home_page ? { "home page": doc.info.home_page } : {}),
  });
  return {
    ecosystem,
    name,
    version,
    publishedAt: times.length ? new Date(Math.min(...times)) : null,
    yanked: doc.info.yanked,
    deprecated: doc.info.yanked ? (doc.info.yanked_reason ?? "yanked") : null,
    repositoryUrl: normaliseRepoUrl(repo),
    homepage: doc.info.home_page ?? urls.Homepage ?? null,
    minRuntime: doc.info.requires_python,
  };
}

/** Required (non-optional) peer dependencies of an npm package version. */
/** Required (non-optional) peer dependencies of an exact npm version, name -> range. */
export async function npmPeerRanges(
  name: string,
  version: string,
): Promise<Record<string, string>> {
  try {
    const doc = await fetchJson<{
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }>(`https://registry.npmjs.org/${npmName(name)}/${encodeURIComponent(version)}`, {
      cacheSeconds: 86_400,
    });
    return Object.fromEntries(
      Object.entries(doc.peerDependencies ?? {}).filter(
        ([p]) => !doc.peerDependenciesMeta?.[p]?.optional,
      ),
    );
  } catch {
    return {};
  }
}

export async function npmPeerDependencies(name: string, version: string): Promise<string[]> {
  return Object.keys(await npmPeerRanges(name, version));
}

export interface MaliciousCheck {
  malicious: boolean;
  ids: string[];
}

/** Query OSV for known-malicious advisories on an exact version (CHG-10).
 *  Only MAL- advisories count (an ordinary CVE that mentions "malicious input" is not a malicious
 *  package). Fails closed: if OSV can't be read completely, the release is treated as unsafe. */
export async function checkMalicious(
  ecosystem: Ecosystem,
  name: string,
  version: string,
): Promise<MaliciousCheck> {
  type Vuln = { id: string; aliases?: string[] };
  const vulns: Vuln[] = [];
  try {
    let pageToken: string | undefined;
    // OSV may answer with only a next_page_token when a query takes too long: keep asking.
    for (let page = 0; page < 10; page++) {
      const res = await fetchJson<{ vulns?: Vuln[]; next_page_token?: string }>(
        "https://api.osv.dev/v1/query",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            package: { name, ecosystem: ecosystem === "npm" ? "npm" : "PyPI" },
            version,
            ...(pageToken ? { page_token: pageToken } : {}),
          }),
          cacheSeconds: 3600,
        },
      );
      vulns.push(...(res.vulns ?? []));
      pageToken = res.next_page_token;
      if (!pageToken) break;
    }
    if (pageToken) return { malicious: true, ids: ["OSV answer incomplete"] };
  } catch (err) {
    if (err instanceof HttpError) return { malicious: true, ids: ["OSV unavailable"] };
    throw err;
  }
  const isMal = (id: string) => id.startsWith("MAL-");
  const mal = vulns.filter((v) => isMal(v.id) || (v.aliases ?? []).some(isMal));
  return { malicious: mal.length > 0, ids: mal.map((v) => v.id) };
}

export interface GateResult {
  allowed: boolean;
  reasons: string[];
  ageDays: number | null;
}

/** Release-age, yanked, deprecated and malicious-version gate (CHG-9, CHG-10). */
export function releaseGate(
  release: ReleaseInfo,
  malicious: MaliciousCheck,
  minAgeDays: number,
  now = new Date(),
): GateResult {
  const reasons: string[] = [];
  const ageDays = release.publishedAt
    ? (now.getTime() - release.publishedAt.getTime()) / 86_400_000
    : null;
  if (ageDays === null) reasons.push("publish time unknown");
  else if (ageDays < minAgeDays)
    reasons.push(`published ${ageDays.toFixed(1)} days ago; minimum is ${minAgeDays}`);
  if (release.yanked) reasons.push("version is yanked");
  if (release.deprecated) reasons.push(`version is deprecated: ${release.deprecated}`);
  if (malicious.malicious) reasons.push(`listed as malicious: ${malicious.ids.join(", ")}`);
  return { allowed: reasons.length === 0, reasons, ageDays };
}

/** Latest stable version and its publish time (for the upgrade-debt report, INV-8). */
export async function latestRelease(
  ecosystem: Ecosystem,
  name: string,
): Promise<{ version: string; publishedAt: Date | null } | null> {
  try {
    if (ecosystem === "npm") {
      const doc = await fetchJson<{
        "dist-tags"?: { latest?: string };
        time?: Record<string, string>;
      }>(`https://registry.npmjs.org/${npmName(name)}`, { cacheSeconds: 3600 });
      const v = doc["dist-tags"]?.latest;
      if (!v) return null;
      const t = doc.time?.[v];
      return { version: v, publishedAt: t ? new Date(t) : null };
    }
    const doc = await fetchJson<{
      info: { version: string };
      urls?: { upload_time_iso_8601: string }[];
    }>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { cacheSeconds: 3600 });
    const times = (doc.urls ?? [])
      .map((u) => Date.parse(u.upload_time_iso_8601))
      .filter(Number.isFinite);
    return {
      version: doc.info.version,
      publishedAt: times.length ? new Date(Math.min(...times)) : null,
    };
  } catch {
    return null;
  }
}

/** Repository paths on code hosts that are not repositories (sponsors, orgs, docs, …). */
const NON_REPO =
  /^(sponsors|orgs|organizations|features|marketplace|apps|about|topics|collections|login|settings)$/i;

/**
 * The source repository from PyPI project_urls. Prefers keys that name the source
 * (Source, Repository, Code), then any GitHub/GitLab link that is a real owner/repo path,
 * skipping Funding/Sponsors, documentation and changelog sites.
 */
export function pickPypiRepo(urls: Record<string, string>): string | null {
  const isRepo = (v: string) => {
    try {
      const u = new URL(v);
      if (!/(^|\.)(github\.com|gitlab\.com|codeberg\.org|bitbucket\.org)$/.test(u.hostname))
        return false;
      const [owner, repo] = u.pathname.split("/").filter(Boolean);
      return !!owner && !!repo && !NON_REPO.test(owner);
    } catch {
      return false;
    }
  };
  const entries = Object.entries(urls).filter(([k]) => !/fund|sponsor|donat|tidelift/i.test(k));
  const byKey = entries.find(
    ([k, v]) => /^(source( code)?|repository|repo|code|github)$/i.test(k.trim()) && isRepo(v),
  );
  return byKey?.[1] ?? entries.find(([, v]) => isRepo(v))?.[1] ?? null;
}
