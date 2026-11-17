import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckName, Ecosystem } from "../schemas/job.ts";

export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "yarn-berry"
  | "bun"
  | "pip"
  | "uv"
  | "poetry";

export interface CheckCommand {
  name: CheckName;
  /** argv form; never passed through a shell. */
  argv: string[];
  /** Working directory inside the sandbox (monorepo sub-directory); default /workspace. */
  cwd?: string;
}

export interface Inventory {
  root: string;
  ecosystem: Ecosystem;
  packageManager: PackageManager;
  manifests: string[];
  lockfiles: string[];
  dependencies: Record<string, string>;
  checks: CheckCommand[];
  runtime: { node?: string; python?: string };
  /** Sandbox Node major that satisfies the repo's .nvmrc / engines. */
  nodeMajor: 22 | 24;
  hasTypeScript: boolean;
  workspaces: string[];
  agentsMd: string | null;
}

const read = async (p: string) => {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
};

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: { node?: string };
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

/**
 * Yarn 2+ ("berry") unless the repo vendors its own Yarn release via yarnPath,
 * in which case Yarn 1 delegates to it.
 */
function yarnFlavour(root: string, pkg: PackageJson): "yarn" | "yarn-berry" {
  const rc = join(root, ".yarnrc.yml");
  const major = Number(/^yarn@(\d+)/.exec(pkg.packageManager ?? "")?.[1] ?? 0);
  const berry = major >= 2 || existsSync(rc);
  if (!berry) return "yarn";
  try {
    const yarnPath = /^yarnPath:\s*["']?([^"'\n]+)/m.exec(readFileSync(rc, "utf8"))?.[1];
    if (yarnPath && existsSync(join(root, yarnPath.trim()))) return "yarn";
  } catch {
    // no .yarnrc.yml
  }
  return "yarn-berry";
}

/** Node 24 when the repo asks for anything above 22, otherwise Node 22. */
export function nodeMajorFor(spec: string | undefined): 22 | 24 {
  if (!spec) return 22;
  // The lowest version the spec admits is the first number in it (">=24", "^24.1", "v24", "24.11.0").
  const first = Number(/(\d+)/.exec(spec)?.[1] ?? 0);
  return first >= 23 ? 24 : 22;
}

function detectNodePm(root: string, pkg: PackageJson): PackageManager {
  const declared = pkg.packageManager?.split("@")[0];
  if (declared === "yarn") return yarnFlavour(root, pkg);
  if (declared === "pnpm" || declared === "bun" || declared === "npm") return declared;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return yarnFlavour(root, pkg);
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function nodeRunScript(pm: PackageManager, script: string): string[] {
  if (pm === "npm") return ["npm", "run", script, "--silent"];
  return [pm, "run", script];
}

/**
 * Install with lifecycle scripts disabled (VER-3). Not frozen: the upgrade itself
 * changes the manifest, so the lockfile must be allowed to update.
 */
export function nodeInstallArgv(pm: PackageManager): string[] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", "install", "--ignore-scripts", "--no-frozen-lockfile"];
    case "yarn":
      return ["yarn", "install", "--ignore-scripts"];
    case "yarn-berry":
      return ["yarn-berry", "install", "--mode=skip-build"];
    case "bun":
      return ["bun", "install", "--ignore-scripts"];
    default:
      return ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"];
  }
}

async function inventoryNode(root: string, pkg: PackageJson): Promise<Inventory> {
  const pm = detectNodePm(root, pkg);
  const lockfiles = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
  ].filter((f) => existsSync(join(root, f)));
  const scripts = pkg.scripts ?? {};
  const hasTypeScript = existsSync(join(root, "tsconfig.json"));
  const checks: CheckCommand[] = [{ name: "install", argv: nodeInstallArgv(pm) }];
  if (scripts.build) checks.push({ name: "build", argv: nodeRunScript(pm, "build") });
  if (scripts.typecheck) checks.push({ name: "typecheck", argv: nodeRunScript(pm, "typecheck") });
  else if (hasTypeScript)
    checks.push({
      name: "typecheck",
      argv:
        pm === "npm" ? ["npx", "--no-install", "tsc", "--noEmit"] : [pm, "exec", "tsc", "--noEmit"],
    });
  if (scripts.lint) checks.push({ name: "lint", argv: nodeRunScript(pm, "lint") });
  if (scripts.test && !/no test specified/.test(scripts.test))
    checks.push({ name: "test", argv: nodeRunScript(pm, "test") });

  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  const nvmrc = (await read(join(root, ".nvmrc")))?.trim();
  return {
    root,
    ecosystem: "npm",
    packageManager: pm,
    manifests: ["package.json"],
    lockfiles,
    dependencies: {
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
      ...pkg.devDependencies,
      ...pkg.dependencies,
    },
    checks,
    runtime: { node: nvmrc || pkg.engines?.node },
    nodeMajor: nodeMajorFor(nvmrc || pkg.engines?.node),
    hasTypeScript,
    workspaces: ws,
    agentsMd: await read(join(root, "AGENTS.md")),
  };
}

function parseRequirements(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line || line.startsWith("-")) continue;
    const m = /^([A-Za-z0-9_.\-[\]]+)\s*(.*)$/.exec(line);
    if (m?.[1]) out[m[1].replace(/\[.*\]/, "").toLowerCase()] = (m[2] ?? "").trim();
  }
  return out;
}

async function inventoryPython(root: string): Promise<Inventory> {
  const files = await readdir(root);
  const lockfiles = ["uv.lock", "poetry.lock", "Pipfile.lock"].filter((f) => files.includes(f));
  // requirements.txt, requirements-dev.txt, dev-requirements.txt, ci-requirements.txt, ...
  const reqFiles = files.filter((f) => /requirements[^/]*\.txt$/.test(f)).sort();
  // pip-tools sources (requirements.in) are manifests too: they are what humans edit.
  const inFiles = files.filter((f) => /requirements[^/]*\.in$/.test(f)).sort();
  const pyproject = await read(join(root, "pyproject.toml"));
  const pm: PackageManager = files.includes("uv.lock")
    ? "uv"
    : files.includes("poetry.lock")
      ? "poetry"
      : "pip";

  const deps: Record<string, string> = {};
  for (const f of reqFiles)
    Object.assign(deps, parseRequirements((await read(join(root, f))) ?? ""));
  if (pyproject) {
    // PEP 621 dependencies = ["name>=1", ...]; good enough for inventory, not for resolution.
    const block = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(pyproject)?.[1] ?? "";
    for (const m of block.matchAll(/["']([A-Za-z0-9_.\-[\]]+)\s*([^"']*)["']/g))
      if (m[1]) deps[m[1].replace(/\[.*\]/, "").toLowerCase()] = (m[2] ?? "").trim();
  }

  const hasTests =
    files.includes("tests") ||
    files.includes("test") ||
    /pytest/.test(pyproject ?? "") ||
    "pytest" in deps;
  // Projects often keep pytest out of their requirements (CI installs it separately).
  const ensurePytest = pm === "pip" && hasTests && !("pytest" in deps);
  const installArgv =
    pm === "uv"
      ? UV_SYNC
      : pm === "poetry"
        ? ["poetry", "install", "--no-interaction"]
        : reqFiles.length
          ? pipViaUv(reqFiles, ensurePytest)
          : withPytest(["pip", "install", "-e", ".[test]"], ensurePytest);
  const runner = pm === "uv" ? ["uv", "run"] : pm === "poetry" ? ["poetry", "run"] : [];
  const checks: CheckCommand[] = [{ name: "install", argv: installArgv }];
  if (hasTests)
    checks.push({ name: "test", argv: [...runner, "python", "-m", "pytest", "-q", "-x"] });

  return {
    root,
    ecosystem: "pypi",
    packageManager: pm,
    manifests: ["pyproject.toml", ...reqFiles, ...inFiles].filter((f) => files.includes(f)),
    lockfiles,
    dependencies: deps,
    checks,
    runtime: { python: (await read(join(root, ".python-version")))?.trim() },
    nodeMajor: 22,
    hasTypeScript: false,
    workspaces: [],
    agentsMd: await read(join(root, "AGENTS.md")),
  };
}

/** Detect ecosystem, package manager, dependencies and check commands (INV-1, INV-4). */
const sh = (script: string, args: string[] = []) => ["sh", "-c", script, "sh", ...args];

function withPytest(argv: string[], ensure: boolean): string[] {
  if (!ensure) return argv;
  const quoted = argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  return sh(`${quoted} && { python -m pytest --version >/dev/null 2>&1 || pip install pytest; }`);
}

/**
 * Resolve requirements with uv (seconds, and a fast failure on conflicts), then let pip
 * install exactly that list without resolving again. Plain `pip install -r` can backtrack
 * through hundreds of versions for many minutes on large requirement files. pip still does
 * the install, so packages land where pip puts them (a user install in the sandbox).
 */
export function pipViaUv(reqFiles: string[], ensurePytest = false): string[] {
  const pytest = ensurePytest
    ? " && { python -m pytest --version >/dev/null 2>&1 || pip install pytest; }"
    : "";
  return sh(
    `uv pip compile --quiet -o /tmp/bumpsmith-resolved.txt "$@" && pip install --no-deps -r /tmp/bumpsmith-resolved.txt${pytest}`,
    reqFiles,
  );
}

/**
 * `uv sync`, and when the project pins a different uv (`required-version`), install that
 * uv from PyPI through the mirror and sync with it instead.
 */
export const UV_SYNC = sh(
  [
    "out=$(uv sync --all-extras 2>&1); rc=$?; printf '%s\\n' \"$out\"",
    "[ $rc -eq 0 ] && exit 0",
    "spec=$(printf '%s' \"$out\" | sed -n 's/.*Required uv version `\\([^`]*\\)`.*/\\1/p' | head -n1)",
    '[ -n "$spec" ] || exit $rc',
    'pip install --user "uv$spec" && "$HOME/.local/bin/uv" sync --all-extras',
  ].join("\n"),
);

export async function inventory(root: string): Promise<Inventory> {
  const pkgText = await read(join(root, "package.json"));
  if (pkgText) return inventoryNode(root, JSON.parse(pkgText) as PackageJson);
  const files = await readdir(root);
  if (files.includes("pyproject.toml") || files.some((f) => /^requirements.*\.txt$/.test(f)))
    return inventoryPython(root);
  throw new Error(`No supported manifest found in ${root}`);
}
