/**
 * Secret detection and masking (PRD T8). Runs on everything that can reach a model, a log
 * line or an audit record. High-confidence patterns only, plus an entropy-gated generic
 * "name = value" rule, so ordinary code is left alone.
 *
 * The repo-wide scan before a job uses betterleaks (see src/security/scan.ts); this module
 * is the last line of defence on individual strings.
 */

export const MASK_PREFIX = "«bumpsmith:masked:";

interface Pattern {
  kind: string;
  re: RegExp;
  /** Index of the capture group holding the secret; 0 = whole match. */
  group?: number;
}

const PATTERNS: Pattern[] = [
  {
    kind: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  // GitHub tokens, including the ~520-character stateless installation tokens (ghs_APPID_JWT).
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_.-]{20,}/g },
  { kind: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "stripe_key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack_webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "pypi_token", re: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Password inside a connection string: scheme://user:PASSWORD@host
  { kind: "url_password", re: /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:([^@\s/]{3,})@/gi, group: 1 },
  { kind: "bearer", re: /\b[Bb]earer\s+([A-Za-z0-9._~+/-]{20,}=*)/g, group: 1 },
];

const ASSIGNMENT =
  /((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)["']?\s*[:=]\s*["'`])([^"'`\s]{8,})(["'`])/gi;

const PLACEHOLDER =
  /^(?:x+|\*+|changeme|password|secret|example|dummy|test|your[_-].*|<.*>|\$\{.*\}|\{\{.*\}\})$/i;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export interface SecretFinding {
  kind: string;
  /** Offset in the input; never the secret itself. */
  index: number;
  length: number;
}

export interface MaskResult {
  text: string;
  findings: SecretFinding[];
}

/** Replace secrets with stable placeholders. Never returns the secret values. */
export function maskSecrets(input: string): MaskResult {
  if (!input) return { text: input, findings: [] };
  const findings: SecretFinding[] = [];
  let text = input;
  let n = 0;
  for (const p of PATTERNS) {
    text = text.replace(p.re, (match: string, ...rest: unknown[]) => {
      const offset = rest.at(-2) as number;
      const group = p.group ? (rest[p.group - 1] as string | undefined) : undefined;
      n += 1;
      const mask = `${MASK_PREFIX}${p.kind}:${n}»`;
      findings.push({ kind: p.kind, index: offset, length: match.length });
      return group ? match.replace(group, mask) : mask;
    });
  }
  text = text.replace(
    ASSIGNMENT,
    (match, lead: string, value: string, tail: string, offset: number) => {
      if (value.startsWith(MASK_PREFIX) || PLACEHOLDER.test(value) || entropy(value) < 3.2)
        return match;
      if (/^(?:process\.env|os\.environ|env\(|getenv)/.test(value)) return match;
      n += 1;
      findings.push({ kind: "assignment", index: offset, length: match.length });
      return `${lead}${MASK_PREFIX}assignment:${n}»${tail}`;
    },
  );
  return { text, findings };
}

/** For logs and audit details: mask and discard findings. */
export function redactSecrets(input: string): string {
  return maskSecrets(input).text;
}

/** True if text still carries a mask placeholder (an agent must never write one back). */
export function containsMask(text: string): boolean {
  return text.includes(MASK_PREFIX);
}

/** Deep-redact any JSON-like value (for audit details and structured logs). */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /token|secret|password|authorization|private_?key|cookie/i.test(k)
        ? "[redacted]"
        : redactDeep(v);
    }
    return out as T;
  }
  return value;
}
