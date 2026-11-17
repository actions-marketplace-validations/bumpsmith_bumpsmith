import { posix } from "node:path";

/**
 * Hard denylist (FIX-4). Never editable by the agent, never overridable by repo config.
 * Patterns are matched against the normalised repo-relative path.
 */
const DENY: RegExp[] = [
  /^\.github\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.gitlab\//,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.travis\.ya?ml$/,
  /^azure-pipelines\.ya?ml$/,
  /^Jenkinsfile$/,
  /^bitbucket-pipelines\.ya?ml$/,
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc(\.ya?ml)?$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)pip\.conf$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.git(\/|$)/,
  /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(deploy|deployment|infra|infrastructure|terraform|\.terraform|k8s|kubernetes|helm|charts)\//,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /(^|\/)(LICEN[CS]E|COPYING)(\.[a-z]+)?$/i,
  /(^|\/)\.bumpsmith\.ya?ml$/,
  /(^|\/)AGENTS\.md$/,
];

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Normalise and confine a model-supplied path to the workspace root. */
export function normalisePath(raw: string): string {
  if (typeof raw !== "string" || !raw.trim()) throw new PolicyError("path is empty");
  if (raw.includes("\0")) throw new PolicyError("path contains a NUL byte");
  if (/%2e|%2f|%5c/i.test(raw)) throw new PolicyError("encoded path characters are not allowed");
  let p = raw.trim().replace(/\\/g, "/");
  if (p.startsWith("/workspace/")) p = p.slice("/workspace/".length);
  if (p.startsWith("/")) throw new PolicyError("absolute paths are not allowed");
  p = posix.normalize(p);
  if (p === "." || p === "") return ".";
  if (p === ".." || p.startsWith("../")) throw new PolicyError("path escapes the workspace");
  return p.replace(/\/$/, "");
}

export function isDenied(path: string): boolean {
  return DENY.some((re) => re.test(path));
}

export interface EditRecord {
  path: string;
  allowlisted: boolean;
  reason: string | null;
}

/**
 * Edit allowlist (FIX-3): manifests, lockfiles, Impact Map files and files that
 * failed to compile after the bump. Other files may be edited only with a reason,
 * which is recorded and shown in the evidence.
 */
export class EditPolicy {
  private readonly allow = new Set<string>();
  readonly edits = new Map<string, EditRecord>();

  constructor(
    allowlisted: Iterable<string>,
    /** Extra protected paths from .bumpsmith.yml (can only add to the hard denylist). */
    private readonly extraDenied: string[] = [],
  ) {
    for (const p of allowlisted) this.addAllowed(p);
  }

  /**
   * Allow edits to a path. Paths often come from check output (stack traces into installed
   * packages, absolute paths); anything outside the workspace is simply not allowed, never
   * an error that stops the job.
   */
  addAllowed(path: string): void {
    try {
      this.allow.add(normalisePath(path));
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
    }
  }

  checkRead(raw: string): string {
    return normalisePath(raw);
  }

  checkEdit(raw: string, reason?: string): string {
    const p = normalisePath(raw);
    if (p === ".") throw new PolicyError("cannot edit the workspace root");
    if (isDenied(p) || matchesAny(p, this.extraDenied))
      throw new PolicyError(`editing ${p} is not allowed (protected file)`);
    const allowlisted = this.allow.has(p);
    if (!allowlisted && !reason?.trim())
      throw new PolicyError(
        `${p} is outside the edit allowlist; call again with a short "reason" explaining why the upgrade requires this file`,
      );
    this.edits.set(p, {
      path: p,
      allowlisted,
      reason: allowlisted ? null : (reason?.trim() ?? null),
    });
    return p;
  }
}

/** Minimal glob matcher for config paths: `**` any depth, `*` within a segment, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(
    (g) => globToRegExp(g).test(path) || globToRegExp(`${g.replace(/\/$/, "")}/**`).test(path),
  );
}
