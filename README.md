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
> Bumpsmith. On a **held-out** set of 24 upgrades (15 npm, 9 PyPI) from other repositories,
> it produced a verified fix for 12 of the 22 it could run, refused one malicious release,
> and sent the rest to a human with the reason. Details and caveats:
> [bench/RESULTS.md](bench/RESULTS.md). On 42 real repositories of 13 shapes (npm, pnpm,
> Yarn, Bun, workspaces, pip, Poetry, uv, Pipenv, setup.py), it sets up 38 and can verify 32
> with no crashes; the rest say why: [bench/ZOO.md](bench/ZOO.md).

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

### Dashboard

```sh
npx bumpsmith dashboard                # opens http://127.0.0.1:4477
```

The first start prints a one-time link that creates the owner account. After that, everyone
signs in.

A dashboard for everything Bumpsmith did in this repository:

- **Overview:** what's ready to apply, verification rate, spend and time to green, a check-health map and where upgrades stop.
- **Upgrade detail:** each pipeline stage, your checks before and after (with their output), the diff with the agent's edits marked, the breaking changes it read, the independent review and the cost. **Apply patch** stages a verified result in one click.
- **New upgrade:** pick a dependency and a model, then watch it run live in the sandbox.
- **Dependencies:** your upgrade debt, with one-click upgrades.
- **Search:** ⌘K across upgrades, dependencies and actions.

It runs on 127.0.0.1 and sends nothing anywhere: fonts are bundled and there's no analytics.

**Access and audit:**

- **Sign-in:** accounts with passwords checked against a breached-password list and lockout after repeated failures.
- **Sessions:** server-side, ending after 30 minutes idle or 12 hours. Every change carries a CSRF token.
- **Permissions:** every action is checked on the server against the user's role.
- **Audit log:** sign-ins and actions go into a tamper-evident (hash-chained) log.

Accounts, the audit log and the encryption key live in `~/.bumpsmith` (or `--data`), readable only by your user.

### Self-hosted server for your team

```sh
cd deploy && echo "BUMPSMITH_DOMAIN=bumpsmith.acme.dev" > .env
openssl rand -base64 32 > master.key && docker compose up -d
```

The same app runs as a multi-user server behind HTTPS. Members are added by invitation, or created on their first SSO
sign-in.

- **Sign-in:** two-factor authentication, single sign-on (OIDC and SAML) with group-to-role mapping.
- **Roles:** built-in and custom roles.
- **Access control:** an access control center for each repository.
- **Integrations:** encrypted GitHub and model credentials.
- **Onboarding:** guided in the browser.

Read [Self-hosting](docs/self-hosting.md) to deploy it. Read [Security controls](docs/security/controls.md) for the
SOC 2, ISO 27001, NIST 800-63B and OWASP ASVS mapping, and for what you are responsible for as the operator.

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

- Grouped bot PRs are handled as one job: the biggest major jump is analysed in depth and the
  other packages are upgraded with it (each still release-gated). Packages in a monorepo
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
