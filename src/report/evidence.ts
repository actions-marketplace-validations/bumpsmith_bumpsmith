import type { JobRecord } from "../pipeline.ts";
import type { CheckName } from "../schemas/job.ts";

const mark = (v: boolean | null | undefined) => (v === true ? "pass" : v === false ? "FAIL" : "-");

/** Evidence document in the PRD appendix A pull-request format (PR-1). */
export function renderEvidence(job: JobRecord): string {
  const i = job.input;
  const rec = job.change_record;
  const lines: string[] = [];
  lines.push(`# Upgrade ${i.packageName} ${job.from ?? "?"} → ${i.to}`, "");
  lines.push(
    `**State:** ${job.state}  ·  **Confidence:** ${(job.confidence ?? "n/a").toUpperCase()}  ·  **Cost (API list price):** $${(job.cost_usd ?? 0).toFixed(2)}  ·  **Time:** ${Math.round((job.duration_ms ?? 0) / 1000)}s`,
    "",
  );
  if (job.error) lines.push(`> **Error:** ${job.error}`, "");
  for (const n of job.notes) lines.push(`> ${n}`);
  if (job.notes.length) lines.push("");

  if (job.impact) lines.push("## Summary", "", job.impact.reason, "");

  if (rec) {
    lines.push("## What changed upstream", "");
    if (!rec.changes.length) lines.push("No breaking changes were found in the sources.");
    for (const c of rec.changes) {
      lines.push(
        `- **${c.id} ${c.kind.toUpperCase()}** \`${c.symbols.join("`, `")}\` — ${c.instruction} _(confidence ${c.confidence}; ${c.detected_by.join(", ")})_`,
      );
      for (const e of c.evidence.slice(0, 2))
        lines.push(`  - > ${e.quote.replace(/\n/g, " ").slice(0, 240)} — [source](${e.url})`);
    }
    lines.push("");
  }

  if (job.impact?.items.length) {
    lines.push("## Where this repository was affected", "");
    for (const it of job.impact.items)
      lines.push(`- \`${it.file}:${it.line}\` [${it.change_id}] \`${it.snippet}\``);
    lines.push("");
  }

  if (job.verdict) {
    lines.push("## Verification", "", "| Check | Before | After |", "|---|---|---|");
    for (const c of job.verdict.comparisons)
      lines.push(
        `| ${c.name as CheckName} | ${mark(c.baseline)} | ${mark(c.after)}${c.flaky ? " (flaky)" : ""}${c.sameFailures ? ` (same ${c.sameFailures.failing.length} failing test(s) as before; ${c.sameFailures.passed} pass)` : ""}${c.newFailures ? ` (newly failing: ${c.newFailures.slice(0, 5).join(", ")})` : ""} |`,
      );
    lines.push("");
    if (job.verdict.preexistingFailures.length)
      lines.push(
        `Already failing before the upgrade: ${job.verdict.preexistingFailures.join(", ")}.`,
        "",
      );
  }

  if (job.rounds.length) {
    lines.push("## Agent rounds", "");
    for (const r of job.rounds) {
      lines.push(
        `### Round ${r.round} (${r.stop}${r.error ? `: ${r.error}` : ""})`,
        "",
        r.summary.trim() || "_(no report)_",
        "",
      );
    }
  }

  if (job.edits?.length) {
    lines.push("## Files edited by the agent", "");
    for (const e of job.edits)
      lines.push(`- \`${e.path}\`${e.allowlisted ? "" : ` — outside allowlist: ${e.reason}`}`);
    lines.push("");
  }

  if (job.rules?.length) {
    lines.push("## Safety rules", "");
    for (const f of job.rules)
      lines.push(
        `- **${f.severity.toUpperCase()}** ${f.rule}${f.file ? ` in \`${f.file}\`` : ""}: ${f.detail}`,
      );
    lines.push("");
  } else if (job.rules) lines.push("## Safety rules", "", "No findings.", "");

  if (job.review) {
    lines.push(`## Independent review: ${job.review.verdict}`, "", job.review.summary, "");
    for (const c of job.review.criteria)
      lines.push(`- ${c.pass ? "pass" : "FAIL"} **${c.id}** — ${c.reason}`);
    if (job.review.unverified.length) {
      lines.push("", "**Not verified**", "");
      for (const u of job.review.unverified) lines.push(`- ${u}`);
    }
    lines.push("");
  }

  lines.push("## Provenance", "");
  lines.push(`- Provider: ${job.provider} · model ${job.model}`);
  lines.push(
    `- Prompts: ${Object.entries(job.prompt_versions)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  if (rec)
    lines.push(
      `- Change Record: v${rec.record_version}, sources: ${rec.sources.map((s) => s.kind).join(", ") || "none"}`,
    );
  lines.push(
    `- Job: ${job.id}`,
    "",
    "_Roll back by reverting this change; no data or schema changes are made by Bumpsmith._",
    "",
  );
  return lines.join("\n");
}
