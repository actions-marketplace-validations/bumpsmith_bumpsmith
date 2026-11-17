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
