import type { EditRecord } from "../agent/policy.ts";
import { isDenied, matchesAny } from "../agent/policy.ts";
import type { ChangeRecord } from "../schemas/change-record.ts";
import type { Ecosystem } from "../schemas/job.ts";
import type { FileDiff } from "./patch.ts";

export type RuleSeverity = "block" | "warn";

export interface RuleFinding {
  rule: string;
  severity: RuleSeverity;
  file: string | null;
  detail: string;
}

/** Added-line patterns that an upgrade fix should never need (VER-10). */
const SUSPICIOUS: { rule: string; re: RegExp; langs?: RegExp }[] = [
  {
    rule: "network_call",
    re: /\b(fetch\s*\(|XMLHttpRequest|axios\.|https?\.(request|get)\s*\(|net\.connect|new\s+WebSocket|urllib|requests\.(get|post|put|request)|httpx\.|socket\.socket|aiohttp\.)/,
  },
  {
    rule: "process_execution",
    re: /\b(child_process|execSync|spawnSync|\bexec\s*\(|\bspawn\s*\(|subprocess\.|os\.system|os\.popen|Deno\.run)/,
  },
  {
    rule: "dynamic_code",
    re: /\b(eval\s*\(|new\s+Function\s*\(|vm\.runIn|exec\s*\(compile|__import__\s*\()/,
  },
  { rule: "env_access", re: /\b(process\.env|os\.environ|os\.getenv|Deno\.env)\b/ },
  { rule: "encoded_blob", re: /[A-Za-z0-9+/=]{200,}/ },
  { rule: "shell_download", re: /\b(curl|wget)\s+(-[a-zA-Z]+\s+)*https?:/ },
];

const LOCKFILES =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock)$/;
const TEST_FILE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$/;
const ASSERT =
  /\b(assert|expect\s*\(|should\.|\.toBe|\.toEqual|\.toThrow|assertEqual|assertTrue|pytest\.raises)/;

function depNames(ecosystem: Ecosystem, lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const m =
      ecosystem === "npm"
        ? /^\s*"(@?[\w./-]+)"\s*:\s*"[^"]*"/.exec(l)
        : /^\s*["']?([A-Za-z0-9_.-]+)\s*(==|>=|~=|<=|<|>|\[)/.exec(l);
    if (m?.[1]) out.add(m[1].toLowerCase());
  }
  return out;
}

export interface RuleInput {
  ecosystem: Ecosystem;
  packageName: string;
  files: FileDiff[];
  record: ChangeRecord;
  edits: EditRecord[];
  maxChangedLines?: number;
  /** Extra protected paths from the repository's .bumpsmith.yml. */
  protectedPaths?: string[];
  /** Non-optional peer dependencies declared by the new version of the package. */
  peerDependencies?: string[];
}

const HTTP_CLIENTS = new Set([
  "node-fetch",
  "got",
  "axios",
  "undici",
  "ky",
  "superagent",
  "request",
  "needle",
  "phin",
  "cross-fetch",
  "isomorphic-fetch",
  "@octokit/rest",
  "@octokit/core",
  "httpx",
  "requests",
  "aiohttp",
  "urllib3",
]);

const REWRITABLE = new Set(["network_call", "process_execution", "env_access"]);

/** Upgrading these means rewriting process-spawning code is expected. */
const PROCESS_LIBS = new Set(["execa", "cross-spawn", "zx", "shelljs", "tinyexec", "nano-spawn"]);

/** Plain-code safety rules applied to the patch outside the sandbox. No model involved. */
export function applyRules(input: RuleInput): RuleFinding[] {
  const out: RuleFinding[] = [];
  const allowedNewDeps = new Set(
    input.record.changes.flatMap((c) =>
      [...c.instruction.matchAll(/["'`](@?[\w./-]+)["'`]/g)].map((m) => (m[1] ?? "").toLowerCase()),
    ),
  );
  allowedNewDeps.add(input.packageName.toLowerCase());
  // Required peers of the new version may legitimately be added (e.g. vitest 5 -> vite).
  for (const p of input.peerDependencies ?? []) allowedNewDeps.add(p.toLowerCase());
  const httpClientUpgrade = HTTP_CLIENTS.has(input.packageName.toLowerCase());
  const processLibUpgrade = PROCESS_LIBS.has(input.packageName.toLowerCase());
  let changedLines = 0;

  for (const f of input.files) {
    if (isDenied(f.path) || matchesAny(f.path, input.protectedPaths ?? []))
      out.push({
        rule: "protected_path",
        severity: "block",
        file: f.path,
        detail: "change touches a protected file",
      });
    if (f.binary)
      out.push({
        rule: "binary_change",
        severity: "block",
        file: f.path,
        detail: "binary file changed",
      });
    if (LOCKFILES.test(f.path)) continue;
    changedLines += f.added.length + f.removed.length;

    const isManifest = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt)$/.test(f.path);
    if (isManifest) {
      const before = depNames(input.ecosystem, f.removed);
      for (const name of depNames(input.ecosystem, f.added))
        if (!before.has(name) && !allowedNewDeps.has(name))
          out.push({
            rule: "new_dependency",
            severity: "block",
            file: f.path,
            detail: `adds dependency "${name}" not named by the Change Record`,
          });
      if (f.added.some((l) => /"(pre|post)?install"\s*:|"prepare"\s*:/.test(l)))
        out.push({
          rule: "install_script",
          severity: "block",
          file: f.path,
          detail: "adds a package lifecycle script",
        });
    }

    for (const line of f.added)
      for (const s of SUSPICIOUS)
        if (s.re.test(line)) {
          const preexisting = f.removed.some((r) => r.trim() === line.trim());
          if (preexisting) continue;
          // Rewriting existing network / process code is expected when the upgrade is of
          // that kind of library.
          const libraryContext =
            (s.rule === "network_call" && httpClientUpgrade) ||
            (s.rule === "process_execution" && processLibUpgrade);
          if (libraryContext) continue;
          // The same capability already existed in lines this edit removed from the file:
          // a rewrite, not a new capability. Surface it to the reviewer, don't block.
          // Code-loading patterns (eval, encoded blobs, curl|sh) always block.
          const rewrite = REWRITABLE.has(s.rule) && f.removed.some((r) => s.re.test(r));
          out.push({
            rule: s.rule,
            severity: rewrite ? "warn" : "block",
            file: f.path,
            detail: line.trim().slice(0, 160),
          });
        }

    if (TEST_FILE.test(f.path)) {
      const removedAsserts = f.removed.filter((l) => ASSERT.test(l)).length;
      const addedAsserts = f.added.filter((l) => ASSERT.test(l)).length;
      out.push({
        rule: removedAsserts > addedAsserts ? "tests_weakened" : "tests_changed",
        severity: "warn",
        file: f.path,
        detail: `assertions removed: ${removedAsserts}, added: ${addedAsserts}`,
      });
    }
  }

  for (const e of input.edits)
    if (!e.allowlisted)
      out.push({
        rule: "outside_impact_map",
        severity: "warn",
        file: e.path,
        detail: `edited outside the allowlist: ${e.reason ?? "no reason"}`,
      });

  const max = input.maxChangedLines ?? 400;
  if (changedLines > max)
    out.push({
      rule: "diff_too_large",
      severity: "block",
      file: null,
      detail: `${changedLines} changed lines (limit ${max})`,
    });
  return out;
}
