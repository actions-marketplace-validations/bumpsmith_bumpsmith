// A GitHub Actions-style job log built from a run's job.json: one collapsible step per
// stage, line numbers, colours for commands, errors, warnings and agent tool calls.
import { ansiHtml, hasAnsi, stripAnsi } from "./ansi.ts";
import { dur, esc, icon, markRange } from "./ui.ts";

export type LineKind = "cmd" | "err" | "warn" | "ok" | "dim" | "head" | "tool" | "plain";
export interface LogLine {
  /** Plain text: what search, colouring and download use. */
  text: string;
  /** The original line when it carries ANSI colour codes. */
  raw?: string;
  kind?: LineKind;
  /** Offset from the start of the run, e.g. "+01:12". */
  at?: string;
  /** Hanging indent in characters, so wrapped detail lines stay in their column. */
  indent?: number;
  /** Leave the time column empty but keep its width (detail under a timed line). */
  under?: boolean;
}
export interface LogStep {
  id: string;
  name: string;
  status: "ok" | "fail" | "warn" | "skip";
  ms?: number;
  lines: LogLine[];
}

// biome-ignore lint/suspicious/noExplicitAny: job.json is read defensively
type Job = any;

/** Colour a raw output line by what it says (test runners, compilers, package managers). */
export function classify(text: string): LineKind {
  if (/^\s*(\$|>) /.test(text)) return "cmd";
  if (/\b(error|ERR!|FAIL(ED)?|failed|✕|✗|Traceback|exception|Exception)\b|^E\s/.test(text))
    return "err";
  if (/\b(warn(ing)?|WARN|deprecated)\b/i.test(text)) return "warn";
  if (/\b(PASS(ED)?|passed|✓|✔|success(ful)?)\b|^ok\b/.test(text)) return "ok";
  return "plain";
}

/** One line of command output: ANSI codes kept for display, stripped for everything else. */
export function lineOf(raw: string, kind?: LineKind): LogLine {
  // A carriage return redraws the line (progress bars): keep what was drawn last.
  const t = raw.includes("\r")
    ? (raw
        .split("\r")
        .filter((x) => x.length)
        .pop() ?? "")
    : raw;
  const text = hasAnsi(t) ? stripAnsi(t) : t;
  return {
    text,
    ...(text !== t ? { raw: t } : {}),
    kind:
      kind ??
      (text.startsWith("[earlier error lines]") || text === "[...]" ? "dim" : classify(text)),
  };
}

/** Command output as log lines, without leading/trailing blank lines or long blank runs. */
export function outputLines(text: string): LogLine[] {
  const lines = text.split("\n").map((t) => lineOf(t));
  while (lines.length && !lines[0]?.text.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.text.trim()) lines.pop();
  return lines.filter((l, i) => l.text.trim() || lines[i - 1]?.text.trim());
}

function offset(startIso: string, at: string) {
  const s = Math.max(0, Math.round((Date.parse(at) - Date.parse(startIso)) / 1000));
  return `+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

interface Check {
  name: string;
  command: string;
  exit_code: number;
  passed: boolean;
  duration_ms: number;
  timed_out: boolean;
  output_tail: string;
}

function checkStep(prefix: string, c: Check, id: string, preexisting = false): LogStep {
  const lines: LogLine[] = [
    { text: `$ ${c.command}`, kind: "cmd" },
    ...outputLines(c.output_tail || "(no output)"),
  ];
  lines.push(
    c.timed_out
      ? { text: `Timed out after ${dur(c.duration_ms)}.`, kind: "err" }
      : c.passed
        ? { text: `Exited with code 0 in ${dur(c.duration_ms)}.`, kind: "ok" }
        : {
            text: `Process completed with exit code ${c.exit_code}.`,
            kind: preexisting ? "warn" : "err",
          },
  );
  if (preexisting && !c.passed)
    lines.push({
      text:
        prefix === "Before"
          ? "This check already fails before the upgrade, so it is not counted against it."
          : "This check failed before the upgrade too, so it is not counted against it.",
      kind: "dim",
    });
  return {
    id,
    name: `${prefix} · ${c.name}`,
    status: c.passed ? "ok" : preexisting ? "warn" : "fail",
    ms: c.duration_ms,
    lines,
  };
}

/** Steps of a run, in the order they happened. */
export function buildSteps(job: Job): LogStep[] {
  const steps: LogStep[] = [];
  const start = job.created_at as string;
  const roleMs = (role: string) =>
    ((job.usage ?? []) as { role: string; duration_ms: number }[])
      .filter((u) => u.role === role)
      .reduce((n, u) => n + u.duration_ms, 0);

  steps.push({
    id: "setup",
    name: "Set up job",
    status: "ok",
    lines: [
      { text: `Run ${job.id}`, kind: "head" },
      {
        text: `Package     ${job.input.packageName} ${job.from ?? "?"} → ${job.input.to} (${job.input.ecosystem ?? "npm"})`,
      },
      {
        text: `Repository  ${job.input.repo}${job.input.ref ? ` @ ${job.input.ref}` : ""}${job.input.dir ? ` (dir ${job.input.dir})` : ""}`,
      },
      { text: `Model       ${job.provider}${job.model ? ` · ${job.model}` : ""}` },
      {
        text: `Prompts     ${Object.entries(job.prompt_versions ?? {})
          .map(([k, v]) => `${k}@${v}`)
          .join("  ")}`,
        kind: "dim",
      },
      { text: `Started     ${start}`, kind: "dim" },
    ],
  });

  if (job.gate) {
    const g = job.gate as { allowed: boolean; reasons: string[]; ageDays?: number | null };
    steps.push({
      id: "gate",
      name: "Release gate",
      status: g.allowed ? "ok" : "fail",
      lines: [
        ...(typeof g.ageDays === "number"
          ? [{ text: `Published ${g.ageDays.toFixed(1)} days ago.` }]
          : []),
        ...(g.allowed
          ? [
              {
                text: "Not yanked, not deprecated, not listed as malicious (OSV).",
                kind: "ok" as const,
              },
            ]
          : g.reasons.map((r) => ({ text: r, kind: "err" as const }))),
      ],
    });
  }

  const cr = job.change_record;
  if (cr) {
    steps.push({
      id: "changelog",
      name: "Read the changelog",
      status: "ok",
      ms: roleMs("extractor") || undefined,
      lines: [
        { text: "Sources", kind: "head" },
        ...((cr.sources ?? []) as { kind: string; url: string }[]).map((s) => ({
          text: `  ${s.kind.padEnd(16)} ${s.url}`,
          kind: "dim" as const,
        })),
        {
          text: `Found ${cr.changes.length} breaking change${cr.changes.length === 1 ? "" : "s"}`,
          kind: "head",
        },
        ...(
          (cr.changes ?? []) as {
            id: string;
            kind: string;
            symbols: string[];
            confidence: string;
            instruction: string;
          }[]
        ).flatMap((c) => [
          {
            text: `  ${c.id}  ${c.kind.padEnd(20)} ${c.symbols.join(", ")}  (${c.confidence})`,
            kind: "warn" as const,
          },
          { text: c.instruction, kind: "dim" as const, indent: 6 },
        ]),
      ],
    });
  }

  const im = job.impact;
  if (im) {
    steps.push({
      id: "impact",
      name: "Find affected code",
      status: "ok",
      lines: [
        {
          text: `${im.items.length} place${im.items.length === 1 ? "" : "s"} in ${im.files_importing_package?.length ?? 0} importing file(s) · class ${im.upgrade_class}`,
          kind: "head",
        },
        ...(
          (im.items ?? []) as { file: string; line: number; change_id: string; snippet: string }[]
        ).map((it) => ({
          text: `  ${it.file}:${it.line}  [${it.change_id}]  ${it.snippet.trim()}`,
        })),
        ...(im.reason ? [{ text: im.reason, kind: "dim" as const }] : []),
      ],
    });
  }

  const base = (job.baseline ?? []) as Check[];
  for (const c of base) steps.push(checkStep("Before", c, `before-${c.name}`, true));

  const bumpNotes = ((job.notes ?? []) as string[]).filter((n) =>
    /Upgraded together|Workspace members|transitive|Lockfile now|lockfile could only|is declared in|npm could not|peer dependency|legacy-peer-deps|Fetched git dependencies|recompile|pins hashes/i.test(
      n,
    ),
  );
  if (job.after_bump || bumpNotes.length) {
    steps.push({
      id: "bump",
      name: "Apply the bump",
      status: job.after_bump ? "ok" : "fail",
      lines: [
        { text: `${job.input.packageName} ${job.from ?? "?"} → ${job.input.to}`, kind: "head" },
        ...bumpNotes.map((n) => ({ text: n })),
      ],
    });
  }

  const preFailing = new Set(base.filter((c) => !c.passed).map((c) => c.name));
  for (const c of (job.after_bump ?? []) as Check[])
    steps.push(checkStep("After", c, `after-${c.name}`, preFailing.has(c.name)));

  const rounds = (job.rounds ?? []) as {
    round: number;
    stop: string;
    error?: string;
    summary: string;
    checks: Check[];
  }[];
  const tools = (job.tool_log ?? []) as {
    tool: string;
    input: Record<string, unknown>;
    ok: boolean;
    summary: string;
    at: string;
  }[];
  if (rounds.length) {
    const lines: LogLine[] = [];
    if (tools.length)
      lines.push({
        text: `${tools.length} tool call${tools.length === 1 ? "" : "s"}`,
        kind: "head",
      });
    for (const t of tools) {
      const arg = String(t.input?.path ?? t.input?.text ?? t.input?.name ?? t.input?.check ?? "");
      lines.push({
        text: `${t.tool.padEnd(12)} ${arg}`,
        kind: t.ok ? "tool" : "err",
        at: offset(start, t.at),
      });
      const first = (t.summary ?? "").split("\n").find((x) => x.trim());
      if (first)
        lines.push({ text: first.trim().slice(0, 240), kind: "dim", indent: 13, under: true });
    }
    for (const r of rounds) {
      lines.push({ text: "", kind: "plain" });
      lines.push({
        text: `Round ${r.round}: ${r.stop}${r.error ? ` (${r.error})` : ""}`,
        kind: r.stop === "completed" ? "head" : "warn",
      });
      for (const s of (r.summary ?? "").split("\n")) lines.push({ text: s, kind: "plain" });
      for (const c of r.checks ?? [])
        lines.push({
          text: `  ${c.passed ? "✓" : "✗"} ${c.name.padEnd(10)} ${dur(c.duration_ms)}`,
          kind: c.passed ? "ok" : preFailing.has(c.name) ? "warn" : "err",
        });
    }
    const last = rounds[rounds.length - 1];
    steps.push({
      id: "fix",
      name: rounds.length === 1 ? "Fix what broke" : `Fix what broke (${rounds.length} rounds)`,
      status:
        last?.stop === "completed"
          ? job.verdict?.passed
            ? "ok"
            : "warn"
          : last?.stop === "refusal" || last?.stop === "error"
            ? "fail"
            : "warn",
      ms: roleMs("fixer") || undefined,
      lines,
    });
  }

  if (job.review || (job.rules ?? []).length) {
    const lines: LogLine[] = [];
    for (const r of (job.rules ?? []) as {
      rule: string;
      severity: string;
      file: string | null;
      detail: string;
    }[])
      lines.push({
        text: `rule ${r.severity.padEnd(5)} ${r.rule}${r.file ? ` ${r.file}` : ""}: ${r.detail}`,
        kind: r.severity === "block" ? "err" : r.severity === "warn" ? "warn" : "dim",
      });
    if (job.review) {
      lines.push({
        text: `Verdict: ${job.review.verdict}`,
        kind: job.review.verdict === "approve" ? "ok" : "warn",
      });
      for (const c of (job.review.criteria ?? []) as {
        id: string;
        pass: boolean;
        reason: string;
      }[])
        lines.push({
          text: `  ${c.pass ? "✓" : "✗"} ${c.id.replace(/_/g, " ")}: ${c.reason}`,
          kind: c.pass ? "plain" : "err",
        });
    }
    steps.push({
      id: "review",
      name: "Independent review",
      status: (job.rules ?? []).some((r: { severity: string }) => r.severity === "block")
        ? "fail"
        : !job.review
          ? "skip"
          : job.review.verdict === "approve"
            ? "ok"
            : "warn",
      ms: roleMs("reviewer") || undefined,
      lines,
    });
  }

  const good = job.state === "ready" || job.state === "safe";
  steps.push({
    id: "result",
    name: "Result",
    status: good
      ? "ok"
      : job.state === "needs_human" || job.state === "waiting_release_age"
        ? "warn"
        : "fail",
    ms: job.duration_ms,
    lines: [
      {
        text: `${job.state}${job.confidence ? ` · ${job.confidence} confidence` : ""} · $${(job.cost_usd ?? 0).toFixed(3)} · ${dur(job.duration_ms ?? 0)}`,
        kind: good ? "ok" : "warn",
      },
      ...(job.error ? [{ text: job.error, kind: "err" as const }] : []),
      ...((job.notes ?? []) as string[]).map((n) => ({
        text: n,
        kind: (/fail|not verified|unsupported|could not|stopped|blocked|malicious|timed out|longer than/i.test(
          n,
        )
          ? "warn"
          : "plain") as LineKind,
      })),
    ],
  });
  // Multi-line messages (errors, notes, summaries) become one numbered line each.
  for (const st of steps)
    st.lines = st.lines.flatMap((l) =>
      l.text.includes("\n")
        ? l.text.split("\n").map((t, i) => ({
            ...l,
            text: t,
            raw: undefined,
            at: i ? undefined : l.at,
            under: i ? Boolean(l.at || l.under) : l.under,
          }))
        : [l],
    );
  return steps;
}

/** Lines with numbers, for steps, check output and the live run. */
export function logLines(lines: LogLine[], query = "", from = 1): string {
  const q = query.toLowerCase();
  return lines
    .map((l, i) => {
      let html = l.raw ? ansiHtml(l.raw) : esc(l.text);
      if (q && l.text.toLowerCase().includes(q)) {
        const hay = l.text.toLowerCase();
        const at: number[] = [];
        for (let p = hay.indexOf(q); p !== -1; p = hay.indexOf(q, p + q.length)) at.push(p);
        for (const p of at.reverse()) html = markRange(html, p, p + q.length, "mark");
      }
      const time = l.at
        ? `<span class="lat">${esc(l.at)}</span>`
        : l.under
          ? `<span class="lat-pad"></span>`
          : "";
      const pad = l.indent
        ? ` style="padding-left:${Math.min(40, Math.max(0, Math.round(l.indent)))}ch"`
        : "";
      return `<div class="ll ${l.kind ?? "plain"}"><span class="lnum" data-n="${from + i}"></span>${time}<span class="ltx"${pad}>${html || " "}</span></div>`;
    })
    .join("");
}

const STATUS_ICON: Record<LogStep["status"], string> = {
  ok: "checkCircleFill",
  fail: "xCircleFill",
  warn: "alertCircleFill",
  skip: "skipCircle",
};

/** The whole job log: header with search and actions, then the steps. */
export function jobLog(
  steps: LogStep[],
  opts: { open: Set<string>; query: string; title: string },
) {
  const q = opts.query.trim().toLowerCase();
  const matches = (s: LogStep) =>
    q ? s.lines.filter((l) => l.text.toLowerCase().includes(q)).length : 0;
  const total = steps.reduce((n, s) => n + matches(s), 0);
  const result = steps.find((s) => s.id === "result") ?? steps[steps.length - 1];
  const st = result?.status ?? "ok";
  const failed = steps.filter((s) => s.status === "fail").length;
  const warned = steps.filter((s) => s.status === "warn").length;
  const parts = [
    `${steps.length} steps`,
    failed ? `${failed} failed` : "",
    warned ? `${warned} with warnings` : "",
    result?.ms ? dur(result.ms) : "",
  ];
  return `<div class="jl">
    <div class="jl-h">
      <span class="jl-st ${st}">${icon(STATUS_ICON[st])}</span>
      <div><div class="jl-t">${esc(opts.title)}</div><div class="jl-s">${parts.filter(Boolean).join(" · ")}</div></div>
      <div class="grow"></div>
      <label class="jl-search">${icon("search")}<input id="log-q" placeholder="Search logs" value="${esc(opts.query)}" spellcheck="false" />${q ? `<span class="jl-count">${total} match${total === 1 ? "" : "es"}</span>` : ""}</label>
      <button class="btn icon ghost jl-btn" data-act="log-all" data-v="open" title="Expand all steps">${icon("unfold")}</button>
      <button class="btn icon ghost jl-btn" data-act="log-all" data-v="close" title="Collapse all steps">${icon("fold")}</button>
      <button class="btn icon ghost jl-btn" data-act="log-download" title="Download log">${icon("download")}</button>
    </div>
    <div class="jl-b">${steps
      .map((s) => {
        const open = opts.open.has(s.id) || (q !== "" && matches(s) > 0);
        return `<div class="js ${open ? "open" : ""}" id="step-${esc(s.id)}">
        <button class="js-h" data-act="log-step" data-v="${esc(s.id)}" aria-expanded="${open}">
          ${icon(open ? "chevronDown" : "chevronRight", "js-chev")}<span class="js-i ${s.status}">${icon(STATUS_ICON[s.status])}</span>
          <span class="js-n">${esc(s.name)}</span>${q && matches(s) ? `<span class="jl-count">${matches(s)}</span>` : ""}<span class="js-d">${s.ms ? dur(s.ms) : ""}</span>
        </button>
        ${open ? `<div class="js-b">${logLines(s.lines, opts.query)}</div>` : ""}
      </div>`;
      })
      .join("")}</div>
  </div>`;
}

/** Plain text of the log, for download. */
export function logText(steps: LogStep[]) {
  return steps
    .map(
      (s) =>
        `##[group]${s.name}${s.ms ? ` (${dur(s.ms)})` : ""} [${s.status}]\n${s.lines.map((l) => `${l.at ? `${l.at} ` : l.under ? "       " : ""}${" ".repeat(l.indent ?? 0)}${l.text}`).join("\n")}\n##[endgroup]`,
    )
    .join("\n");
}
