# Contributing to Bumpsmith

Thanks for helping! Bumpsmith is Apache-2.0 licensed.

## Developer Certificate of Origin

Every commit must be signed off (`git commit -s`), certifying the
[Developer Certificate of Origin](https://developercertificate.org/): you wrote the change
or have the right to submit it under the project licence.

## Getting started

Requirements: Node 22+, pnpm 11, Docker (for the sandbox).

```sh
pnpm install
pnpm check            # typecheck, lint, unit + Action tests
pnpm test:docker      # sandbox isolation and exfiltration tests (needs Docker)
pnpm build            # bundles dist/cli.js and dist/action.js (commit dist/ with your change)
```

## Ground rules

- **Safety first.** Changes to the publishing path (`src/github/publish/`), the diff rules
  (`src/review/rules.ts`), the edit policy (`src/agent/policy.ts`), the sandbox or the
  registry mirror need a test that shows the attack they prevent still fails.
- **No new runtime dependency** without a reason in the PR; versions are pinned and must be
  at least 3 days old (`minimumReleaseAge`).
- **No shell strings.** Run programs with argv arrays (`src/util/proc.ts`).
- Keep prompts versioned (`*_PROMPT_VERSION`) and mention prompt changes in the PR.
- Benchmark changes: report solve rate on `bench/tasks-npm.json` and say whether you tuned on it.

## Reporting bugs

Open an issue with the repository (if public), the package and versions, and the
`evidence.md` Bumpsmith produced. Security problems: see [SECURITY.md](SECURITY.md).
