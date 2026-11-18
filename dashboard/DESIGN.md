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
- **Run page as a pull request**: tabs for Summary, Changes, Checks, Breaking changes and
  Log; the diff has a file tree, and the agent's edits are marked apart from the lockfile.
- **Dark mode** follows the system setting, with a toggle; many developers live in it.
- **8pt grid**: spacing in 4/8 steps, controls 32/40px, radii 8/12.

## References

- Mobbin: Vercel project overview, Render events, Cloudflare Workers deployments, Railway
  deployments, GitLab pipelines and security dashboard, Supabase Security Advisor, Vanta
  findings, Devin and Cursor diff review.
- Dribbble: "AI IDE Analytics Dashboard" (Demyanchuk Art Team), "Kodezi Developer
  Analytics Dashboard" (Wavespace), "Coherence Developer Platform" (Airzon), "Zereth AI
  Developer Platform" (Exalt Studio).
