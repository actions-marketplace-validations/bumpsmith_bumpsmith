# Bumpsmith

**Fixes your code when a dependency ships a breaking change.**

Dependabot and Renovate tell you a new major version is out. Then the pull request goes
red, because the new version renamed a function, removed an option or changed a default,
and someone has to dig through the changelog and fix the call sites. Bumpsmith does that
part:

1. reads the release notes, changelog, migration guide and type definitions to list
   exactly what changed (every claim backed by a verbatim quote);
2. finds every place in your code that is affected;
3. upgrades and edits the code inside an isolated container, runs your install, build,
   type check, lint and tests, and compares them with the run before the upgrade;
4. has an independent reviewer check the diff, applies plain-code safety rules, and
5. hands you a pull request (or a patch) with the evidence: what changed upstream, what
   changed here, which checks pass before and after, and what could not be verified.

A human always merges. Bumpsmith never pushes to your default branch.

> Status: **v0.1, early.** npm (npm, pnpm, Yarn 1–4, Bun) and PyPI (pip, uv, Poetry).
> On 27 real merged Dependabot upgrades where a human had to fix code, Bumpsmith produced
> a verified fix for 21 of the 22 it could run (5 used private registries or git
> dependencies), at about $1 of model cost per fix. Those tasks were also used to improve
> Bumpsmith, so expect a lower rate on new repositories; a held-out benchmark is next.

## Quick start: GitHub Action

Rescue red Dependabot/Renovate pull requests automatically:

```sh
npx bumpsmith init     # writes .github/workflows/bumpsmith.yml (wired to your CI) and .bumpsmith.yml
```

Then add your model key as a repository secret. Any of these providers works in the Action:
`anthropic` (default), `openai`, `gemini`, `openrouter`, `groq`, `together`, `deepseek`, or
`custom` with a `base-url` for any OpenAI-compatible endpoint. Set `provider`, `api-key` and
`model` in the workflow ([example](examples/bumpsmith.yml)).

When CI fails on a bot PR, Bumpsmith opens a companion PR with the same upgrade plus the
code changes, links the two, and comments on the bot PR. If it cannot produce a verified
fix, it says why and lists the affected code instead.

### Tokens

Pull requests opened with the default `GITHUB_TOKEN` [do not trigger your CI](https://docs.github.com/en/actions/concepts/security/github_token),
so you would not see your own checks on Bumpsmith's PR. Recommended: create a small
GitHub App for your organisation (permissions: Contents and Pull requests write, Checks
read), install it on the repository, and set the `BUMPSMITH_APP_ID` variable and
`BUMPSMITH_APP_PRIVATE_KEY` secret. The example workflow then uses
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).

## Quick start: CLI

Needs Node 22+ and Docker.

```sh
npx bumpsmith scan                     # which dependencies are a major (or more) behind; no AI
npx bumpsmith explain zod@4.1.0        # what breaks and where your code is affected
npx bumpsmith fix zod@4.1.0            # upgrade + fix + verify; writes a patch and evidence
npx bumpsmith fix zod@4.1.0 --apply    # ...and stage the patch if it was verified
```

Model access, pick one:

| Provider                                                  | What you need                                                            | Billing            |
| --------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| `anthropic-api` (default when `ANTHROPIC_API_KEY` is set) | an Anthropic API key                                                     | pay per use        |
| `--provider claude-code`                                  | the official Claude Code CLI, signed in with your Pro/Max plan           | your plan's limits |
| `--provider codex`                                        | the official Codex CLI, signed in with your ChatGPT plan (`codex login`) | your plan's limits |

Subscription providers run the official CLI you signed in to; Bumpsmith never sees or
stores your login, and switches off the CLI's own shell, browser and web tools so the model
can only use Bumpsmith's confined tools. They are for your own use on your own machine.
Results go to `.bumpsmith/` (add it to `.gitignore`).

Open pull requests straight from your machine (uses `GITHUB_TOKEN` or your `gh` login):

```sh
npx bumpsmith rescue --github owner/repo --provider claude-code     # fix red Dependabot/Renovate PRs
npx bumpsmith fix zod@4.1.0 --github owner/repo --provider codex     # one upgrade, as a PR
```

Pull requests opened this way come from your account, so your CI runs on them. GitHub marks
commits "Verified" only when they are made by a GitHub App, so use the Action with an App
token if you want signed commits.

## How Bumpsmith stays safe

Bumpsmith runs code it did not write (your dependencies' install and test steps) and lets
an AI model edit your repository, so it assumes both can be hostile.

- **Isolated execution.** Installs, builds and tests run in a container with no
  credentials, no environment from the host, CPU/memory/process/time limits, and no
  network, except during installs, when the only reachable server is a **read-only
  registry mirror**. The mirror allows only `GET`/`HEAD` to npm and PyPI hosts and strips
  credentials, so code cannot publish your source to a registry or call home.
- **Supply-chain caution.** New versions are used only after a 3-day release-age wait,
  install scripts are off, and versions on the OSV malicious-package list are refused.
- **Limited AI.** The agent has no shell: only file tools confined to the repository and
  named check commands. It cannot edit CI workflows, secrets, infrastructure or other
  protected files. Secrets found in files are masked before anything reaches the model.
- **Independent checks before anything is written.** Plain-code rules (no new network or
  process calls, no new dependencies, no weakened tests, no protected paths) and a separate
  AI reviewer. The publishing step re-checks the patch's hash and the rules itself and
  rebuilds every file from your default branch with a strict, no-fuzz patch.
- **Respect for your repository.** Config is read only from the default branch, and can
  tighten but never loosen these rules. Bumpsmith never overwrites a commit a human
  pushed, never reopens a PR you closed, never force-pushes your branches, and labels its
  PRs `ai-generated` with the model named.
- **In the GitHub Action,** it never checks out or runs the bot PR's code; it rebuilds the
  upgrade from your default branch. Tokens stay in the Action process, masked in logs.

Found a hole? See [SECURITY.md](SECURITY.md).

## Configuration: `.bumpsmith.yml` (optional)

```yaml
version: 1
ecosystems: [npm, pypi]
release_age_days: 3 # can be raised, not lowered
limits:
  open_pull_requests: 3
ignore:
  - package: react
    versions: ["19.x"]
checks: # optional; detected automatically
  test: "pnpm test"
pull_requests:
  labels: [dependencies, bumpsmith]
  draft_below: medium # open as draft below this confidence
rules:
  protected_paths: ["infra/**"]
```

Commands are plain argv (no shell operators). Invalid files fall back to safe defaults.

## Limitations

- Grouped bot PRs (several packages at once) are skipped for now. Packages in a monorepo
  sub-directory are supported when they have their own lockfile; workspace members that
  share the root lockfile are reported as not supported yet.
- Private registries and git dependencies are not supported in the sandbox.
- Tests that need databases or other services cannot run yet.
- Linux runners (Docker) for the Action.

## Development

```sh
pnpm install && pnpm check     # typecheck, lint, unit and Action tests
pnpm test:docker               # sandbox isolation and exfiltration tests
pnpm bumpsmith bench run --tasks bench/tasks-npm.json --provider claude-code
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [Apache-2.0](LICENSE).
