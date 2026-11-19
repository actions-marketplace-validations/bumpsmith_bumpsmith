import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = join(process.cwd(), ".cache", "http");
const USER_AGENT = "bumpsmith-phase0 (+https://github.com/)";

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 200)}`);
    this.name = "HttpError";
  }
}

interface FetchOptions {
  headers?: Record<string, string>;
  /** Cache successful responses on disk for this many seconds (public data only). */
  cacheSeconds?: number;
  method?: "GET" | "POST";
  body?: string;
  timeoutMs?: number;
  /** Longest rate-limit wait worth sitting through before giving up (default 60 s). */
  maxRateLimitWaitMs?: number;
}

/**
 * Fetch for public data (registries, changelogs, GitHub public API).
 * Never call this with customer data in the URL or body.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const key = createHash("sha256")
    .update(`${opts.method ?? "GET"} ${url} ${opts.body ?? ""}`)
    .digest("hex");
  const path = join(CACHE_DIR, `${key}.json`);
  if (opts.cacheSeconds) {
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as { at: number; body: string };
      if (Date.now() - cached.at < opts.cacheSeconds * 1000) return cached.body;
    } catch {
      // cache miss
    }
  }
  let res: Response | null = null;
  let body = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: { "user-agent": USER_AGENT, ...opts.headers },
        body: opts.body,
        redirect: "follow",
        // Later attempts get more time: large packuments (e.g. date-fns) can exceed 30 s.
        signal: AbortSignal.timeout((opts.timeoutMs ?? 30_000) * (attempt + 1)),
      });
      body = await res.text();
    } catch (err) {
      // Timeouts and connection resets are transient; retry with backoff.
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    // Rate limited: honour retry-after / x-ratelimit-reset (GitHub, registries), then retry.
    const limited =
      res.status === 429 ||
      (res.status === 403 &&
        (/rate limit/i.test(body) || res.headers.get("x-ratelimit-remaining") === "0"));
    if (!limited || attempt === 3) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Number.isFinite(reset) && reset > 0
          ? Math.max(1000, reset * 1000 - Date.now())
          : 60_000 * 2 ** attempt; // GitHub: wait at least a minute, then back off exponentially
    // Wait out short limits only. A long one (GitHub's unauthenticated hourly quota) would stall
    // the whole run for many minutes, so fail now; callers treat these sources as optional.
    if (waitMs > (opts.maxRateLimitWaitMs ?? 60_000)) {
      const hint = /api\.github\.com/.test(url)
        ? " Set GITHUB_TOKEN to raise GitHub's rate limit."
        : "";
      throw new HttpError(
        url,
        res.status,
        `rate limited for ${Math.round(waitMs / 1000)}s.${hint}`,
      );
    }
    await new Promise((r) => setTimeout(r, waitMs));
  }
  if (!res?.ok) throw new HttpError(url, res?.status ?? 0, body);
  if (opts.cacheSeconds) {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, JSON.stringify({ at: Date.now(), body }));
  }
  return body;
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  return JSON.parse(await fetchText(url, opts)) as T;
}
