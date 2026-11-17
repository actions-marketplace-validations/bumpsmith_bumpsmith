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
  | "poetry"
  | "pipenv"
  | "pdm";

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

/** Yarn 2+ ("berry") unless the repo is on Yarn 1, or vendors a Yarn 1 release via yarnPath. */
function yarnFlavour(root: string, pkg: PackageJson): "yarn" | "yarn-berry" {
  const rc = join(root, ".yarnrc.yml");
  const major = Number(/^yarn@(\d+)/.exec(pkg.packageManager ?? "")?.[1] ?? 0);
  const berry = major >= 2 || existsSync(rc);
  if (!berry) return "yarn";
  try {
    const yarnPath = /^yarnPath:\s*["']?([^"'\n]+)/m.exec(readFileSync(rc, "utf8"))?.[1];
    // A vendored Yarn 1 release keeps Yarn 1 flags; a vendored Yarn 2+ release (the usual
    // case, e.g. .yarn/releases/yarn-4.7.0.cjs) needs Yarn 2+ flags, and Yarn 4 in the
    // image hands off to it through the same yarnPath.
    if (yarnPath && existsSync(join(root, yarnPath.trim())) && /yarn-1\./.test(yarnPath))
      return "yarn";
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
      // npm re-resolves peers on install (npm ci would not); a tree that only installs with
      // --legacy-peer-deps is common and works the same in CI.
      return [
        "sh",
        "-c",
        'npm install --ignore-scripts --no-audit --no-fund || { echo "bumpsmith: retrying with --legacy-peer-deps"; npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps; }',
      ];
  }
}

/** package.json text to an object; tolerates a byte-order mark, explains bad JSON. */
export function parsePackageJson(text: string, where = "package.json"): PackageJson {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as PackageJson;
  } catch (err) {
    throw new Error(`${where} is not valid JSON (${(err as Error).message.slice(0, 120)})`);
  }
}

async function inventoryNode(
  root: string,
  pkg: PackageJson,
  pmOverride?: PackageManager,
): Promise<Inventory> {
  const pm = pmOverride ?? detectNodePm(root, pkg);
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

/** TOML section name -> its body text, for the simple layouts Python manifests use. */
export function tomlSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = "";
  let body: string[] = [];
  for (const line of text.split("\n")) {
    const h = /^\s*\[\[?([^\]]+)\]\]?\s*(#.*)?$/.exec(line);
    if (h?.[1]) {
      out.set(name, `${out.get(name) ?? ""}${body.join("\n")}\n`);
      name = h[1].trim().replace(/["']/g, "");
      body = [];
    } else body.push(line);
  }
  out.set(name, `${out.get(name) ?? ""}${body.join("\n")}\n`);
  return out;
}

/** `key = [ ... ]` arrays in a TOML section body; brackets inside strings ("x[extra]") are skipped. */
function tomlArrays(body: string): { key: string; items: string }[] {
  const out: { key: string; items: string }[] = [];
  for (const m of body.matchAll(/^\s*["']?([\w.-]+)["']?\s*=\s*\[/gm)) {
    let depth = 1;
    let quote: string | null = null;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    for (; i < body.length && depth > 0; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "#") while (i < body.length && body[i] !== "\n") i++;
      else if (ch === "[") depth++;
      else if (ch === "]") depth--;
    }
    out.push({ key: m[1] ?? "", items: body.slice(start, i - 1) });
  }
  return out;
}

const PEP508_ITEM = /["']([A-Za-z0-9][A-Za-z0-9_.-]*)(\[[^\]]*\])?\s*([^"';]*)[^"']*["']/g;

/**
 * Dependencies declared in pyproject.toml or a Pipfile: PEP 621 (project, optional
 * extras), PEP 735 dependency groups, Poetry tables, PDM dev groups and Pipenv packages.
 */
export function parsePythonManifest(text: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const add = (name: string, spec: string) => {
    const n = name.toLowerCase();
    if (n !== "python" && !(n in deps)) deps[n] = spec.trim();
  };
  for (const [section, body] of tomlSections(text)) {
    if (
      section === "project" ||
      section === "project.optional-dependencies" ||
      section === "dependency-groups" ||
      section === "tool.pdm.dev-dependencies" ||
      section === "tool.uv"
    ) {
      // Only arrays: dependencies = [...], extra = [...], dev-dependencies = [...].
      for (const { key, items } of tomlArrays(body)) {
        if (section === "project" && key !== "dependencies") continue;
        if (section === "tool.uv" && key !== "dev-dependencies") continue;
        for (const m of items.matchAll(PEP508_ITEM)) if (m[1]) add(m[1], m[3] ?? "");
      }
    } else if (
      /^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$|^(packages|dev-packages)$/.test(
        section,
      )
    ) {
      for (const m of body.matchAll(
        /^\s*["']?([A-Za-z0-9][A-Za-z0-9_.-]*)["']?\s*=\s*(?:["']([^"']*)["']|\{[^}\n]*?\bversion\s*=\s*["']([^"']*)["'][^}\n]*\}|(\{[^}\n]*\}))/gm,
      ))
        if (m[1]) add(m[1], m[2] ?? m[3] ?? "*");
    }
  }
  return deps;
}

/** Python interpreters in the sandbox image (3.12 is the image's own). */
export const SANDBOX_PYTHONS = ["3.12", "3.13", "3.11", "3.10", "3.14"] as const;

/** Does a Python version satisfy a requires-python / Poetry / Pipfile spec? */
export function pythonSatisfies(version: string, spec: string): boolean {
  const cmp = (a: string, b: string) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d) return Math.sign(d);
    }
    return 0;
  };
  // Alternatives (Poetry "||") each a comma- or space-separated set of clauses.
  return spec.split("||").some((alt) =>
    [...alt.matchAll(/(\^|~=|~|===|==|!=|>=|<=|>|<)?\s*(\d+(?:\.\d+)*)(\.\*)?/g)].every((m) => {
      const op = m[1] ?? "==";
      const v = m[2] ?? "0";
      const parts = v.split(".");
      const wildcard = !!m[3] || (op === "==" && parts.length < 3 && !m[1]);
      switch (op) {
        case ">=":
          return cmp(version, v) >= 0;
        case ">":
          return cmp(version, v) > 0;
        case "<=":
          return cmp(version, v) <= 0;
        case "<":
          return cmp(version, v) < 0;
        case "!=":
          return !version.startsWith(v);
        case "^":
        case "~=":
        case "~":
          return cmp(version, v) >= 0 && version.split(".")[0] === parts[0];
        default:
          return wildcard
            ? `${version}.`.startsWith(`${v}.`) || version === v
            : cmp(version, v) === 0;
      }
    }),
  );
}

/** The sandbox Python for a project: .python-version, then requires-python, else 3.12. */
export function choosePython(pythonVersionFile: string | null, requires: string | null): string {
  const pinned = /^\s*(?:python-|cpython-)?(\d+\.\d+)/m.exec(pythonVersionFile ?? "")?.[1];
  if (pinned && (SANDBOX_PYTHONS as readonly string[]).includes(pinned)) return pinned;
  if (requires) for (const v of SANDBOX_PYTHONS) if (pythonSatisfies(`${v}.0`, requires)) return v;
  return "3.12";
}

/** A virtualenv outside the repository's files (never copied out or into a patch). */
export const VENV = "/workspace/.bumpsmith-cache/venv";
const VPY = `${VENV}/bin/python`;

const sh = (script: string, args: string[] = []) => ["sh", "-c", script, "sh", ...args];
const q = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;

/** Make sure pytest is importable (projects often install it only in CI). */
const ENSURE_PYTEST = `{ ${VPY} -m pytest --version >/dev/null 2>&1 || uv pip install -q --python ${VENV} pytest; }`;

/** Extras whose names say they hold test or development dependencies. */
export function testExtras(texts: string[]): string[] {
  const names = new Set<string>();
  for (const t of texts) {
    for (const [section, body] of tomlSections(t))
      if (section === "project.optional-dependencies" || section === "options.extras_require")
        for (const m of body.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)) if (m[1]) names.add(m[1]);
    const setupPy = /extras_require\s*=\s*(?:dict\(([^)]*)\)|\{([^}]*)\})/s.exec(t);
    if (setupPy)
      for (const m of (setupPy[1] ?? setupPy[2] ?? "").matchAll(
        /["']?([A-Za-z0-9_.-]+)["']?\s*[:=]/g,
      ))
        if (m[1]) names.add(m[1]);
  }
  return [...names].filter((n) => /^(test|tests|testing|dev|develop|all)$/i.test(n)).sort();
}

/**
 * pip-style projects (requirements files or a plain package): a virtualenv on the chosen
 * Python, requirements installed with uv (seconds, and a fast failure on conflicts), then
 * the project itself without dependencies so tests can import it.
 */
export function pipInstall(opts: {
  python: string;
  reqFiles: string[];
  installable: boolean;
  extras: string[];
  ensurePytest: boolean;
}): string[] {
  const steps = [`uv venv -q --allow-existing --python ${opts.python} ${VENV}`];
  const pipIn = `uv pip install -q --python ${VENV}`;
  if (opts.reqFiles.length) {
    const all = opts.reqFiles.map((f) => `-r ${q(f)}`).join(" ");
    const first = `-r ${q(opts.reqFiles[0] ?? "")}`;
    steps.push(
      opts.reqFiles.length > 1
        ? `{ ${pipIn} ${all} || { echo "requirement files conflict; installing ${opts.reqFiles[0]} only"; ${pipIn} ${first}; }; }`
        : `${pipIn} ${all}`,
    );
    if (opts.installable)
      steps.push(
        `{ ${pipIn} --no-deps -e . || echo "note: the project itself could not be installed; tests use the source tree"; }`,
      );
  } else {
    const target = opts.extras.length ? `.[${opts.extras.join(",")}]` : ".";
    steps.push(`${pipIn} -e ${q(target)}`);
  }
  if (opts.ensurePytest) steps.push(ENSURE_PYTEST);
  return sh(steps.join(" && "));
}

/**
 * Which requirement files to install: the app's own file first, then dev/test/local files.
 * CI, docs, lint and production files often pin tools at versions that conflict with the app.
 */
export function installSet(reqFiles: string[]): string[] {
  const base = (f: string) => f.split("/").pop() ?? f;
  const isMain = (f: string) =>
    f === "requirements.txt" || /^requirements\/(base|common|requirements|main)\.txt$/.test(f);
  const main = reqFiles.filter(isMain);
  const devTest = reqFiles.filter(
    (f) => !isMain(f) && /(^|[-_/])(dev|develop|test|tests|testing|local)([-_.]|$)/i.test(base(f)),
  );
  const chosen = [...main, ...devTest];
  return chosen.length ? chosen : reqFiles;
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

/** Poetry: refresh a lock the bump made stale (versions otherwise kept), then install. */
export function poetryInstall(python: string): string[] {
  const install = "poetry install --no-interaction --all-extras --all-groups";
  return sh(
    [
      `poetry env use -q "$(uv python find ${python} 2>/dev/null || command -v python3)" >/dev/null`,
      "{ poetry check --lock >/dev/null 2>&1 || poetry lock --no-interaction; }",
      `{ ${install} || ${install} --no-root; }`,
    ].join(" && "),
  );
}

/** Pipenv: installs from Pipfile, re-locking when the bump made Pipfile.lock stale. */
export function pipenvInstall(python: string): string[] {
  return sh(
    `pipenv install --dev --python "$(uv python find ${python} 2>/dev/null || command -v python3)"`,
  );
}

async function inventoryPython(root: string): Promise<Inventory> {
  const files = await readdir(root);
  const reqDir = files.includes("requirements")
    ? (await readdir(join(root, "requirements")).catch(() => [] as string[]))
        .filter((f) => /\.(txt|in)$/.test(f))
        .map((f) => `requirements/${f}`)
    : [];
  const lockfiles = ["uv.lock", "poetry.lock", "Pipfile.lock", "pdm.lock"].filter((f) =>
    files.includes(f),
  );
  // requirements.txt, requirements-dev.txt, requirements/base.txt, ...
  const reqFiles = [
    ...files.filter((f) => /requirements[^/]*\.txt$/.test(f)),
    ...reqDir.filter((f) => f.endsWith(".txt")),
  ].sort();
  // pip-tools sources (requirements.in) are manifests too: they are what humans edit.
  const inFiles = [
    ...files.filter((f) => /requirements[^/]*\.in$/.test(f)),
    ...reqDir.filter((f) => f.endsWith(".in")),
  ].sort();
  const pyproject = await read(join(root, "pyproject.toml"));
  const pipfile = await read(join(root, "Pipfile"));
  const setupPy = await read(join(root, "setup.py"));
  const setupCfg = await read(join(root, "setup.cfg"));
  const poetryProject = /^\[tool\.poetry/m.test(pyproject ?? "");
  const pm: PackageManager = files.includes("uv.lock")
    ? "uv"
    : files.includes("poetry.lock") || (poetryProject && !reqFiles.length)
      ? "poetry"
      : files.includes("Pipfile")
        ? "pipenv"
        : files.includes("pdm.lock")
          ? "pdm"
          : "pip";

  const deps: Record<string, string> = {};
  for (const f of reqFiles)
    Object.assign(deps, parseRequirements((await read(join(root, f))) ?? ""));
  for (const text of [pyproject, pipfile])
    if (text) for (const [k, v] of Object.entries(parsePythonManifest(text))) deps[k] ??= v;
  for (const text of [setupPy, setupCfg])
    if (text)
      for (const m of text.matchAll(
        /["']?\s*([A-Za-z][A-Za-z0-9_.-]*)\s*((?:[<>=!~]=?|===)\s*[\d][^"',;\n]*)/g,
      ))
        if (m[1] && !(m[1].toLowerCase() in deps)) deps[m[1].toLowerCase()] = (m[2] ?? "").trim();

  const requires =
    /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(pyproject ?? "")?.[1] ??
    /^\s*python\s*=\s*["']([^"']+)["']/m.exec(
      tomlSections(pyproject ?? "").get("tool.poetry.dependencies") ?? "",
    )?.[1] ??
    /python_version\s*=\s*["']([^"']+)["']/.exec(pipfile ?? "")?.[1] ??
    /python_requires\s*=\s*["']([^"']+)["']/.exec(`${setupPy ?? ""}${setupCfg ?? ""}`)?.[1] ??
    null;
  const python = choosePython(await read(join(root, ".python-version")), requires);

  const django = files.includes("manage.py");
  const pytestConfigured =
    /\[tool\.pytest|pytest/.test(pyproject ?? "") ||
    files.includes("pytest.ini") ||
    files.includes("conftest.py") ||
    /\[tool:pytest\]/.test(setupCfg ?? "") ||
    "pytest" in deps;
  const hasTests = pytestConfigured || files.includes("tests") || files.includes("test") || django;
  // Django projects without pytest run their own test runner.
  const djangoRunner = django && !pytestConfigured && !("pytest-django" in deps);
  const installable =
    !!setupPy || !!setupCfg || /^\[(project|build-system)\]/m.test(pyproject ?? "");

  let installArgv: string[];
  let runner: string[];
  if (pm === "uv") {
    installArgv = UV_SYNC;
    runner = ["uv", "run"];
  } else if (pm === "poetry") {
    installArgv = poetryInstall(python);
    runner = ["poetry", "run"];
  } else if (pm === "pipenv") {
    installArgv = pipenvInstall(python);
    runner = ["pipenv", "run"];
  } else if (pm === "pdm") {
    installArgv = sh(
      `pdm use -q -f "$(uv python find ${python} 2>/dev/null || command -v python3)" && pdm install -G :all`,
    );
    runner = ["pdm", "run"];
  } else {
    installArgv = pipInstall({
      python,
      reqFiles: installSet(reqFiles),
      installable,
      extras: testExtras([pyproject ?? "", setupPy ?? "", setupCfg ?? ""]),
      ensurePytest: hasTests && !djangoRunner,
    });
    runner = [];
  }
  const py = pm === "pip" ? [VPY] : [...runner, "python"];
  const checks: CheckCommand[] = [{ name: "install", argv: installArgv }];
  if (djangoRunner) checks.push({ name: "test", argv: [...py, "manage.py", "test", "--noinput"] });
  else if (hasTests) checks.push({ name: "test", argv: [...py, "-m", "pytest", "-q", "-x"] });

  return {
    root,
    ecosystem: "pypi",
    packageManager: pm,
    manifests: [
      "pyproject.toml",
      "Pipfile",
      "setup.py",
      "setup.cfg",
      ...reqFiles,
      ...inFiles,
    ].filter((f) => files.includes(f) || f.startsWith("requirements/")),
    lockfiles,
    dependencies: deps,
    checks,
    runtime: { python },
    nodeMajor: 22,
    hasTypeScript: false,
    workspaces: [],
    agentsMd: await read(join(root, "AGENTS.md")),
  };
}

/**
 * Inventory the repository for one ecosystem. Many repos have both (a Django app with a
 * package.json for its front end), so the ecosystem of the upgrade decides, when known.
 */
export async function inventory(
  root: string,
  ecosystem?: "npm" | "pypi",
  opts: { packageManager?: PackageManager } = {},
): Promise<Inventory> {
  const pkgText = await read(join(root, "package.json"));
  const files = await readdir(root);
  const hasPython = files.some((f) =>
    /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements)$|requirements[^/]*\.(txt|in)$/.test(
      f,
    ),
  );
  if (ecosystem === "pypi" && hasPython) return inventoryPython(root);
  if (pkgText && ecosystem !== "pypi")
    return inventoryNode(root, parsePackageJson(pkgText), opts.packageManager);
  if (hasPython) return inventoryPython(root);
  throw new Error(`No supported manifest found in ${root}`);
}
