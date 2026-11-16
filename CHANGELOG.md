# Changelog

## 0.1.0 — unreleased

First public release.

- CLI: `bumpsmith fix`, `explain`, `scan`.
- GitHub Action: rescues red Dependabot/Renovate pull requests with a verified companion PR.
- Sandbox with a read-only registry mirror (GET/HEAD only); install scripts off; 3-day release-age gate.
- Publishing path re-checks the reviewed patch hash and diff rules, applies the patch strictly, never overwrites human commits or reopens closed PRs.
