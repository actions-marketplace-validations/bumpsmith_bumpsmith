import type { Ecosystem } from "../schemas/job.ts";

/** Rewrite a version range to target `to`, keeping the user's prefix style (^ ~ = or exact). */
export function bumpRange(range: string, to: string): string {
  const r = range.trim();
  if (/^v?\d+\.\d+\.\d+([-+][\w.]+)?$/.test(r)) return to; // exact pin stays exact
  const m = /^(\^|~|=)\s*v?\d/.exec(r);
  if (m?.[1] === "=") return to;
  if (m?.[1]) return `${m[1]}${to}`;
  return `^${to}`; // ">=4", "4.x", "*", "latest" and other ranges become a caret range
}

/** Update package.json text in place for `name`, preserving formatting. Returns null if absent. */
export function bumpPackageJson(text: string, name: string, to: string): string | null {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  let changed = false;
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = pkg[field];
    const current = deps?.[name];
    if (deps && current !== undefined && !/^(workspace:|file:|link:|git|https?:)/.test(current)) {
      deps[name] = field === "peerDependencies" ? current : bumpRange(current, to);
      changed = changed || field !== "peerDependencies";
    }
  }
  if (!changed) return null;
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? "  ";
  return `${JSON.stringify(pkg, null, indent)}${text.endsWith("\n") ? "\n" : ""}`;
}

const OP = "(?:===|==|~=|>=|<=|!=|>|<)";

/** Compare dotted numeric versions (enough for specifier bounds; ignores pre-release tags). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Keep `<`, `<=` and `!=` clauses that still admit `to`; drop the rest. */
function keptBounds(clauses: { op: string; v: string }[], to: string): string {
  return clauses
    .slice(1)
    .filter(({ op, v }) => {
      if (op === "<") return compareVersions(to, v) < 0;
      if (op === "<=") return compareVersions(to, v) <= 0;
      if (op === "!=") return v !== to;
      return false;
    })
    .map(({ op, v }) => `,${op}${v}`)
    .join("");
}

/**
 * Update a requirements / requirements.in / pyproject dependency for `name`. Handles a
 * whole specifier set (">=3.2,<4"), environment markers ("; python_version...") and
 * pip-compile line continuations ("pkg==1.0 \\" followed by --hash lines).
 */
export function bumpPythonText(text: string, name: string, to: string): string | null {
  const escaped = name.replace(/[-_.]/g, "[-_.]");
  const clause = `\\s*${OP}\\s*[^"'\\s\\\\;#,]+`;
  const re = new RegExp(
    `(^|["'\\s])(${escaped})(\\[[^\\]]*\\])?(${clause}(?:\\s*,${clause})*)`,
    "gim",
  );
  let changed = false;
  const out = text.replace(
    re,
    (_m, lead: string, pkg: string, extras: string | undefined, spec: string) => {
      const clauses = [...spec.matchAll(new RegExp(`(${OP})\\s*([^"'\\s\\\\;#,]+)`, "g"))].map(
        (m) => ({ op: m[1] as string, v: m[2] as string }),
      );
      const first = clauses[0]?.op ?? "==";
      const newOp = first === "~=" || first === ">=" ? first : "==";
      changed = true;
      return `${lead}${pkg}${extras ?? ""}${newOp}${to}${keptBounds(clauses, to)}`;
    },
  );
  return changed ? out : null;
}

/** TOML tables that map package names to version specs (Poetry, Pipenv, PDM dev groups). */
const TOML_DEP_TABLE =
  /^\[(?:tool\.poetry\.(?:dev-)?dependencies|tool\.poetry\.group\.[^\]]+\.dependencies|packages|dev-packages)\]\s*$/;

/** Rewrite one Poetry / Pipenv spec to admit exactly `to` (caret and tilde styles kept). */
export function bumpTomlSpec(spec: string, to: string): string {
  const s = spec.trim();
  if (s === "*" || s === "") return s;
  if (/^\^/.test(s)) return `^${to}`;
  if (/^~(?!=)/.test(s)) return `~${to}`;
  if (/^v?\d/.test(s) && !/[,<>=!]/.test(s)) return to;
  const clauses = [...s.matchAll(new RegExp(`(${OP})\\s*([^\\s,]+)`, "g"))].map((m) => ({
    op: m[1] as string,
    v: m[2] as string,
  }));
  if (!clauses.length) return s;
  const first = clauses[0]?.op ?? "==";
  const newOp = first === "~=" || first === ">=" ? first : "==";
  return `${newOp}${to}${keptBounds(clauses, to)}`;
}

/**
 * Update `name = "^1.2"` or `name = { version = "^1.2", ... }` in Poetry / Pipenv tables.
 * Returns the text unchanged (not null) when the spec is "*", which already admits `to`.
 */
export function bumpTomlDeps(text: string, name: string, to: string): string | null {
  const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, "-");
  const target = norm(name);
  let inTable = false;
  let found = false;
  const lines = text.split("\n").map((line) => {
    if (/^\s*\[/.test(line)) {
      inTable = TOML_DEP_TABLE.test(line.trim());
      return line;
    }
    if (!inTable) return line;
    const m = /^(\s*["']?)([A-Za-z0-9_.-]+)(["']?\s*=\s*)(.*)$/.exec(line);
    if (!m || norm(m[2] ?? "") !== target) return line;
    const value = m[4] ?? "";
    const str = /^(["'])([^"']*)\1(.*)$/.exec(value);
    if (str) {
      found = true;
      return `${m[1]}${m[2]}${m[3]}${str[1]}${bumpTomlSpec(str[2] ?? "", to)}${str[1]}${str[3]}`;
    }
    const inline = /^(\{.*?\bversion\s*=\s*)(["'])([^"']*)\2(.*)$/.exec(value);
    if (inline) {
      found = true;
      return `${m[1]}${m[2]}${m[3]}${inline[1]}${inline[2]}${bumpTomlSpec(inline[3] ?? "", to)}${inline[2]}${inline[4]}`;
    }
    return line;
  });
  return found ? lines.join("\n") : null;
}

export type DepField = "dependencies" | "devDependencies" | "optionalDependencies";

/** Find which field declares `name` and the range prefix the user chose. */
export function npmDepInfo(
  text: string,
  name: string,
): { field: DepField; prefix: "^" | "~" | "" } | null {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
    const range = pkg[field]?.[name];
    if (range === undefined) continue;
    const bumped = bumpRange(range, "0.0.0");
    return { field, prefix: bumped.startsWith("^") ? "^" : bumped.startsWith("~") ? "~" : "" };
  }
  return null;
}

/**
 * Install exactly the gated version (never a newer one a range would allow), keeping
 * the user's dependency field and prefix. npm's --before also applies the release-age
 * rule to transitive dependencies.
 */
export function npmUpgradeArgv(
  pm: string,
  name: string,
  to: string,
  info: { field: DepField; prefix: "^" | "~" | "" },
  before: Date,
  /** The repo root is a workspace root (pnpm-workspace.yaml or package.json "workspaces"). */
  workspaceRoot = false,
  /** Companion packages upgraded in the same command (PR-2), e.g. @vitest/coverage-v8 with vitest. */
  companions: string[] = [],
): string[] {
  // A companion is either a name (moves to the same version) or "name@version".
  const specs = [
    `${name}@${to}`,
    ...companions.map((c) => (c.lastIndexOf("@") > 0 ? c : `${c}@${to}`)),
  ];
  const exact = info.prefix === "";
  switch (pm) {
    case "pnpm":
      return [
        "pnpm",
        "add",
        "--ignore-scripts",
        ...(workspaceRoot ? ["--workspace-root"] : []),
        ...(info.field === "devDependencies"
          ? ["-D"]
          : info.field === "optionalDependencies"
            ? ["-O"]
            : []),
        ...(exact ? ["--save-exact"] : info.prefix === "~" ? ["--save-prefix=~"] : []),
        ...specs,
      ];
    case "yarn":
      return [
        "yarn",
        "add",
        ...(workspaceRoot ? ["-W"] : []),
        ...(info.field === "devDependencies"
          ? ["--dev"]
          : info.field === "optionalDependencies"
            ? ["--optional"]
            : []),
        ...(exact ? ["--exact"] : info.prefix === "~" ? ["--tilde"] : []),
        ...specs,
      ];
    case "yarn-berry":
      // Yarn 2+ adds to the workspace in cwd (no -W) and has no --ignore-scripts on add;
      // YARN_ENABLE_SCRIPTS=0 in the image covers it.
      return [
        "yarn-berry",
        "add",
        ...(info.field === "devDependencies"
          ? ["--dev"]
          : info.field === "optionalDependencies"
            ? ["--optional"]
            : []),
        ...(exact ? ["--exact"] : info.prefix === "~" ? ["--tilde"] : []),
        ...specs,
      ];
    case "bun":
      return [
        "bun",
        "add",
        "--ignore-scripts",
        ...(info.field === "devDependencies"
          ? ["-d"]
          : info.field === "optionalDependencies"
            ? ["--optional"]
            : []),
        ...(exact ? ["--exact"] : []),
        ...specs,
      ];
    default:
      return [
        "npm",
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `--before=${before.toISOString()}`,
        info.field === "devDependencies"
          ? "--save-dev"
          : info.field === "optionalDependencies"
            ? "--save-optional"
            : "--save-prod",
        ...(exact ? ["--save-exact"] : [`--save-prefix=${info.prefix}`]),
        ...specs,
      ];
  }
}

export function bumpFile(
  ecosystem: Ecosystem,
  file: string,
  text: string,
  name: string,
  to: string,
): string | null {
  if (ecosystem === "npm")
    return file.endsWith("package.json") ? bumpPackageJson(text, name, to) : null;
  const pep508 = bumpPythonText(text, name, to);
  if (/(^|\/)(pyproject\.toml|Pipfile)$/.test(file))
    return bumpTomlDeps(pep508 ?? text, name, to) ?? pep508;
  return pep508;
}

/**
 * Packages that move in lockstep with `name`: same family (scope or "@name/" prefix),
 * declared in the same dependency field, and currently at the same version (PR-2).
 */
export function npmCompanions(text: string, name: string, from: string): string[] {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  const info = npmDepInfo(text, name);
  if (!info) return [];
  const scope = name.startsWith("@") ? name.split("/")[0] : null;
  const family = (dep: string) =>
    dep !== name &&
    (dep.startsWith(`@${name}/`) || (scope !== null && dep.startsWith(`${scope}/`)));
  const out: string[] = [];
  for (const [dep, range] of Object.entries(pkg[info.field] ?? {})) {
    if (!family(dep)) continue;
    const version = range.replace(/^[\^~=v\s]+/, "");
    if (version === from) out.push(dep);
  }
  return out.sort();
}
