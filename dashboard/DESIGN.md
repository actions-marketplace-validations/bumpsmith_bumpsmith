# Bumpsmith Local dashboard: design notes

## Who it is for

Software engineers, engineering leads and open-source maintainers who live in GitHub, their
terminal and CI. They read diffs, check marks and versions all day. They trust tools that
look like the tools they already trust (GitHub, Vercel, Linear, Cloudflare), and distrust
anything that looks like marketing.

## Story of the page

| Area           | Job      | The developer's question                                       |
| -------------- | -------- | -------------------------------------------------------------- |
| Header         | Status   | Is anything waiting on me?                                     |
| Stats          | Proof    | Is this tool doing real, verified work, and what does it cost? |
| Ready to apply | Action   | What can I merge right now?                                    |
| Activity       | Rhythm   | How much is it doing over time, and how does it end?           |
| Recent runs    | Record   | What happened on every run?                                    |
| Run page       | Evidence | Can I trust this one change? (diff, checks, review, reasons)   |

## Signature move

**The "Ready to apply" queue**: an inbox of verified upgrades, each with a GitHub-style
check strip and an inline Apply button. The dashboard leads with what the developer can
act on, not with charts.

## Kept from the husori design language (on request)

- warm off-white canvas, near-white panels, hairline separators;
- the sidebar with its context card and grouped navigation;
- 3D buttons: a soft vertical gradient, an inner top highlight and a 1px bottom edge, which
  press down on click.

## Dropped (consumer patterns that do not fit this audience)

- Mona Sans and wide uppercase display headlines; now Geist and Geist Mono, the de-facto
  type pair of developer tools;
- the flip-clock ticker, monogram package tiles, the illustrated empty state and the dark
  "payout" card;
- the time-of-day greeting.

## Logo

The wordmark is drawn, not typed (`dashboard/brand/`, chosen from four directions):

- one stroke weight, square terminals, and rounded corners only where a stroke turns, the
  same radius logic as the dashboard's cards and buttons;
- the only colour is the dot of the i: an ember square raised to the ascender line, so it is
  literally "bumped" up. It is the same square as the diffstat squares and tick meters;
- the icon (`brand/icon.svg`, used as the favicon) is the custom b with the ember square as a
  badge, on a tile finished like the 3D buttons;
- in the app it is inline SVG using `currentColor`, so it follows light and dark mode; the
  sidebar shows it at 18px, and on phones it moves into the top bar.
- references: Resend, Unkey and Knock wordmarks (inspiration board picks 11, 13 and 15).

## Decisions

- **Type**: Geist 13–14px for UI, 20px semibold page titles, 24px for stat values. Geist
  Mono for every version, hash, path, number in tables, and run id, because developers scan
  those characters.
- **Colour**: neutral greys plus one accent, ember (`#f25a1d`), the brand colour, used only
  for the primary action, focus and "ready" counts. Status colours are muted (green, amber,
  red) and always come with a word or icon, never colour alone.
- **Tick meters** instead of decorative charts for ratios (ready / total, verified rate):
  segmented bars read at a glance and stay honest at small counts.
- **Contribution graph** for activity: every developer already reads GitHub's.
- **Run page as a pull request**: tabs for Summary, Files changed, Checks, Breaking changes,
  Log and Report; the diff has a file tree, and the agent's edits are marked apart from the
  lockfile.
- **Dark mode** follows the system setting, with a toggle; many developers live in it.
- **8pt grid**: spacing in 4/8 steps, controls 32/40px, radii 8/12.

## Files changed, Log and Report (GitHub conventions, on purpose)

Developers review diffs in GitHub every day, so these three views copy its conventions
closely instead of inventing new ones. Anything unfamiliar here costs trust.

**Files changed** (`src/dashboard/client/diff.ts`)

- A file tree on the left (folders compressed, status icons for added, modified, deleted and
  renamed files, a filter box), and one card per file on the right.
- Sticky file headers: collapse chevron, expand-all, `+/-` count with GitHub's five
  diffstat squares, the path with the file name in bold, copy path, and a **Viewed**
  checkbox. "x / n viewed" with a progress bar is remembered per run in the browser.
- Two line-number columns, blue `@@` hunk rows with the enclosing function, and expanders
  that load the hidden lines from the run's stored `before/` and `after/` files.
- GitHub's Primer colours for additions, deletions, hunks and word-level highlights, in light
  and dark; syntax colours stay on inside a highlighted word.
- Unified or split view (remembered), line wrapping, and lockfiles collapsed as generated
  with "Load diff", like GitHub does. Large diffs are collapsed the same way.
- **What GitHub does not have**: every file is labelled by who changed it: _edited by the
  agent_ (ember edge on the card and a dot in the tree), _version bump_ (the manifest) or
  _package manager_ (the lockfile). The reviewer's question is "what did the AI touch?", and
  this answers it at a glance.

**Log** (`src/dashboard/client/log.ts`): a GitHub Actions job log, always dark.

- One collapsible step per stage (set up, release gate, changelog, affected code, checks
  before and after the bump, the fix with each tool call and its time offset, review,
  result), with status icons and durations; failed and warning steps open by default.
- Line numbers, search with match counts per step, expand/collapse all, download as text.
- ANSI colour codes from test runners and build tools render as colours instead of noise.
- A check that already fails before the upgrade is amber, not red: it is not counted against
  the upgrade, and the log says so. The header follows the run's result, not the number of
  red steps.
- The same component is used for check output and the live run in the drawer.

**Report**: `evidence.md` rendered like a `.md` file on GitHub (Preview / Code toggle, line
numbers in Code), with a small Markdown renderer that escapes everything and only links
`http(s)` URLs.

**Breaking changes**: API signatures from `.d.ts` files arrive on one line with their doc
comments; they are tidied (comments dropped, one member per line) and shown as a real line
diff, so "interface became type alias, three fields added" is visible at once.

## References

- Mobbin: Vercel project overview, Render events, Cloudflare Workers deployments, Railway
  deployments, GitLab pipelines and security dashboard, Supabase Security Advisor, Vanta
  findings, Devin and Cursor diff review.
- Dribbble: "AI IDE Analytics Dashboard" (Demyanchuk Art Team), "Kodezi Developer
  Analytics Dashboard" (Wavespace), "Coherence Developer Platform" (Airzon), "Zereth AI
  Developer Platform" (Exalt Studio).
- Files changed, Log and Report research:
  - Mobbin: GitHub pull request Files changed (file tree, sticky headers, Viewed, split
    view), GitHub Actions job logs, Laravel Cloud deployment logs, Browserbase session logs.
  - Dribbble: "Updated GitHub diffs" (GitHub), "Code Diff Multi-Line Comment" (Liviu Ang),
    "Guildhall: Review What Your AI Agent Changed" (Kretya), "GitHub Desktop" (Nicolas
    Solerieu), "Diffwise: Agent Plan & Diff Review for AI Coding" (Niksdesign).
  - Primer (GitHub's design system) for the diff and syntax colour values.
