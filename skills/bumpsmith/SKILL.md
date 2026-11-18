---

name: bumpsmith
description: Upgrade a dependency across a breaking change and prove it works. Use when the user wants to upgrade, bump or update an npm or PyPI package (especially a major version), fix a red Dependabot or Renovate pull request, asks what breaks in a new version, whether a release is safe to install, or which dependencies are out of date. Bumpsmith reads the release notes, fixes the code in an isolated sandbox, runs the repository's own checks before and after, and has an independent reviewer check the diff.
---

# Bumpsmith: verified dependency upgrades

Bumpsmith does the work a major-version bump leaves behind. It reads what changed upstream: every breaking change is quoted from the release notes or type definitions. It finds every affected call site, and edits the code in an isolated container. It runs the repository's own install, build, typecheck, lint and tests **before and after**, then has a separate reviewer and plain-code safety rules check the diff. It never pushes to a branch; the user decides.

## Use it when

- the user asks to upgrade, bump or update a dependency, especially across a **major** version;
- a Dependabot or Renovate pull request is failing CI;
- the user asks what breaks in a new version, or whether a release is safe to adopt;
- the user wants to know which dependencies are behind.

Prefer Bumpsmith over editing `package.json`, a lockfile or `requirements.txt` by hand and hoping the tests pass. Bumpsmith proves the result in a sandbox, and refuses releases that are too new or listed as malicious.

## Connect

**MCP (preferred).** If the `bumpsmith` tools are available (`check_release`, `start_upgrade`, …), use them. If they are not, the user can add the server:

```sh
claude mcp add bumpsmith -- npx -y bumpsmith mcp        # Claude Code
codex mcp add bumpsmith -- npx -y bumpsmith mcp         # Codex
# any other client: command `npx`, args `-y bumpsmith mcp`
```

**CLI (fallback).** It needs Node 22.13+ and Docker:

```sh
npx bumpsmith scan                       # what is behind (no AI)
npx bumpsmith explain <pkg>@<version>    # what breaks, and where
npx bumpsmith fix <pkg>@<version>        # upgrade + fix + verify; writes .bumpsmith/runs/<id>/
```

## Workflow

1. **Pick the target.** If the user named no version, call `scan_dependencies` (or `check_release` with no version) to find the latest. Upgrade one package at a time.
2. **Check the release.** Call `check_release`. If it is not OK to adopt (too new, yanked, deprecated or malicious), stop and tell the user why. Do not work around the release-age wait unless the user explicitly insists, and say what the risk is.
3. **Explain (optional, recommended for big jumps).** `explain_upgrade` lists the breaking changes with quotes, and every affected line. Share the short version with the user.
4. **Run it.** Call `start_upgrade` and keep the returned id. Then poll `get_upgrade` every 20–30 seconds. A run usually takes 2–6 minutes. Tell the user it is running; don't sit silent.
5. **Read the result** from `get_upgrade` (pass `include_patch: true` to see the diff):

| State            | Meaning                                                                                         | What to do                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ready`          | Verified in the sandbox and approved by the independent review.                                 | Offer to apply.                                                                                                            |
| `safe`           | Version bump only; the checks pass with no code changes.                                        | Offer to apply.                                                                                                            |
| `needs_human`    | Bumpsmith could not prove the change.                                                           | Summarise why from the evidence, show the affected code, and work through it with the user. **Never present it as fixed.** |
| `blocked_policy` | Refused (malicious, too new, or a safety rule).                                                 | Explain the reason. Don't retry around it.                                                                                 |
| `failed_infra`   | The sandbox could not run the repository (for example a private registry, or a system library). | Report the reason.                                                                                                         |

6. **Apply only with the user's go-ahead.** `apply_upgrade` stages a `ready` or `safe` patch with `git apply --index`. Then tell the user to review `git diff --cached` and commit. Bumpsmith never commits or pushes for them.
7. **Report back** in a few lines:
   - what changed upstream (the main breaking changes);
   - what changed in their code (the files);
   - which checks passed before and after;
   - anything the reviewer said it could not verify. Always mention this.

## Rules

- Never claim an upgrade works unless Bumpsmith's state is `ready` or `safe`. Never claim a check passed unless the evidence shows it.
- Don't hand-edit around a `needs_human` result and then call it verified. If you fix it yourself, say that your changes were not verified by Bumpsmith, and suggest running the repository's tests.
- Keep the user's spend in mind. Each run has a budget (default $8, typically under $1). Ask before starting many runs at once.
- On a shared Bumpsmith server (HTTP MCP with an API token), you can only see and start what the token allows. A permission error is a real answer; don't retry it.
