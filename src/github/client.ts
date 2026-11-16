import { Octokit } from "@octokit/core";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { GITHUB_API_VERSION } from "../util/github.ts";

/**
 * GitHub API clients. Throttling honours primary and secondary rate limits (GH-10) and
 * serialises writes; retry handles transient 5xx. Every request pins the REST API version.
 */
export const BumpsmithOctokit = Octokit.plugin(throttling, retry);
export type GitHubClient = InstanceType<typeof BumpsmithOctokit>;

export interface ClientOptions {
  baseUrl?: string;
  userAgent?: string;
  log?: (msg: string) => void;
}

const MAX_RATE_RETRIES = 2;

export function clientDefaults(opts: ClientOptions) {
  const log = opts.log ?? (() => {});
  return {
    baseUrl: opts.baseUrl ?? "https://api.github.com",
    userAgent: opts.userAgent ?? "bumpsmith-app",
    request: { headers: { "x-github-api-version": GITHUB_API_VERSION } },
    throttle: {
      onRateLimit: (
        retryAfter: number,
        o: { method: string; url: string },
        _o: unknown,
        n: number,
      ) => {
        log(`rate limited on ${o.method} ${o.url}; retry in ${retryAfter}s (attempt ${n + 1})`);
        return n < MAX_RATE_RETRIES;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        o: { method: string; url: string },
        _o: unknown,
        n: number,
      ) => {
        log(`secondary rate limit on ${o.method} ${o.url}; retry in ${retryAfter}s`);
        return n < MAX_RATE_RETRIES;
      },
    },
    retry: { doNotRetry: [400, 401, 403, 404, 409, 410, 422, 451] },
  };
}

/** Authenticated with a short-lived installation token handed out by the broker. */
export function tokenClient(token: string, opts: ClientOptions = {}): GitHubClient {
  return new BumpsmithOctokit({ ...clientDefaults(opts), auth: token });
}

export type Permission = "read" | "write";
export type PermissionSet = Partial<
  Record<
    "contents" | "pull_requests" | "metadata" | "checks" | "statuses" | "issues" | "actions",
    Permission
  >
>;

export interface InstallationToken {
  token: string;
  expiresAt: string;
  permissions: PermissionSet;
  repositoryIds: string[] | null;
}
