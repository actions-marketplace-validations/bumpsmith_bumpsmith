# Benchmark results

Bumpsmith is measured on real dependency upgrades that broke something and that a human
later fixed in a merged pull request. Each task replays the upgrade on the commit before
the human fix, runs Bumpsmith end to end in the sandbox, and compares the outcome with
what the human did.

## Held-out set v1 (`bench/heldout-v1.json`)

- 24 tasks: 15 npm, 9 PyPI, one task per library, from repositories that are **not** in
  the development set (`bench/tasks-npm.json`), merged after 2026-03-01.
- Model: Claude through the `claude-code` provider (a Claude Code subscription).
- Raw data: `bench/results-heldout-v1.json`; per-task evidence in `bench/runs/<job>/`.

| | |
|---|---|
| Tasks | 24 |
| Attempted (the sandbox could run the repository) | 22 |
| **Ready** (verified in the sandbox, review approved) | **12** (55% of attempted, 50% of all) |
| Ready at high / medium / low confidence | 4 / 6 / 2 |
| Sent to a human (could not prove the change) | 9 |
| Correctly refused | 1 (target release listed as malicious, GHSA-cg8m-r9f2-5wm2) |
| Safety-rule false positives | 0 |
| Model cost, API-equivalent | $8.73 total, $0.73 per ready result |
| Median time per task | 3.3 minutes |

"Ready" requires that dependencies install and at least one build, typecheck or test
passes after the upgrade. Anything less goes to a human at low confidence, whatever the
model says.

### Are the ready results right?

Each ready result was compared with the files the human changed:

- **8 of 12** touched the same files as the human fix (7 fully, 1 partly).
- **4 of 12** were version-and-lockfile only: every check passed with no code change,
  while the human pull request also changed application code. Those pull requests may
  bundle unrelated work, so these four are counted as **unconfirmed**, not as correct.

So precision on ready results is between 67% (8/12, counting the unconfirmed as wrong)
and 100%. A manual review of the four is the next step.

### Where it stops, and why

| Outcome | Tasks | Cause |
|---|---|---|
| Tests already failing before the upgrade | 4 | e.g. Django tests that need PostgreSQL; a CLI the tests call is not installed. Needs service containers (planned). |
| Dependencies cannot be installed in the sandbox | 4 | a git dependency from GitHub; GPU builds of torch over the disk limit; a package that needs a system library (LevelDB). |
| Behaviour changes the tests could not prove | 1 | `sinon` 18 → 22 across a large test suite. |
| Infrastructure | 2 | the repository's own peer dependencies conflict before the upgrade; a repository too large to clone. |

Install and policy failures now explain themselves in plain words in the pull request or CLI output; the two infrastructure failures still show the raw tool error.

### How the number moved, and a caveat

The first run on this set reported 14 of 24 ready. That number was wrong: six Python
"fixes" were version bumps on repositories whose dependencies never installed, so nothing
was verified. The fixes that followed:

- never report ready without a passing install and a passing check;
- bump every manifest that declares the package, including pip-tools `.in` files and
  hash-pinned requirements;
- bundle Python 3.10–3.14 in the sandbox; resolve requirements with uv; build tools for
  packages compiled from source;
- Yarn 4 repositories that vendor their own release; repositories with both
  `package.json` and Python manifests;
- a safety rule that read `engines.node` in `package.json` as a new dependency.

These fixes were made after seeing results on this set, so v1 is no longer fully unseen.
A fresh held-out set (v2), mined after these changes, will give the clean number. This
page will report both.

## Other providers

The same benchmark runs with any provider (`--provider`). Community runs are welcome:

```sh
pnpm bumpsmith bench run --tasks bench/heldout-v1.json --provider openai --model <model>
```

| Provider | Model | Ready / attempted | Notes |
|---|---|---|---|
| Claude Code subscription | Claude | 12 / 22 | this page |
| Codex, OpenAI, Gemini, OpenRouter, Ollama | | not run yet | |
