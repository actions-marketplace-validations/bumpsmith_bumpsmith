# Repository zoo

Does Bumpsmith work on the repository in front of it? The zoo answers that without any
AI: 42 real repositories, picked by shape from recent merged Dependabot pull requests, run
through everything except the model. For each one Bumpsmith clones it, works out the package
manager and checks, installs in the sandbox, runs the checks, applies the bump, and runs
the checks again.

- Repositories: `bench/zoo.json` (13 shapes: npm, pnpm, pnpm workspaces, Yarn 1, Yarn 2+,
  Bun, requirements files, requirements directories, setup.py, Poetry, uv, Pipenv, PEP 621).
- Results: `bench/zoo-results.json`. Run it yourself: `pnpm bumpsmith bench zoo`
  (`bench zoo-mine` picks a fresh set).
- Machine: an ARM Mac (Docker on arm64). GitHub's runners are x86_64.

|                                                                          | First run              | Now          |
| ------------------------------------------------------------------------ | ---------------------- | ------------ |
| Repositories                                                             | 38 (run stopped early) | 42           |
| Dependencies install                                                     | 24                     | **38** (90%) |
| Verifiable (a build, typecheck or test passes before and after the bump) | 16                     | **32** (76%) |
| Crashes (an error instead of an explained outcome)                       | 8                      | **0**        |

| Shape                                                      | Verifiable / repositories |
| ---------------------------------------------------------- | ------------------------- |
| Poetry, uv, Yarn 1, Bun, requirements directories, Yarn 2+ | all                       |
| npm, pnpm, pnpm workspaces, PEP 621 (hatch)                | 3 of 4                    |
| requirements.txt                                           | 1 of 4                    |
| setup.py, Pipenv                                           | 0 of 3                    |

## What the first run found, and what changed

- **Transitive updates.** Dependabot security PRs often bump a package nothing declares
  (`qs` under `express`). These crashed; now the lockfile alone is updated with each package
  manager's own command, and the job reports whether the target version was reached.
- **Python projects.** The interpreter now comes from `.python-version` or
  `requires-python`, and the image's other Pythons (3.10 to 3.15) are tried when pins need
  a different one. Requirement files in `requirements/` and `test/` install with the app,
  but minimum-version pin files don't. Poetry and Pipenv locks refresh after a bump, `src/`
  layouts are importable, and projects without tests get an import check. Packages declared
  only in nested files (`tools/docs-requirements.txt`) are bumped where they are.
- **Git dependencies.** Public ones (GitHub, GitLab, Bitbucket, Codeberg) are fetched by the
  host, only the referenced commit, and served to the sandbox, which still has no internet.
- **Databases.** Services from the CI workflow (postgres, mysql, mariadb, redis, valkey,
  mongo) run as sidecars on the sandbox's localhost.
- **Tests that already fail.** They are compared test by test: the same failures and passing
  tests count as verified; any newly failing test is a regression.
- **Monorepos.** Workspace members that share the root lockfile are supported, and a root
  PR for a package only members declare bumps every member.
- **Install reliability.** The registry mirror queues and retries instead of failing
  installs, installs retry once on network errors, and clones retry. Lockfiles that point
  at public npm mirrors (npmmirror) install. Node 26 is available.
- **Explanations.** Every early stop and failing baseline now gets a reason in plain words.

These changes were made after looking at this set, so the zoo is not unseen. `bench
zoo-mine` draws a fresh one.

## The ten that are not verifiable, and why

| Reason                                                                                          | Repositories |
| ----------------------------------------------------------------------------------------------- | ------------ |
| A pinned package has no build for ARM (installs on x86_64, so on GitHub's runners)              | 3            |
| Nothing to check: no build, typecheck, test or importable package                               | 3            |
| Checks need the internet, or a file generated outside the repo (a Rust/wasm build)              | 2            |
| Tests take longer than the 15-minute limit (configurable in `.bumpsmith.yml`)                   | 1            |
| A large monorepo ran out of the time budget (this run predates skipping already-failing checks) | 1            |

None of them stops silently: each pull request or CLI run says which of these applies.
