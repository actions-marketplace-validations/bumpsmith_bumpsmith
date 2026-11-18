import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classify } from "../../src/bench/zoo.ts";
import { bumpFile, bumpTomlDeps, bumpTomlSpec } from "../../src/inventory/bump.ts";
import {
  choosePython,
  installSet,
  inventory,
  parsePackageJson,
  parsePythonManifest,
  pythonSatisfies,
  testExtras,
} from "../../src/inventory/inventory.ts";
import { explainError, lowestVersion } from "../../src/pipeline.ts";

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bumpsmith-shape-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

const POETRY = `[tool.poetry]
name = "app"

[tool.poetry.dependencies]
python = ">=3.10,<3.12"
pydantic = "^1.10.2"
httpx = { version = "~0.24", extras = ["http2"] }
anything = "*"

[tool.poetry.group.dev.dependencies]
pytest = "^7.4"

[tool.black]
line-length = 100
`;

describe("Poetry and Pipenv manifests", () => {
  it("bumps caret, tilde, inline-table and star specs", () => {
    const out = bumpTomlDeps(POETRY, "pydantic", "2.7.1") ?? "";
    expect(out).toContain('pydantic = "^2.7.1"');
    expect(bumpTomlDeps(POETRY, "httpx", "0.27.0")).toContain(
      'httpx = { version = "~0.27.0", extras = ["http2"] }',
    );
    expect(bumpTomlDeps(POETRY, "anything", "3.0.0")).toBe(POETRY);
    expect(bumpTomlDeps(POETRY, "pytest", "8.2.0")).toContain('pytest = "^8.2.0"');
    expect(bumpTomlDeps(POETRY, "line-length", "1")).toBeNull();
    expect(bumpTomlDeps(POETRY, "missing", "1.0.0")).toBeNull();
  });

  it("maps PEP 440 specs inside TOML", () => {
    expect(bumpTomlSpec("==1.2.3", "2.0.0")).toBe("==2.0.0");
    expect(bumpTomlSpec(">=1.2,<3", "2.0.0")).toBe(">=2.0.0,<3");
    expect(bumpTomlSpec("1.2.3", "2.0.0")).toBe("2.0.0");
  });

  it("bumps Pipfile packages and leaves other sections alone", () => {
    const pipfile = `[[source]]
url = "https://pypi.org/simple"

[packages]
requests = "==2.31.0"
flask = "*"

[dev-packages]
pytest = ">=7"

[requires]
python_version = "3.11"
`;
    const out = bumpFile("pypi", "Pipfile", pipfile, "requests", "2.32.3") ?? "";
    expect(out).toContain('requests = "==2.32.3"');
    expect(out).toContain('python_version = "3.11"');
    expect(parsePythonManifest(pipfile)).toMatchObject({ requests: "==2.31.0", pytest: ">=7" });
  });

  it("reads PEP 621, extras, dependency groups and Poetry tables", () => {
    const pep = `[project]
name = "x"
requires-python = ">=3.11"
dependencies = [
  "pydantic>=2,<3",
  "rich[jupyter]==13.7.0",
]
[project.optional-dependencies]
test = ["pytest>=8"]
[dependency-groups]
dev = ["ruff==0.5.0"]
`;
    expect(parsePythonManifest(pep)).toEqual({
      pydantic: ">=2,<3",
      rich: "==13.7.0",
      pytest: ">=8",
      ruff: "==0.5.0",
    });
    expect(parsePythonManifest(POETRY)).toMatchObject({
      pydantic: "^1.10.2",
      httpx: "~0.24",
      pytest: "^7.4",
    });
  });
});

describe("Python interpreter choice", () => {
  it("honours .python-version, then requires-python, else 3.12", () => {
    expect(choosePython("3.11.9\n", null)).toBe("3.11");
    expect(choosePython(null, ">=3.10,<3.12")).toBe("3.11");
    expect(choosePython(null, "^3.13")).toBe("3.13");
    expect(choosePython(null, ">=3.8")).toBe("3.12");
    expect(choosePython("3.7\n", null)).toBe("3.12");
    expect(choosePython(null, "3.10")).toBe("3.10");
    expect(pythonSatisfies("3.12.0", "~=3.10")).toBe(true);
    expect(pythonSatisfies("3.12.0", "==3.11.*")).toBe(false);
  });

  it("finds test extras in setup.py, setup.cfg and pyproject", () => {
    expect(testExtras(['extras_require={"test": ["pytest"], "docs": ["sphinx"]}'])).toEqual([
      "test",
    ]);
    expect(testExtras(["[options.extras_require]\ntesting =\n    pytest\n"])).toEqual(["testing"]);
    expect(testExtras(['[project.optional-dependencies]\ndev = ["x"]\n'])).toEqual(["dev"]);
  });

  it("installs base plus dev/test/local files from a requirements directory", () => {
    expect(
      installSet([
        "requirements/base.txt",
        "requirements/local.txt",
        "requirements/production.txt",
      ]),
    ).toEqual(["requirements/base.txt", "requirements/local.txt"]);
  });
});

describe("Python repository layouts", () => {
  it("Poetry project: poetry install, runs pytest through poetry", async () => {
    const dir = await repo({ "pyproject.toml": POETRY, "poetry.lock": "", "tests/test_a.py": "" });
    const inv = await inventory(dir, "pypi");
    expect(inv.packageManager).toBe("poetry");
    expect(inv.runtime.python).toBe("3.11");
    expect(inv.dependencies.pydantic).toBe("^1.10.2");
    expect(inv.checks.map((c) => c.argv.join(" ")).join("\n")).toMatch(/poetry lock/);
    expect(inv.checks.find((c) => c.name === "test")?.argv.slice(0, 2)).toEqual(["poetry", "run"]);
  });

  it("setup.py-only package: editable install with test extras into the venv", async () => {
    const dir = await repo({
      "setup.py": 'setup(install_requires=["requests>=2.0"], extras_require={"tests": ["pytest"]})',
      "tests/test_a.py": "",
    });
    const inv = await inventory(dir, "pypi");
    expect(inv.packageManager).toBe("pip");
    expect(inv.manifests).toContain("setup.py");
    expect(inv.dependencies.requests).toBe(">=2.0");
    const install = inv.checks[0]?.argv.join(" ") ?? "";
    expect(install).toContain("uv venv");
    expect(install).toContain("-e '.[tests]'");
  });

  it("Django without pytest runs manage.py test", async () => {
    const dir = await repo({ "manage.py": "", "requirements.txt": "django==4.2\n" });
    const inv = await inventory(dir, "pypi");
    expect(inv.checks.find((c) => c.name === "test")?.argv.slice(-3)).toEqual([
      "manage.py",
      "test",
      "--noinput",
    ]);
  });

  it("Pipfile project uses pipenv", async () => {
    const dir = await repo({ Pipfile: '[packages]\nrequests = "*"\n' });
    const inv = await inventory(dir, "pypi");
    expect(inv.packageManager).toBe("pipenv");
    expect(inv.manifests).toEqual(["Pipfile"]);
  });

  it("requirements directory is inventoried and bumped", async () => {
    const dir = await repo({
      "requirements/base.txt": "django==4.2.1\n",
      "requirements/local.txt": "-r base.txt\npytest==8.0\n",
    });
    const inv = await inventory(dir, "pypi");
    expect(inv.manifests).toEqual(["requirements/base.txt", "requirements/local.txt"]);
    expect(inv.dependencies.django).toBe("==4.2.1");
  });
});

describe("robustness", () => {
  it("parses package.json with a byte-order mark and explains invalid JSON", () => {
    expect(parsePackageJson('﻿{"name":"x"}')).toEqual({ name: "x" });
    expect(() => parsePackageJson("{,}")).toThrow(/package.json is not valid JSON/);
  });

  it("finds the lowest version of npm and Python ranges", () => {
    expect(lowestVersion("^1.2.3")).toBe("1.2.3");
    expect(lowestVersion(">=1.2,<2")).toBe("1.2.0");
    expect(lowestVersion("~=1.4")).toBe("1.4.0");
    expect(lowestVersion("==2.31.0")).toBe("2.31.0");
    expect(lowestVersion("*")).toBe("0.0.0");
    expect(lowestVersion("workspace:*")).toBeNull();
  });

  it("explains common early stops in plain words", () => {
    expect(explainError("Error: lodash is not a dependency of this repository")).toMatch(/--dir/);
    expect(explainError("Error: something odd")).toMatch(/unexpected error/);
  });

  it("classifies zoo repository shapes", () => {
    expect(classify(["package.json", "package-lock.json"], "")).toBe("npm");
    expect(
      classify(["pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/web/package.json"], "apps/web"),
    ).toBe("pnpm-workspace");
    expect(classify(["yarn.lock", ".yarnrc.yml", "package.json"], "")).toBe("yarn-berry");
    expect(classify(["pyproject.toml", "poetry.lock"], "")).toBe("poetry");
    expect(classify(["requirements/base.txt"], "")).toBe("pip-requirements-dir");
  });
});

describe("CI services", async () => {
  const { servicesFromWorkflow, parseImage } = await import("../../src/sandbox/services.ts");
  it("reads services and literal env, skipping secrets and unknown images", () => {
    const plan = servicesFromWorkflow(`
env:
  NODE_OPTIONS: --max-old-space-size=99999
jobs:
  test:
    env:
      DATABASE_URL: postgres://u:p@localhost/db
      API_KEY: \${{ secrets.API_KEY }}
      SSL_CERT_FILE: /evil
    services:
      db:
        image: postgres:15
        env: { POSTGRES_PASSWORD: p }
      cache: redis
      search:
        image: elasticsearch:8.10.2
      sneaky:
        image: ghcr.io/evil/postgres:1
`);
    expect(plan.services.map((s) => s.image)).toEqual(["postgres:15", "redis:latest"]);
    expect(plan.services[0]?.env.POSTGRES_PASSWORD).toBe("p");
    expect(plan.env).toEqual({ DATABASE_URL: "postgres://u:p@localhost/db" });
    expect(plan.skipped).toEqual([
      "search (elasticsearch:8.10.2)",
      "sneaky (ghcr.io/evil/postgres:1)",
    ]);
    expect(parseImage("postgres@sha256:abc")).toBeNull();
    expect(parseImage("docker.io/library/mysql:8.0")?.image).toBe("mysql:8.0");
  });

  it("explains baseline failures caused by a missing database", async () => {
    const { checkFailureReason } = await import("../../src/pipeline.ts");
    const base = (out: string) => [
      {
        name: "install" as const,
        command: "",
        exit_code: 0,
        passed: true,
        duration_ms: 1,
        timed_out: false,
        output_tail: "",
      },
      {
        name: "test" as const,
        command: "",
        exit_code: 1,
        passed: false,
        duration_ms: 1,
        timed_out: false,
        output_tail: out,
      },
    ];
    expect(checkFailureReason(base("connect ECONNREFUSED 127.0.0.1:5432"))).toMatch(/database/);
    expect(checkFailureReason(base("sh: 1: foo: command not found"))).toMatch(/not installed/);
  });
});

describe("workspace members", async () => {
  const { workspaceMembersDeclaring } = await import("../../src/inventory/inventory.ts");
  it("finds members that declare a package, skipping nested projects and node_modules", async () => {
    const dir = await repo({
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "package-lock.json": "{}",
      "packages/web/package.json": JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      "packages/api/package.json": JSON.stringify({ devDependencies: { react: "18.2.0" } }),
      "packages/ui/package.json": JSON.stringify({ dependencies: { react: "workspace:*" } }),
      "examples/demo/package.json": JSON.stringify({ dependencies: { react: "^17" } }),
      "examples/demo/package-lock.json": "{}",
      "node_modules/x/package.json": JSON.stringify({ dependencies: { react: "^16" } }),
    });
    expect(await workspaceMembersDeclaring(dir, "react")).toEqual([
      { dir: "packages/api", range: "18.2.0" },
      { dir: "packages/web", range: "^18.2.0" },
    ]);
  });
});

describe("git dependencies", async () => {
  const { gitDependencyUrls, gitInsteadOfConfig } = await import("../../src/sandbox/git-deps.ts");
  it("finds public git URLs and maps them to local copies", () => {
    const urls = gitDependencyUrls([
      "vmtest @ git+https://github.com/osbuild/images.git@main#subdirectory=test\n",
      'dependencies = ["lib @ git+https://gitlab.com/a/b@v1.2"]',
      "x @ git+https://evil.example.com/a/b",
      "y @ git+ssh://git@github.com/a/private.git",
    ]);
    expect(urls).toEqual(["https://github.com/osbuild/images", "https://gitlab.com/a/b"]);
    const cfg = gitInsteadOfConfig([{ url: urls[0] ?? "", hostDir: "/h", name: "0-images.git" }]);
    expect(cfg).toContain('[url "file:///workspace/.bumpsmith-cache/git/0-images.git"]');
    expect(cfg).toContain("insteadOf = https://github.com/osbuild/images.git");
  });
});

describe("transitive (lockfile-only) updates", async () => {
  const { lockedVersions, lockfileUpdateArgv } = await import("../../src/inventory/bump.ts");
  it("reads locked versions from every lockfile format", () => {
    expect(
      lockedVersions(
        '"node_modules/qs": {\n      "version": "6.11.0",\n "node_modules/express/node_modules/qs": { "version": "6.5.2"',
        "qs",
      ),
    ).toEqual(["6.5.2", "6.11.0"]);
    expect(
      lockedVersions("packages:\n  qs@6.11.0:\n    resolution: x\n  /qs@6.9.1:", "qs"),
    ).toEqual(["6.9.1", "6.11.0"]);
    expect(
      lockedVersions('qs@^6.5.2, qs@~6.5.2:\n  version "6.5.3"\n  resolved "x"\n', "qs"),
    ).toEqual(["6.5.3"]);
    expect(
      lockedVersions('"qs@npm:^6.5.2":\n  version: 6.13.0\n  resolution: "qs@npm:6.13.0"', "qs"),
    ).toContain("6.13.0");
    expect(
      lockedVersions('[[package]]\nname = "certifi"\nversion = "2024.2.2"\n', "certifi"),
    ).toEqual(["2024.2.2"]);
    expect(
      lockedVersions('"certifi": {\n "hashes": [],\n "version": "==2022.12.7"\n}', "certifi"),
    ).toEqual(["2022.12.7"]);
    expect(lockedVersions('"node_modules/qsx": {"version": "1.0.0"', "qs")).toEqual([]);
  });

  it("removes only the package's entries from a Yarn 1 lockfile", async () => {
    const { run } = await import("../../src/util/proc.ts");
    const dir = await repo({
      "yarn.lock": `# yarn lockfile v1\n\n\nqs@^6.5.2, qs@~6.5.2:\n  version "6.5.3"\n\nqsx@^1.0.0:\n  version "1.0.0"\n\n"@a/qs@^1":\n  version "1.0.0"\n`,
    });
    const argv = lockfileUpdateArgv("yarn", "qs") ?? [];
    // Run only the node part (no yarn install in a unit test).
    const script = (argv[2] ?? "").replace(/ && yarn install.*$/s, "");
    await run("sh", ["-c", script, "sh", "qs"], { cwd: dir });
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(join(dir, "yarn.lock"), "utf8");
    expect(text).not.toContain('version "6.5.3"');
    expect(text).toContain("qsx@^1.0.0");
    expect(text).toContain('"@a/qs@^1"');
  });
});

describe("Python projects without tests", () => {
  it("check that the project's packages still import", async () => {
    const dir = await repo({
      "setup.py": "setup()",
      "src/mylib/__init__.py": "",
      "tests_data/x.txt": "",
      "docs/__init__.py": "",
    });
    const inv = await inventory(dir, "pypi");
    const build = inv.checks.find((c) => c.name === "build");
    expect(build?.argv.join(" ")).toContain("import mylib");
    expect(build?.argv.join(" ")).not.toContain("import docs");
  });
});

describe("which requirement files install", () => {
  it("app + dev/test files, test-folder files, never minimum-version pins", () => {
    expect(
      installSet([
        "requirements.txt",
        "requirements_test.txt",
        "requirements_test_minimum_ha.txt",
        "requirements-docs.txt",
        "test/requirements.txt",
      ]),
    ).toEqual(["requirements.txt", "requirements_test.txt", "test/requirements.txt"]);
  });

  it("installs requirements kept in the test folder", async () => {
    const dir = await repo({
      "requirements.txt": "flask==3.0.0\n",
      "test/requirements.txt": "pytest==8.0\nvmtest @ git+https://github.com/osbuild/images.git\n",
      "test/test_x.py": "",
    });
    const inv = await inventory(dir, "pypi");
    expect(inv.manifests).toContain("test/requirements.txt");
    expect(inv.checks[0]?.argv.join(" ")).toContain("test/requirements.txt");
  });
});
