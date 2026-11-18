// Bumpsmith Local dashboard. Design notes: dashboard/DESIGN.md.

import {
  type FileDiff,
  type FileView,
  fileCard,
  fileTree,
  parsePatch,
  snippetDiff,
  whoOf,
} from "./diff.ts";
import { buildSteps, jobLog, type LogStep, lineOf, logLines, logText, outputLines } from "./log.ts";
import { renderMarkdown } from "./markdown.ts";
import {
  ago,
  agoLong,
  BRAND_WORDMARK,
  checkStrip,
  confPill,
  dur,
  ecoBadge,
  esc,
  icon,
  md,
  median,
  money,
  type Run,
  stateOf,
  statePill,
  status,
  ticks,
  versions,
} from "./ui.ts";

// ───────────── data ─────────────

interface DebtItem {
  package: string;
  current: string | null;
  latest: string | null;
  majorsBehind: number;
  latestPublishedAt: string | null;
  latestEligible: boolean;
}
interface LiveRun {
  id: string;
  package: string;
  version: string;
  provider: string;
  started_at: string;
  lines: string[];
  stage: string;
  reached?: string;
  jobId: string | null;
  done: boolean;
  exitCode: number | null;
}
interface State {
  repo: {
    name: string;
    path: string;
    branch: string | null;
    commit: string | null;
    changes: number | null;
    user: string | null;
    remote: string | null;
    ecosystem: string | null;
    packageManager: string | null;
    dependencies: Record<string, string>;
  };
  env: {
    docker: string | null;
    providers: { id: string; label: string; detail: string; ok: boolean }[];
    defaultProvider: string;
  };
  runsDir: string;
  runs: Run[];
  debt: {
    generatedAt: string;
    directDependencies: number;
    behind: DebtItem[];
    packageManager: string;
  } | null;
  live: LiveRun[];
}
// biome-ignore lint/suspicious/noExplicitAny: job.json is rendered defensively
type Job = any;

const TOKEN =
  document.querySelector<HTMLMetaElement>('meta[name="bumpsmith-token"]')?.content ?? "";
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      "x-bumpsmith-token": TOKEN,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

type Tab = "summary" | "changes" | "checks" | "breaking" | "log" | "report";
const ui = {
  data: null as State | null,
  route: "",
  filter: "all",
  query: "",
  detail: null as { id: string; job: Job; patch: string; evidence: string } | null,
  tab: "summary" as Tab,
  /** Files changed: per-file view state, layout, tree filter, active file. */
  files: [] as FileDiff[],
  views: new Map<number, FileView>(),
  split: false,
  wrap: false,
  treeFilter: "",
  activeFile: 0,
  steps: [] as LogStep[],
  logOpen: new Set<string>(),
  logQuery: "",
  reportMode: "preview" as "preview" | "code",
  openCheck: null as string | null,
  drawer: null as null | {
    mode: "new" | "live";
    pkg: string;
    version: string;
    provider: string;
    budget: number;
    liveId?: string;
    /** The version was filled in automatically (cleared when the package changes). */
    auto?: boolean;
  },
  live: new Map<string, LiveRun>(),
  palette: false,
  palQuery: "",
  palIndex: 0,
  busy: new Set<string>(),
  latest: {} as Record<string, string | null>,
};
const $app = document.getElementById("app") as HTMLElement;

// ───────────── helpers ─────────────

const isGood = (r: Run) => r.state === "ready" || r.state === "safe";
const verified = (r: Run) =>
  r.checks.some((c) => c.name !== "install" && (c.after === true || c.sameFailures));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function diffstat(r: { files: number; lines: number }) {
  return r.files
    ? `<span class="diffstat">${plural(r.files, "file")} <span class="faint">·</span> ${r.lines} lines</span>`
    : `<span class="faint">—</span>`;
}

function toast(msg: string, bad = false) {
  let wrap = document.querySelector(".toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toasts";
    document.body.append(wrap);
  }
  const t = document.createElement("div");
  t.className = `toast ${bad ? "bad" : ""}`;
  t.innerHTML = `${icon(bad ? "alertCircle" : "checkCircle")}<span>${esc(msg)}</span>`;
  wrap.append(t);
  setTimeout(() => {
    t.style.transition = "opacity 240ms";
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 260);
  }, 3600);
}

// Theme: system by default; the toggle stores an explicit choice.
function theme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
try {
  ui.split = localStorage.getItem("bumpsmith-diff") === "split";
} catch {
  // default: unified
}
try {
  const saved = localStorage.getItem("bumpsmith-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
  // storage unavailable: follow the system
}

// ───────────── shell ─────────────

function sidebar(d: State) {
  const r = d.repo;
  const ready = d.runs.filter((x) => x.state === "ready").length;
  const route = ui.route.split("/")[0] || "overview";
  const live = [...ui.live.values()].filter((l) => !l.done).length;
  const behind = d.debt?.behind.filter((b) => b.majorsBehind > 0).length;
  const link = (id: string, label: string, ic: string, n = "", hot = false) =>
    `<a href="#/${id === "overview" ? "" : id}" class="${route === id ? "on" : ""}">${icon(ic)}<span>${label}</span>${n ? `<span class="n ${hot ? "hot" : ""}">${n}</span>` : ""}</a>`;
  const prov = d.env.providers.find((p) => p.id === d.env.defaultProvider);
  return `<aside class="sidebar">
    <div class="brand">${BRAND_WORDMARK}<span class="brand-tag">local</span></div>
    <div class="ctx" title="${esc(r.path)}">
      <div class="ctx-av">${esc(r.name.slice(0, 2).toUpperCase())}</div>
      <div style="min-width:0"><div class="ctx-name">${esc(r.name)}</div>
        <div class="ctx-sub">${icon("branch")}${esc(r.branch ?? "no git")}${r.commit ? ` · ${esc(r.commit)}` : ""}</div></div>
      ${icon("chevron")}
    </div>
    <div class="sep"></div>
    <nav class="nav">
      ${link("overview", "Overview", "grid")}
      ${link("runs", "Upgrades", "layers", live ? `${live} live` : ready ? String(ready) : "", !!(live || ready))}
      ${link("deps", "Dependencies", "package", behind ? String(behind) : "")}
    </nav>
    <div class="sep"></div>
    <nav class="nav">
      <div class="nav-h">Repository</div>
      ${link("safety", "Safety", "shield")}
      ${link("sandbox", "Sandbox & models", "cpu")}
    </nav>
    <div class="side-foot">
      <div class="sep"></div>
      <div class="env">
        <div class="env-row"><span class="dot ${d.env.docker ? "ok" : "bad"}"></span><b>Sandbox</b>${d.env.docker ? `Docker ${esc(d.env.docker)}` : "Docker not running"}</div>
        <div class="env-row"><span class="dot ${prov?.ok ? "ok" : "warn"}"></span><b>Model</b>${esc(prov?.label ?? d.env.defaultProvider)}</div>
        <div class="env-row"><span class="dot ${r.changes ? "warn" : "ok"}"></span><b>Tree</b>${r.changes === null ? "no git" : r.changes ? `${r.changes} uncommitted` : "clean"}</div>
      </div>
    </div>
  </aside>`;
}

function topbar(crumbs: string[]) {
  return `<header class="topbar">
    <a class="top-brand" href="#/" aria-label="Overview">${BRAND_WORDMARK}</a>
    <div class="crumbs">${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<b>${esc(c)}</b>` : `<span>${esc(c)}</span><span class="s">/</span>`)).join("")}</div>
    <div class="grow"></div>
    <div class="search" data-act="palette">${icon("search")}<span>Search upgrades and packages</span><kbd>⌘K</kbd></div>
    <button class="btn icon" data-act="theme" title="Switch theme">${icon(theme() === "dark" ? "sun" : "moon")}</button>
    <button class="btn primary" data-act="new">${icon("plus")}<span class="hide-sm">New upgrade</span></button>
  </header>`;
}

// ───────────── overview ─────────────

function overview(d: State) {
  const runs = d.runs;
  const live = [...ui.live.values()].filter((l) => !l.done);
  if (!runs.length && !live.length) return emptyOverview(d);
  const ready = runs.filter((r) => r.state === "ready");
  const human = runs.filter((r) => r.state === "needs_human" || r.state === "waiting_release_age");
  const blocked = runs.filter((r) => r.state === "blocked_policy");
  const ver = runs.filter(verified).length;
  const month = new Date();
  const monthRuns = runs.filter((r) => {
    const t = new Date(r.created_at);
    return t.getMonth() === month.getMonth() && t.getFullYear() === month.getFullYear();
  });
  const spend = monthRuns.reduce((n, r) => n + r.cost_usd, 0);
  const monthReady = monthRuns.filter((r) => r.state === "ready").length;
  const goodTimes = runs.filter(isGood).map((r) => r.duration_ms);
  const sortedTimes = [...goodTimes].sort((a, b) => a - b);
  const p90 = sortedTimes[Math.floor(sortedTimes.length * 0.9)] ?? 0;
  const last = runs[0];
  return `<div class="page">
    <div class="ph">
      <div><h1>Overview</h1>
        <p><span><span class="dot ok"></span>${ready.length} ready to apply</span><span><span class="dot warn"></span>${human.length} need a human</span><span><span class="dot bad"></span>${blocked.length} blocked</span>${last ? `<span class="faint">Last run ${agoLong(last.created_at)}</span>` : ""}</p></div>
      <div class="act"><button class="btn" data-act="scan" ${ui.busy.has("scan") ? "disabled" : ""}>${icon("scan")}${ui.busy.has("scan") ? "Scanning…" : "Scan dependencies"}</button></div>
    </div>
    ${liveRows(live)}
    <div class="grid g4">
      ${stat("check", "Ready to apply", String(ready.length), `of ${runs.length}`, ticks(ready.length, runs.length), "Verified in the sandbox and approved by review")}
      ${stat("shield", "Verified", `${runs.length ? Math.round((ver / runs.length) * 100) : 0}%`, `${ver} runs`, ticks(ver, runs.length, "ink"), "A build, typecheck or test passed after the bump")}
      ${stat("dollar", "Model spend", money(spend), month.toLocaleDateString(undefined, { month: "short" }), spendSplit(monthRuns), monthReady ? `${money(spend / monthReady)} per ready upgrade · API-equivalent` : "API-equivalent; subscriptions are not billed per run")}
      ${stat("clock", "Time to green", goodTimes.length ? dur(median(goodTimes)) : "—", "median", "", goodTimes.length ? `p90 ${dur(p90)} · from start to a verified result` : "No verified results yet")}
    </div>
    <div class="grid g-2-1 mt">
      ${readyQueue(ready)}
      ${activity(runs)}
    </div>
    <div class="mt">${runsTable(runs.slice(0, 8), "Recent runs", `<a class="btn" href="#/runs">View all</a>`)}</div>
  </div>`;
}

/** Spend split by pipeline stage, as one segmented bar with a legend. */
function spendSplit(runs: Run[]) {
  const roles: [string, string, string][] = [
    ["extractor", "Changelog", "color-mix(in srgb, var(--accent) 40%, var(--inset))"],
    ["fixer", "Fixer", "var(--accent)"],
    ["reviewer", "Review", "var(--text-2)"],
  ];
  const sums = roles.map(([k]) => runs.reduce((n, r) => n + (r.cost_by_role[k] ?? 0), 0));
  const total = sums.reduce((a, b) => a + b, 0);
  if (!total)
    return `<div class="split"><i style="flex:1;background:var(--inset);box-shadow:inset 0 0 0 1px var(--line)"></i></div>`;
  return `<div class="split">${roles.map(([, label, c], i) => `<i style="flex:${sums[i]};background:${c}" data-hint="${label} ${money(sums[i] ?? 0)}"></i>`).join("")}</div>
    <div class="split-l">${roles.map(([, label, c], i) => `<span><i style="background:${c}"></i>${label} ${money(sums[i] ?? 0, 0)}</span>`).join("")}</div>`;
}

function stat(ic: string, label: string, value: string, unit: string, meter: string, foot: string) {
  return `<div class="panel stat"><div class="stat-l">${icon(ic)}${label}</div>
    <div class="stat-v"><b>${value}</b><span>${esc(unit)}</span></div>${meter}<div class="stat-f">${esc(foot)}</div></div>`;
}

function readyQueue(ready: Run[]) {
  const rows = ready.slice(0, 6);
  return `<div class="panel">
    <div class="panel-h"><h2>Ready to apply</h2><span class="cnt">${ready.length}</span><div class="r"><a class="btn ghost" href="#/runs" data-act="filter-ready">See all</a></div></div>
    ${
      rows.length
        ? rows
            .map(
              (r) => `<div class="queue-i" data-act="open-run" data-id="${esc(r.id)}">
        <div style="min-width:0"><div class="queue-t"><span class="pkg"><b>${esc(r.package)}</b></span>${versions(r.from, r.to)}${ecoBadge(r.ecosystem)}</div>
          <div class="queue-s">${checkStrip(r.checks)}<span>${r.edited_by_agent ? `${plural(r.edited_by_agent, "file")} fixed by the agent` : "version bump only"}</span><span class="faint">${ago(r.created_at)} ago</span></div></div>
        ${confPill(r.confidence)}
        <div class="queue-a"><a class="btn" href="#/runs/${esc(r.id)}">Review</a><button class="btn primary" data-act="apply" data-id="${esc(r.id)}">${icon("apply")}Apply</button></div>
      </div>`,
            )
            .join("")
        : `<div class="empty-s"><b>Nothing waiting</b>Verified upgrades land here, ready to apply to your working tree.</div>`
    }
  </div>`;
}

function activity(runs: Run[]) {
  const weeks = 17;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks - 1) * 7 - today.getDay());
  const counts = new Map<string, number>();
  for (const r of runs) {
    const k = new Date(r.created_at).toDateString();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const max = Math.max(1, ...counts.values());
  const cells: string[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    if (day > today) {
      cells.push(`<i style="visibility:hidden"></i>`);
      continue;
    }
    const n = counts.get(day.toDateString()) ?? 0;
    const lvl = n === 0 ? "" : `l${Math.min(4, Math.ceil((n / max) * 4))}`;
    cells.push(
      `<i class="${lvl}" data-hint="${esc(`${plural(n, "upgrade")} on ${day.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`)}"></i>`,
    );
  }
  const groups: [string, string, number][] = [
    ["Ready or safe", "ok", runs.filter(isGood).length],
    [
      "Needs a human",
      "warn",
      runs.filter((r) => r.state === "needs_human" || r.state === "waiting_release_age").length,
    ],
    ["Blocked", "bad", runs.filter((r) => r.state === "blocked_policy").length],
    ["Could not run", "", runs.filter((r) => r.state === "failed_infra").length],
  ];
  const total = Math.max(runs.length, 1);
  return `<div class="panel">
    <div class="panel-h"><h2>Activity</h2><span class="sub">last ${weeks} weeks</span></div>
    <div class="panel-b">
      <div class="contrib-wrap"><div class="contrib-d"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
      <div class="contrib">${cells.join("")}</div></div>
      <div class="legend">Less<i style="background:var(--inset);box-shadow:inset 0 0 0 1px var(--line)"></i><i style="background:color-mix(in srgb,var(--accent) 25%,var(--inset))"></i><i style="background:color-mix(in srgb,var(--accent) 50%,var(--inset))"></i><i style="background:color-mix(in srgb,var(--accent) 75%,var(--inset))"></i><i style="background:var(--accent)"></i>More</div>
      <div class="oc">${groups
        .map(
          ([label, tone, n]) =>
            `<div class="oc-r"><span><span class="dot ${tone}"></span>${label}</span><div class="bar"><i style="width:${(n / total) * 100}%;background:${tone ? `var(--${tone})` : "var(--faint)"}"></i></div><span class="v">${n}</span></div>`,
        )
        .join("")}</div>
    </div>
  </div>`;
}

function runsTable(rows: Run[], title: string, right = "") {
  return `<div class="panel">
    <div class="panel-h"><h2>${title}</h2><span class="cnt">${rows.length}</span><div class="r">${right}</div></div>
    <div class="tw"><table class="t">
      <thead><tr><th>Status</th><th>Package</th><th>Upgrade</th><th>Checks</th><th>Change</th><th class="r">Duration</th><th class="r">Cost</th><th class="r">Started</th></tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr data-act="open-run" data-id="${esc(r.id)}" title="${esc(r.reason ?? "")}">
        <td>${status(r.state)}</td>
        <td><span class="pkg"><b>${esc(r.package)}</b>${ecoBadge(r.ecosystem)}</span></td>
        <td>${versions(r.from, r.to)}</td>
        <td>${checkStrip(r.checks)}</td>
        <td>${diffstat(r)}</td>
        <td class="r mono muted">${dur(r.duration_ms)}</td>
        <td class="r mono">${money(r.cost_usd)}</td>
        <td class="r muted">${ago(r.created_at)} ago</td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </div>`;
}

function liveRows(live: LiveRun[]) {
  if (!live.length) return "";
  return `<div class="panel" style="margin-bottom:16px">${live
    .map(
      (l) => `<div class="queue-i" data-act="open-live" data-id="${l.id}">
      <div style="min-width:0"><div class="queue-t"><span class="dot live"></span><span class="pkg"><b>${esc(l.package)}</b></span><span class="ver"><span class="ar">→</span><b>${esc(l.version)}</b></span></div>
        <div class="queue-s"><span>${esc(STAGES.find((s) => s.id === l.stage)?.label ?? l.stage)}</span><span class="faint mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.lines[l.lines.length - 1] ?? "starting")}</span></div></div>
      <span></span><div class="queue-a"><span class="btn">Watch</span></div></div>`,
    )
    .join("")}</div>`;
}

function emptyOverview(d: State) {
  return `<div class="page"><div class="ph"><div><h1>Overview</h1><p>${esc(d.repo.name)}</p></div></div>
    <div class="panel"><div class="blank">
      <div class="blank-i">${icon("layers")}</div>
      <h3>No upgrades yet</h3>
      <p>Pick a dependency. Bumpsmith upgrades it in a sandbox, fixes what breaks, and proves it with your own checks.</p>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <button class="btn primary" data-act="new">${icon("plus")}New upgrade</button>
        <button class="btn" data-act="scan">${icon("scan")}Scan dependencies</button>
      </div>
      <div><pre>$ bumpsmith fix zod@4.1.0</pre></div>
    </div></div></div>`;
}

// ───────────── upgrades list ─────────────

function runsPage(d: State) {
  const groups: [string, string, (r: Run) => boolean][] = [
    ["all", "All", () => true],
    ["ready", "Ready", (r) => r.state === "ready"],
    ["safe", "Safe", (r) => r.state === "safe"],
    [
      "human",
      "Needs a human",
      (r) => r.state === "needs_human" || r.state === "waiting_release_age",
    ],
    ["blocked", "Blocked", (r) => r.state === "blocked_policy"],
    ["failed", "Could not run", (r) => r.state === "failed_infra"],
  ];
  const f = groups.find((g) => g[0] === ui.filter)?.[2] ?? (() => true);
  const q = ui.query.toLowerCase();
  const rows = d.runs.filter(
    (r) => f(r) && (!q || r.package.toLowerCase().includes(q) || r.to.includes(q)),
  );
  return `<div class="page">
    <div class="ph"><div><h1>Upgrades</h1><p><span class="mono faint" style="font-size:12px">${esc(d.runsDir.replace(d.repo.path, "."))}</span></p></div></div>
    ${liveRows([...ui.live.values()].filter((l) => !l.done))}
    <div class="toolbar">
      <div class="seg">${groups.map(([id, label, fn]) => `<button class="${ui.filter === id ? "on" : ""}" data-act="filter" data-v="${id}">${label}<span>${d.runs.filter(fn).length}</span></button>`).join("")}</div>
      <div class="grow"></div>
      <input class="input" id="q" placeholder="Filter by package or version" value="${esc(ui.query)}" style="width:240px" />
    </div>
    ${rows.length ? runsTable(rows, "Runs") : `<div class="panel"><div class="blank"><h3>No runs match</h3><p>Try another filter.</p></div></div>`}
  </div>`;
}

// ───────────── run page ─────────────

function pipeline(job: Job) {
  const s: { t: string; sub: string; st: string; r?: string; log?: string }[] = [];
  const cr = job.change_record;
  s.push({
    log: "changelog",
    t: "Read the changelog",
    st: cr ? "done" : job.gate && !job.gate.allowed ? "fail" : "pending",
    sub: cr
      ? `${plural(cr.changes.length, "breaking change")} from ${plural(cr.sources?.length ?? 0, "source")}`
      : job.gate && !job.gate.allowed
        ? (job.gate.reasons?.[0] ?? "stopped at the release gate")
        : "not reached",
  });
  const im = job.impact;
  s.push({
    log: "impact",
    t: "Find affected code",
    st: im ? "done" : "pending",
    sub: im
      ? `${plural(im.items.length, "place")} in your code · ${im.upgrade_class}`
      : "not reached",
  });
  const base = job.baseline as { name: string; passed: boolean; duration_ms: number }[] | undefined;
  s.push({
    log: base?.[0] ? `before-${base[0].name}` : undefined,
    t: "Run your checks before",
    // A red baseline is the repository's own state before the upgrade: a warning, as in the log.
    st: base ? (base.every((c) => c.passed) ? "done" : "warn") : "pending",
    sub: base
      ? `${base.filter((c) => c.passed).length} of ${base.length} pass${base.find((c) => c.name === "install" && !c.passed) ? " · install fails, so checks are limited" : base.some((c) => !c.passed) ? " · failures here are not counted" : ""}`
      : "not reached",
    r: base ? dur(base.reduce((n, c) => n + c.duration_ms, 0)) : "",
  });
  s.push({
    log: "bump",
    t: "Apply the bump",
    st: job.after_bump ? "done" : base ? "fail" : "pending",
    sub: job.after_bump
      ? `${job.from ?? "?"} → ${job.input.to}`
      : base
        ? "could not apply"
        : "not reached",
  });
  const rounds = job.rounds?.length ?? 0;
  s.push({
    log: "fix",
    t: "Fix what broke",
    st: job.after_bump ? "done" : "pending",
    sub: job.after_bump
      ? rounds
        ? `${plural(rounds, "round")} · ${plural(job.edits?.length ?? 0, "file")} edited`
        : "no code change needed"
      : "not reached",
  });
  s.push({
    log: "review",
    t: "Independent review",
    st: job.review ? (job.review.verdict === "approve" ? "done" : "warn") : "pending",
    sub: job.review
      ? job.review.verdict === "approve"
        ? "approved"
        : "changes requested"
      : "not reviewed",
  });
  const tone = stateOf(job.state).tone;
  s.push({
    log: "result",
    t: stateOf(job.state).label,
    st: tone === "ok" ? "done" : tone === "bad" ? "fail" : "warn",
    sub: "result",
  });
  return `<div class="steps">${s
    .map(
      (
        x,
      ) => `<div class="step ${x.st} ${x.log && x.st !== "pending" ? "link" : ""}" ${x.log && x.st !== "pending" ? `data-act="goto-log" data-v="${esc(x.log)}" title="Open in the log"` : ""}><div class="step-i">${icon(x.st === "done" ? "check" : x.st === "fail" ? "x" : x.st === "warn" ? "minus" : "clock")}</div>
      <div><div class="step-t">${esc(x.t)}</div><div class="step-s">${md(x.sub)}</div></div><div class="step-r">${x.r ?? ""}${x.log && x.st !== "pending" ? icon("chevronRight", "step-go") : ""}</div></div>`,
    )
    .join("")}</div>`;
}

function detailPage(d: State) {
  const det = ui.detail;
  if (!det)
    return `<div class="page"><div class="skel" style="height:96px;margin-bottom:16px"></div><div class="skel" style="height:480px"></div></div>`;
  const { job, patch } = det;
  const run = d.runs.find((r) => r.id === det.id);
  const files = ui.files;
  const edited = new Set<string>((job.edits ?? []).map((e: { path: string }) => e.path));
  const cmp = (job.verdict?.comparisons ?? []) as Cmp[];
  const changes = (job.change_record?.changes ?? []) as Change[];
  const canApply = job.state === "ready" && patch.trim().length > 0;
  const tabs: [Tab, string, string][] = [
    ["summary", "Summary", ""],
    ["changes", "Files changed", String(files.length)],
    ["checks", "Checks", String(cmp.length || (job.baseline?.length ?? 0))],
    ["breaking", "Breaking changes", String(changes.length)],
    ["log", "Log", ""],
    ["report", "Report", ""],
  ];
  return `<div class="page wide">
    <a class="back" href="#/runs">${icon("arrowL")}Upgrades</a>
    <div class="rh">
      <div style="min-width:0">
        <h1>${status(job.state, "")}<span>Upgrade</span><code>${esc(job.input.packageName)}</code>${versions(job.from ?? job.input.from ?? null, job.input.to)}</h1>
        <div class="rmeta">${statePill(job.state)}${confPill(job.confidence ?? null)}${ecoBadge(job.input.ecosystem ?? run?.ecosystem ?? "npm")}
          <span class="mono">${esc(det.id)}</span><span>${esc(job.provider)}${job.model ? ` · <span class="mono">${esc(job.model)}</span>` : ""}</span>
          <span>${dur(job.duration_ms ?? 0)}</span><span class="mono">${money(job.cost_usd ?? 0, 3)}</span><span>${agoLong(job.created_at)}</span></div>
      </div>
      <div class="act">
        <button class="btn ghost danger icon" data-act="delete" data-id="${esc(det.id)}" title="Delete this run">${icon("trash")}</button>
        <button class="btn" data-act="copy-patch" ${patch.trim() ? "" : "disabled"}>${icon("copy")}Copy patch</button>
        <button class="btn ${canApply ? "primary" : ""}" data-act="apply" data-id="${esc(det.id)}" ${patch.trim() ? "" : "disabled"} title="${canApply ? "git apply --index, after git apply --check" : "Only verified results apply in one click; copy the patch to use it anyway"}">${icon("apply")}${ui.busy.has(`apply:${det.id}`) ? "Applying…" : "Apply patch"}</button>
      </div>
    </div>
    <div class="tabs">${tabs.map(([id, label, n]) => `<button class="tab ${ui.tab === id ? "on" : ""}" data-act="tab" data-v="${id}">${label}${n && n !== "0" ? `<span class="cnt">${n}</span>` : ""}</button>`).join("")}</div>
    ${
      ui.tab === "changes"
        ? changesTab(files, edited, job)
        : ui.tab === "checks"
          ? checksTab(job, cmp)
          : ui.tab === "breaking"
            ? breakingTab(job, changes)
            : ui.tab === "log"
              ? logTab(det.id)
              : ui.tab === "report"
                ? reportTab(det, d)
                : summaryTab(job, run)
    }
  </div>`;
}

interface Cmp {
  name: string;
  baseline: boolean | null;
  after: boolean | null;
  flaky: boolean;
  regression: boolean;
  sameFailures?: { failing: string[]; passed: number };
  newFailures?: string[];
}
interface Change {
  id: string;
  kind: string;
  symbols: string[];
  instruction: string;
  confidence: string;
  before: string;
  after: string;
  evidence?: { url: string }[];
}

function summaryTab(job: Job, run: Run | undefined) {
  const notes = [
    ...(job.error ? [`Stopped: ${job.error}`] : []),
    ...((job.notes ?? []) as string[]),
  ];
  const usage = (job.usage ?? []) as {
    role: string;
    api_equivalent_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  }[];
  const byRole: Record<string, number> = {};
  let tin = 0;
  let tout = 0;
  for (const u of usage) {
    byRole[u.role] = (byRole[u.role] ?? 0) + u.api_equivalent_usd;
    tin += u.input_tokens + u.cache_read_input_tokens;
    tout += u.output_tokens;
  }
  const maxRole = Math.max(0.0001, ...Object.values(byRole));
  const label = (k: string) =>
    k === "extractor" ? "Changelog" : k === "fixer" ? "Fixer" : k === "reviewer" ? "Review" : k;
  return `<div class="grid g-2-1">
    <div class="grid" style="align-content:start">
      <div class="panel"><div class="panel-h"><h2>Pipeline</h2></div>${pipeline(job)}</div>
      <div class="panel"><div class="panel-h"><h2>What happened</h2>${notes.length ? `<span class="cnt">${notes.length}</span>` : ""}</div>
        <div class="notes">${
          notes.length
            ? notes
                .map((n) => {
                  const warn =
                    /fail|not verified|unsupported|could not|stopped|blocked|malicious|timed out|longer than|conflict/i.test(
                      n,
                    );
                  return `<div class="note ${warn ? "warn" : ""}">${icon(warn ? "alertCircle" : "info")}<div>${md(n)}</div></div>`;
                })
                .join("")
            : `<div class="note">${icon("checkCircle")}<div>Verified in the sandbox with nothing unusual to report.</div></div>`
        }</div></div>
      ${
        job.review
          ? `<div class="panel"><div class="panel-h"><h2>Independent review</h2><div class="r">${job.review.verdict === "approve" ? `<span class="badge ok">approved</span>` : `<span class="badge warn">changes requested</span>`}</div></div>
          ${job.review.summary ? `<div class="review-sum">${md(job.review.summary)}</div>` : ""}
          ${(job.review.criteria ?? []).map((c: { id: string; pass: boolean; reason: string }) => `<div class="crit"><span style="color:${c.pass ? "var(--ok)" : "var(--bad)"}">${icon(c.pass ? "checkCircle" : "xCircle")}</span><div><b>${esc(c.id.replace(/_/g, " "))}</b><p>${md(c.reason)}</p></div></div>`).join("")}</div>`
          : ""
      }
    </div>
    <div class="grid" style="align-content:start">
      <div class="panel"><div class="panel-h"><h2>Details</h2></div><div class="panel-b"><dl class="kv">
        <dt>Package</dt><dd class="mono">${esc(job.input.packageName)}</dd>
        <dt>From</dt><dd class="mono">${esc(job.from ?? "?")}</dd>
        <dt>To</dt><dd class="mono">${esc(job.input.to)}</dd>
        <dt>Directory</dt><dd class="mono">${esc(job.input.dir || ".")}</dd>
        <dt>Upgrade class</dt><dd>${esc(job.impact?.upgrade_class ?? "—")}</dd>
        <dt>Files changed</dt><dd class="mono">${run ? `${run.files} (${run.lines} lines)` : "—"}</dd>
        <dt>Agent edits</dt><dd class="mono">${run ? `${run.edited_by_agent} files · ${run.agent_lines} lines` : "—"}</dd>
        <dt>Fix rounds</dt><dd class="mono">${job.rounds?.length ?? 0}</dd>
        <dt>Duration</dt><dd class="mono">${dur(job.duration_ms ?? 0)}</dd>
        <dt>Tokens</dt><dd class="mono">${tin.toLocaleString()} in · ${tout.toLocaleString()} out</dd>
      </dl></div></div>
      <div class="panel"><div class="panel-h"><h2>Cost</h2><div class="r"><span class="mono">${money(job.cost_usd ?? 0, 3)}</span></div></div><div class="panel-b">
        ${
          Object.entries(byRole)
            .map(
              ([k, v]) =>
                `<div class="costbar"><span>${label(k)}</span><div class="bar"><i style="width:${(v / maxRole) * 100}%"></i></div><span class="v">${money(v, 3)}</span></div>`,
            )
            .join("") || `<span class="muted">No model calls.</span>`
        }
        <div class="stat-f" style="margin-top:8px">API-equivalent. Subscriptions are not billed per run.</div>
      </div></div>
    </div>
  </div>`;
}

function viewOf(i: number): FileView {
  let v = ui.views.get(i);
  if (!v) {
    v = {
      open: true,
      viewed: viewedSet().has(ui.files[i]?.path ?? ""),
      loaded: false,
      full: null,
      expanded: new Set(),
    };
    ui.views.set(i, v);
  }
  return v;
}
function viewedKey() {
  return `bumpsmith-viewed:${ui.detail?.id ?? ""}`;
}
function viewedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(viewedKey()) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function saveViewed() {
  try {
    const paths = ui.files.filter((_, i) => ui.views.get(i)?.viewed).map((f) => f.path);
    localStorage.setItem(viewedKey(), JSON.stringify(paths));
  } catch {
    // not persisted
  }
}

function changesTab(files: FileDiff[], edited: Set<string>, job: Job) {
  if (!files.length)
    return `<div class="panel"><div class="blank"><h3>No changes</h3><p>${job.state === "safe" ? "The upgrade needed no code change." : "This run produced no patch."}</p></div></div>`;
  const add = files.reduce((n, x) => n + x.added, 0);
  const del = files.reduce((n, x) => n + x.removed, 0);
  const viewed = files.filter((_, i) => viewOf(i).viewed).length;
  const reasons = new Map<string, string>(
    ((job.edits ?? []) as { path: string; reason: string | null }[])
      .filter((e) => e.reason)
      .map((e) => [e.path, e.reason as string]),
  );
  return `<div class="pr-bar">
      <div class="pr-sum">Showing <b>${plural(files.length, "changed file")}</b> with <b class="a">${plural(add, "addition")}</b> and <b class="d">${plural(del, "deletion")}</b></div>
      <div class="grow"></div>
      <span class="legend-who"><span class="who who-agent">agent</span><span class="who who-manifest">version bump</span><span class="who who-lock">package manager</span></span>
      <div class="seg"><button class="${ui.split ? "" : "on"}" data-act="diff-mode" data-v="unified">Unified</button><button class="${ui.split ? "on" : ""}" data-act="diff-mode" data-v="split">Split</button></div>
      <button class="btn icon ${ui.wrap ? "on" : ""}" data-act="wrap" title="${ui.wrap ? "Do not wrap" : "Wrap"} long lines" aria-pressed="${ui.wrap}">${icon("wrap")}</button>
      <div class="pr-viewed" title="Files you marked as viewed"><span class="mono">${viewed} / ${files.length}</span> viewed<div class="pv-bar"><i style="width:${(viewed / files.length) * 100}%"></i></div></div>
    </div>
    <div class="pr-body">
      <aside class="ftree">
        <label class="ftree-q">${icon("search")}<input id="tree-q" placeholder="Filter changed files" value="${esc(ui.treeFilter)}" spellcheck="false" /></label>
        <div class="ftree-l">${fileTree(files, { active: ui.activeFile, filter: ui.treeFilter, edited, viewed: (i) => viewOf(i).viewed })}</div>
      </aside>
      <div class="fds">${files
        .map((f, i) =>
          fileCard(f, i, viewOf(i), {
            split: ui.split,
            wrap: ui.wrap,
            who: whoOf(f.path, edited),
            reason: reasons.get(f.path) ?? null,
          }),
        )
        .join("")}</div>
    </div>`;
}

function logTab(id: string) {
  return jobLog(ui.steps, { open: ui.logOpen, query: ui.logQuery, title: `Run ${id}` });
}

function reportTab(det: { id: string; evidence: string }, d: State) {
  const text = det.evidence || "";
  if (!text)
    return `<div class="panel"><div class="blank"><h3>No report</h3><p>This run did not write an evidence report.</p></div></div>`;
  const lines = text.replace(/\n$/, "").split("\n");
  const kb = (new TextEncoder().encode(text).length / 1024).toFixed(1);
  return `<div class="panel mdf">
    <div class="mdf-h">
      <div class="seg"><button class="${ui.reportMode === "preview" ? "on" : ""}" data-act="report-mode" data-v="preview">Preview</button><button class="${ui.reportMode === "code" ? "on" : ""}" data-act="report-mode" data-v="code">Code</button></div>
      <span class="mono muted mdf-meta">evidence.md · ${lines.length} lines · ${kb} KB</span>
      <div class="grow"></div>
      <span class="mono faint mdf-path" title="${esc(d.runsDir)}/${esc(det.id)}/evidence.md">${esc(d.runsDir.replace(d.repo.path, "."))}/${esc(det.id)}/evidence.md</span>
      <button class="btn icon ghost" data-act="copy-text" data-v="${esc(text)}" title="Copy raw file">${icon("copy")}</button>
    </div>
    ${
      ui.reportMode === "preview"
        ? `<article class="markdown">${renderMarkdown(text)}</article>`
        : `<div class="blob"><table>${lines.map((l, i) => `<tr><td class="dn" data-n="${i + 1}"></td><td class="bl">${esc(l) || " "}</td></tr>`).join("")}</table></div>`
    }
  </div>`;
}

function checksTab(job: Job, cmp: Cmp[]) {
  const base = (job.baseline ?? []) as {
    name: string;
    passed: boolean;
    command: string;
    duration_ms: number;
    timed_out: boolean;
    output_tail: string;
  }[];
  const after = ((job.rounds?.length ? job.rounds[job.rounds.length - 1].checks : job.after_bump) ??
    []) as typeof base;
  const names = [...new Set([...base.map((c) => c.name), ...cmp.map((c) => c.name)])];
  const res = (v: boolean | null | undefined) =>
    v === null || v === undefined
      ? `<span class="badge">not run</span>`
      : v
        ? `<span class="badge ok">pass</span>`
        : `<span class="badge bad">fail</span>`;
  return `<div class="panel"><div class="panel-h"><h2>Checks</h2><span class="sub">Your own commands, run in the sandbox before and after the bump. Select one for its output.</span></div>
    <div class="tw"><table class="t"><thead><tr><th>Check</th><th>Command</th><th>Before</th><th>After</th><th>Meaning</th><th class="r">Time</th></tr></thead><tbody>
    ${names
      .map((n) => {
        const c = cmp.find((x) => x.name === n);
        const b = base.find((x) => x.name === n);
        const a = after.find((x) => x.name === n);
        const meaning = !c
          ? b && !b.passed && n === "install"
            ? "dependencies did not install"
            : "not compared"
          : c.regression
            ? `<b style="color:var(--bad)">broken by the bump</b>${c.newFailures?.length ? `: ${esc(c.newFailures.slice(0, 2).join(", "))}` : ""}`
            : c.sameFailures
              ? `same ${plural(c.sameFailures.failing.length, "failing test")} as before; ${c.sameFailures.passed} pass`
              : c.after === null
                ? c.baseline === false
                  ? "already failing; not re-run"
                  : "not re-run"
                : c.baseline && c.after
                  ? c.flaky
                    ? "passes (flaky once)"
                    : "still passes"
                  : c.after
                    ? "fixed"
                    : "still failing";
        const open = ui.openCheck === n;
        return `<tr data-act="toggle-check" data-v="${esc(n)}"><td><b class="mono">${esc(n)}</b></td><td class="mono muted" style="max-width:280px;overflow:hidden;text-overflow:ellipsis">${esc((b?.command ?? "").slice(0, 120))}</td><td>${res(c?.baseline ?? b?.passed)}</td><td>${c?.sameFailures ? `<span class="badge ok">same failures</span>` : res(c?.after)}</td><td class="muted" style="white-space:normal;min-width:200px">${meaning}</td><td class="r mono muted">${b ? dur(b.duration_ms) : ""}</td></tr>
        ${
          open
            ? `<tr><td colspan="6" style="padding:0;cursor:default"><div class="chk-out">${[
                ["before", b],
                ["after", a],
              ]
                .map(
                  ([lbl, x]) =>
                    `<div><div class="lbl">${lbl}${(x as typeof b)?.command ? ` · <span class="faint">$ ${esc(((x as typeof b)?.command ?? "").slice(0, 90))}</span>` : ""}</div><div class="jl-out">${logLines(outputLines((x as typeof b)?.output_tail || "no output"))}</div></div>`,
                )
                .join("")}</div></td></tr>`
            : ""
        }`;
      })
      .join("")}
    </tbody></table></div></div>`;
}

function breakingTab(job: Job, changes: Change[]) {
  if (!changes.length)
    return `<div class="panel"><div class="blank"><h3>${job.change_record ? "No breaking changes found" : "No change record"}</h3><p>${job.change_record ? "Nothing in the changelog, release notes or API diff breaks between these versions." : "The run stopped before reading the changelog."}</p></div></div>`;
  return `<div class="panel"><div class="panel-h"><h2>Breaking changes</h2><span class="sub">From the changelog, release notes and API diff of <code class="ic">${esc(job.input.packageName)}</code></span></div>
    ${changes
      .map(
        (
          c,
        ) => `<div class="bc"><div class="bc-h"><code>${esc(c.symbols?.join(", ") || c.id)}</code><span class="badge">${esc(c.kind.replace(/_/g, " "))}</span><span class="badge ${c.confidence === "high" ? "ok" : c.confidence === "medium" ? "info" : "warn"}">${esc(c.confidence)}</span></div>
        <p>${md(c.instruction)}</p>
        ${c.before || c.after ? snippetDiff(c.before, c.after, job.input.ecosystem === "pypi" ? "x.py" : "x.ts") : ""}
        ${
          c.evidence?.length
            ? `<div class="bc-src">${[...new Map(c.evidence.map((e) => [e.url, e])).values()]
                .slice(0, 3)
                .map(
                  (e) =>
                    `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.url.replace(/^https?:\/\//, "").slice(0, 64))}</a>`,
                )
                .join("")}</div>`
            : ""
        }
      </div>`,
      )
      .join("")}</div>`;
}

// ───────────── dependencies, safety, sandbox ─────────────

function depsPage(d: State) {
  const debt = d.debt;
  if (!debt)
    return `<div class="page"><div class="ph"><div><h1>Dependencies</h1><p>${Object.keys(d.repo.dependencies).length} direct dependencies${d.repo.packageManager ? ` · ${esc(d.repo.packageManager)}` : ""}</p></div></div>
      <div class="panel"><div class="blank"><div class="blank-i">${icon("scan")}</div><h3>Find your upgrade debt</h3><p>A scan looks up the latest version of each direct dependency on the public registry. Only package names leave your machine.</p>
      <button class="btn primary" data-act="scan" ${ui.busy.has("scan") ? "disabled" : ""}>${icon("scan")}${ui.busy.has("scan") ? "Scanning…" : "Scan now"}</button></div></div></div>`;
  const behind = [...debt.behind].sort(
    (a, b) => b.majorsBehind - a.majorsBehind || a.package.localeCompare(b.package),
  );
  const majors = behind.filter((b) => b.majorsBehind > 0);
  const maxM = Math.max(...behind.map((b) => b.majorsBehind), 1);
  return `<div class="page">
    <div class="ph"><div><h1>Dependencies</h1><p><span>${esc(debt.packageManager)}</span><span class="faint">Scanned ${agoLong(debt.generatedAt)}</span></p></div>
      <div class="act"><button class="btn" data-act="scan" ${ui.busy.has("scan") ? "disabled" : ""}>${icon("scan")}${ui.busy.has("scan") ? "Scanning…" : "Scan again"}</button></div></div>
    <div class="grid g4">
      ${stat("package", "Direct dependencies", String(debt.directDependencies), "", "", "Declared in your manifests")}
      ${stat("alertCircle", "Behind a major", String(majors.length), `of ${debt.directDependencies}`, ticks(majors.length, Math.max(debt.directDependencies, 1), "accent"), `${majors.reduce((n, b) => n + b.majorsBehind, 0)} majors in total`)}
      ${stat("checkCircle", "Upgradable today", String(majors.filter((b) => b.latestEligible).length), "", "", "Past the release-age rule")}
      ${stat("clock", "Oldest gap", majors[0] ? `${majors[0].majorsBehind}` : "0", "majors", "", majors[0] ? majors[0].package : "Nothing behind")}
    </div>
    <div class="panel mt"><div class="panel-h"><h2>Behind</h2><span class="cnt">${behind.length}</span></div>
      <div class="tw"><table class="t"><thead><tr><th>Package</th><th>Current</th><th>Latest</th><th>Majors behind</th><th>Released</th><th></th></tr></thead><tbody>
      ${behind
        .map(
          (b) => `<tr data-act="new" data-pkg="${esc(b.package)}" data-ver="${esc(b.latest ?? "")}">
        <td><span class="pkg"><b>${esc(b.package)}</b></span></td>
        <td class="mono muted">${esc(b.current ?? "?")}</td><td class="mono"><b>${esc(b.latest ?? "?")}</b></td>
        <td><div style="display:flex;gap:12px;align-items:center"><div class="bar" style="width:96px"><i style="width:${(b.majorsBehind / maxM) * 100}%"></i></div><span class="mono">${b.majorsBehind}</span></div></td>
        <td class="muted">${b.latestPublishedAt ? agoLong(b.latestPublishedAt) : "—"}${b.latestEligible ? "" : ` <span class="badge info">too new</span>`}</td>
        <td class="r"><span class="btn">${icon("play")}Upgrade</span></td>
      </tr>`,
        )
        .join("")}</tbody></table></div></div>
  </div>`;
}

function safetyPage(d: State) {
  const blocked = d.runs.filter((r) => r.state === "blocked_policy");
  const items: [string, string, string][] = [
    [
      "box",
      "Isolated sandbox",
      "A throwaway container with no internet, host files or secrets. Network is on only while installing, through a read-only registry mirror.",
    ],
    [
      "shield",
      "Release gate",
      "A new version must be a few days old, not yanked, and not listed as malicious (OSV) before anything installs.",
    ],
    [
      "lock",
      "Edit policy",
      "The agent may only edit files tied to the failure. Manifests, CI and protected paths are off limits.",
    ],
    [
      "eye",
      "Independent review",
      "A second model checks the diff against five rules; deterministic rules block suspicious code.",
    ],
    [
      "flask",
      "Proof, not claims",
      "Bumpsmith re-runs your own checks after every round. A result is ready only if the sandbox proves it.",
    ],
  ];
  return `<div class="page">
    <div class="ph"><div><h1>Safety</h1><p>What every upgrade here went through, and what was refused</p></div></div>
    <div class="grid g-1-1">
      <div class="panel"><div class="panel-h"><h2>Guarantees</h2><span class="sub">on for every run</span></div>
        <div class="notes">${items.map(([ic, t, s]) => `<div class="note">${icon(ic)}<div><b style="color:var(--text);font-weight:550">${t}</b><div class="muted">${s}</div></div></div>`).join("")}</div></div>
      <div class="panel"><div class="panel-h"><h2>Refused</h2><span class="cnt">${blocked.length}</span></div>
        ${blocked.length ? `<div class="tw"><table class="t"><tbody>${blocked.map((r) => `<tr data-act="open-run" data-id="${esc(r.id)}"><td><span class="pkg"><b>${esc(r.package)}</b></span> <span class="ver">${esc(r.to)}</span><div class="why" style="max-width:none;white-space:normal;margin-top:2px">${md(r.reason ?? "blocked")}</div></td><td class="r muted" style="vertical-align:top">${ago(r.created_at)} ago</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-s"><b>Nothing refused</b>Malicious or too-new releases, and changes that trip a rule, show up here with the reason.</div>`}</div>
    </div>
  </div>`;
}

function sandboxPage(d: State) {
  return `<div class="page">
    <div class="ph"><div><h1>Sandbox & models</h1><p>What runs your upgrades on this machine</p></div></div>
    <div class="grid g-1-1">
      <div class="panel"><div class="panel-h"><h2>Models</h2><span class="sub">your own subscription or key</span></div>
        <div class="tw"><table class="t"><tbody>${d.env.providers.map((p) => `<tr style="cursor:default"><td><b>${esc(p.label)}</b>${p.id === d.env.defaultProvider ? ` <span class="badge accent">default</span>` : ""}<div class="mono muted" style="font-size:12px">${esc(p.detail)}</div></td><td class="r">${p.ok ? `<span class="st ok">${icon("checkCircle")}available</span>` : `<span class="muted">not set up</span>`}</td></tr>`).join("")}</tbody></table></div></div>
      <div class="grid" style="align-content:start">
        <div class="panel"><div class="panel-h"><h2>Sandbox</h2><div class="r">${d.env.docker ? `<span class="badge ok"><span class="dot ok"></span>ready</span>` : `<span class="badge bad">Docker not running</span>`}</div></div>
          <div class="panel-b"><dl class="kv"><dt>Docker</dt><dd class="mono">${esc(d.env.docker ?? "start Docker Desktop or OrbStack")}</dd><dt>Network</dt><dd>registry mirror only, while installing</dd><dt>Node</dt><dd class="mono">22 · 24 · 26</dd><dt>Python</dt><dd class="mono">3.10 – 3.15</dd><dt>Runs</dt><dd class="mono">${esc(d.runsDir)}</dd></dl></div></div>
        <div class="panel"><div class="panel-h"><h2>Privacy</h2></div><div class="panel-b muted" style="font-size:13px">This dashboard listens on 127.0.0.1 only and reads files in this repository. It sends nothing anywhere: fonts are bundled, there is no analytics, and every action needs a token that only this page has.</div></div>
      </div>
    </div>
  </div>`;
}

// ───────────── new upgrade + live run ─────────────

const STAGES = [
  { id: "prepare", label: "Copy the repository" },
  { id: "analyse", label: "Read the changelog" },
  { id: "baseline", label: "Run your checks before" },
  { id: "bump", label: "Apply the bump" },
  { id: "verify", label: "Run your checks after" },
  { id: "fix", label: "Fix what broke" },
  { id: "review", label: "Independent review" },
  { id: "done", label: "Result" },
];

function drawer(d: State) {
  const dr = ui.drawer;
  if (!dr) return "";
  if (dr.mode === "live" && dr.liveId) {
    const l = ui.live.get(dr.liveId);
    const result = l?.done && l.jobId ? d.runs.find((r) => r.id === l.jobId) : undefined;
    const good = result ? isGood(result) : l?.exitCode === 0;
    const reachedIdx = STAGES.findIndex((s) => s.id === (l?.reached ?? "prepare"));
    const at = l?.done ? reachedIdx : STAGES.findIndex((s) => s.id === (l?.stage ?? "prepare"));
    const cls = (i: number) =>
      !l?.done
        ? i < at
          ? "done"
          : i === at
            ? "active"
            : "pending"
        : i === STAGES.length - 1
          ? good
            ? "done"
            : "fail"
          : i < at || (good && i <= at)
            ? "done"
            : i === at
              ? "fail"
              : "pending";
    return `<div class="scrim ${fresh(opened.drawer)}" data-act="close"></div><aside class="drawer ${fresh(opened.drawer)}" role="dialog" aria-label="Upgrade run">
      <div class="drawer-h"><h3><span class="dot ${l?.done ? (good ? "ok" : "bad") : "live"}"></span><span class="mono">${esc(l?.package ?? dr.pkg)}</span><span class="ver"><span class="ar">→</span><b>${esc(l?.version ?? dr.version)}</b></span></h3><div class="grow"></div><button class="btn icon ghost" data-act="close" title="Close (the run continues)">${icon("x")}</button></div>
      <div class="drawer-b">
        <div class="panel"><div class="steps">${STAGES.map((s, i) => {
          const c = cls(i);
          return `<div class="step ${c}"><div class="step-i">${icon(c === "done" ? "check" : c === "fail" ? "x" : c === "active" ? "bolt" : "clock")}</div><div><div class="step-t">${i === STAGES.length - 1 && result ? esc(stateOf(result.state).label) : s.label}</div></div><div class="step-r">${c === "active" ? "running" : c === "fail" && i < STAGES.length - 1 ? "stopped here" : ""}</div></div>`;
        }).join("")}</div></div>
        ${result && !good && result.reason ? `<div class="callout">${icon("alertCircle")}<div>${md(result.reason)}</div></div>` : ""}
        <div><div class="field"><label>Log</label></div><div class="jl-out live" id="term">${logLines((l?.lines ?? []).map((x) => lineOf(x, /^job /.test(x) ? "head" : /^(READY|SAFE) /.test(x) ? "ok" : undefined)))}${l?.done ? "" : `<div class="ll"><span class="lnum"></span><span class="ltx"><span class="cur"></span></span></div>`}</div></div>
      </div>
      <div class="drawer-f">${
        l?.done
          ? `${result ? `${statePill(result.state)}${confPill(result.confidence)}` : `<span class="muted">${l.exitCode === 0 ? "Done" : "Finished with problems"}</span>`}<div class="grow"></div>${l.jobId ? `<a class="btn primary" data-act="close" href="#/runs/${esc(l.jobId)}">Open run ${icon("arrowR")}</a>` : ""}`
          : `<span class="muted" style="font-size:13px">Closing this keeps the run going.</span><div class="grow"></div><button class="btn" data-act="close">Hide</button>`
      }</div>
    </aside>`;
  }
  const deps = Object.keys(d.repo.dependencies);
  const q = dr.pkg.toLowerCase();
  const matches = q
    ? deps.filter((x) => x.toLowerCase().includes(q)).slice(0, 8)
    : deps.slice(0, 8);
  const showList =
    (document.activeElement as HTMLElement | null)?.id === "f-pkg" &&
    matches.length &&
    !deps.includes(dr.pkg);
  const latest = ui.latest[dr.pkg];
  return `<div class="scrim ${fresh(opened.drawer)}" data-act="close"></div><aside class="drawer ${fresh(opened.drawer)}" role="dialog" aria-label="New upgrade">
    <div class="drawer-h"><h3>New upgrade</h3><span class="mono faint" style="font-size:12px">${esc(d.repo.name)} · ${esc(d.repo.packageManager ?? "")}</span><div class="grow"></div><button class="btn icon ghost" data-act="close">${icon("x")}</button></div>
    <div class="drawer-b">
      <div class="field"><label for="f-pkg">Package</label><div class="combo"><input class="input mono" id="f-pkg" autocomplete="off" spellcheck="false" placeholder="zod" value="${esc(dr.pkg)}" />
        ${showList ? `<div class="combo-list">${matches.map((m) => `<div class="combo-i" data-act="pick-pkg" data-v="${esc(m)}">${esc(m)}<span>${esc(d.repo.dependencies[m] ?? "")}</span></div>`).join("")}</div>` : ""}</div>
        <div class="hint">${d.repo.dependencies[dr.pkg] ? `Declared as <code class="ic">${esc(d.repo.dependencies[dr.pkg])}</code>` : dr.pkg ? "Not a direct dependency here; transitive packages work too." : `${deps.length} direct dependencies`}</div></div>
      <div class="field"><label for="f-ver">Version</label><input class="input mono" id="f-ver" spellcheck="false" placeholder="${esc(latest ?? "4.1.0")}" value="${esc(dr.version)}" />
        <div class="hint">${latest ? `Latest on the registry: <code class="ic">${esc(latest)}</code>` : "An exact version"}</div></div>
      <div class="field"><label>Model</label><div class="provs">${d.env.providers.map((p) => `<div class="prov ${dr.provider === p.id ? "on" : ""} ${p.ok ? "" : "off"}" data-act="${p.ok ? "pick-prov" : ""}" data-v="${p.id}"><span class="rd"></span><div><div class="pn">${esc(p.label)}</div><div class="pd">${esc(p.detail)}</div></div><span class="ps">${p.ok ? "available" : "not set up"}</span></div>`).join("")}</div></div>
      <div class="field"><label for="f-budget">Spend cap <span class="mono muted">${money(dr.budget, 0)}</span></label><input type="range" class="range" id="f-budget" min="1" max="30" step="1" value="${dr.budget}" /><div class="hint">The run stops before it goes over (API-equivalent cost).</div></div>
      ${d.env.docker ? "" : `<div class="callout">${icon("alertCircle")}<div>Docker is not running. Start Docker Desktop or OrbStack: every upgrade runs in a sandbox.</div></div>`}
    </div>
    <div class="drawer-f"><span class="mono faint" style="font-size:12px">$ bumpsmith fix ${esc(dr.pkg || "pkg")}@${esc(dr.version || "x.y.z")}</span><div class="grow"></div><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="start" ${dr.pkg && /^\d/.test(dr.version) && d.env.docker ? "" : "disabled"}>${icon("play")}Start</button></div>
  </aside>`;
}

async function followLive(id: string) {
  const r = await fetch(`/api/live/${id}`, { headers: { "x-bumpsmith-token": TOKEN } });
  if (!r.body) return;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const events = buf.split("\n\n");
    buf = events.pop() ?? "";
    for (const ev of events) {
      const type = /^event: (\w+)/m.exec(ev)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(ev)?.[1] ?? "{}");
      const l = ui.live.get(id);
      if (!l) continue;
      if (type === "line") {
        l.lines.push(data.line);
        l.stage = data.stage;
        if (data.stage !== "done") l.reached = data.stage;
        l.jobId = data.jobId;
      } else if (type === "done") {
        l.done = true;
        l.exitCode = data.exitCode;
        l.jobId = data.jobId ?? l.jobId;
        l.stage = "done";
        await refresh();
        const res = ui.data?.runs.find((x) => x.id === l.jobId);
        toast(
          `${l.package} ${l.version}: ${res ? stateOf(res.state).label.toLowerCase() : "finished"}`,
          !(res && isGood(res)),
        );
      }
    }
    render();
  }
}

// ───────────── command palette ─────────────

function paletteItems(d: State) {
  const q = ui.palQuery.toLowerCase();
  const items: { g: string; ic: string; t: string; k?: string; run: () => void }[] = [
    { g: "Actions", ic: "plus", t: "New upgrade", k: "N", run: () => openNew() },
    { g: "Actions", ic: "scan", t: "Scan dependencies", run: () => scan() },
    {
      g: "Actions",
      ic: theme() === "dark" ? "sun" : "moon",
      t: "Switch theme",
      run: () => toggleTheme(),
    },
    { g: "Go to", ic: "grid", t: "Overview", run: () => go("") },
    { g: "Go to", ic: "layers", t: "Upgrades", run: () => go("runs") },
    { g: "Go to", ic: "package", t: "Dependencies", run: () => go("deps") },
    { g: "Go to", ic: "shield", t: "Safety", run: () => go("safety") },
    { g: "Go to", ic: "cpu", t: "Sandbox & models", run: () => go("sandbox") },
    ...d.runs.slice(0, 40).map((r) => ({
      g: "Runs",
      ic: "diff",
      t: `${r.package} ${r.from ?? "?"} → ${r.to}`,
      k: stateOf(r.state).short,
      run: () => go(`runs/${r.id}`),
    })),
    ...Object.keys(d.repo.dependencies)
      .slice(0, 200)
      .map((p) => ({
        g: "Upgrade a dependency",
        ic: "play",
        t: p,
        k: d.repo.dependencies[p],
        run: () => openNew(p),
      })),
  ];
  return items
    .filter((i) => !q || i.t.toLowerCase().includes(q) || i.g.toLowerCase().includes(q))
    .slice(0, 40);
}
function palette(d: State) {
  if (!ui.palette) return "";
  const items = paletteItems(d);
  let g = "";
  return `<div class="scrim ${fresh(opened.palette)}" data-act="close-pal" style="background:rgba(0,0,0,.18)"></div><div class="palette ${fresh(opened.palette)}" role="dialog" aria-label="Command palette">
    <input id="pal" placeholder="Search runs, dependencies and actions" value="${esc(ui.palQuery)}" autocomplete="off" spellcheck="false" />
    <div class="list">${
      items
        .map((it, i) => {
          const head = it.g !== g ? `<div class="pal-g">${esc(it.g)}</div>` : "";
          g = it.g;
          return `${head}<div class="pal-i ${i === ui.palIndex ? "on" : ""}" data-act="pal-run" data-v="${i}">${icon(it.ic)}<span>${esc(it.t)}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ""}</div>`;
        })
        .join("") || `<div class="empty-s">No matches</div>`
    }</div></div>`;
}

// ───────────── routing, rendering, events ─────────────

function go(path: string) {
  location.hash = `#/${path}`;
}
function toggleTheme() {
  const next = theme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("bumpsmith-theme", next);
  } catch {
    // not persisted
  }
  render();
}
function openNew(pkg = "", ver = "") {
  const d = ui.data;
  const prov =
    d?.env.providers.find((p) => p.id === d.env.defaultProvider && p.ok) ??
    d?.env.providers.find((p) => p.ok);
  ui.drawer = { mode: "new", pkg, version: ver, provider: prov?.id ?? "claude-code", budget: 8 };
  ui.palette = false;
  render();
  if (pkg && !ver) fetchLatest(pkg);
  setTimeout(
    () => (document.getElementById(pkg ? "f-ver" : "f-pkg") as HTMLInputElement | null)?.focus(),
    60,
  );
}
async function fetchLatest(pkg: string) {
  if (!pkg) return;
  if (pkg in ui.latest) {
    if (ui.drawer?.pkg === pkg && !ui.drawer.version && ui.latest[pkg]) {
      ui.drawer.version = ui.latest[pkg] ?? "";
      ui.drawer.auto = true;
      render();
    }
    return;
  }
  ui.latest[pkg] = null;
  try {
    const r = await api<{ version: string | null }>(
      `/api/latest?name=${encodeURIComponent(pkg)}&ecosystem=${ui.data?.repo.ecosystem ?? "npm"}`,
    );
    ui.latest[pkg] = r.version;
    if (ui.drawer?.pkg === pkg) {
      if (!ui.drawer.version && r.version) {
        ui.drawer.version = r.version;
        ui.drawer.auto = true;
      }
      render();
    }
  } catch {
    // offline or unknown package
  }
}
async function scan() {
  if (ui.busy.has("scan")) return;
  ui.busy.add("scan");
  render();
  try {
    await api("/api/scan", { method: "POST" });
    await refresh();
    toast("Dependencies scanned");
    go("deps");
  } catch (e) {
    toast((e as Error).message, true);
  } finally {
    ui.busy.delete("scan");
    render();
  }
}
async function refresh() {
  const d = await api<State>("/api/state");
  for (const l of d.live) if (!ui.live.has(l.id)) ui.live.set(l.id, l);
  ui.data = d;
}
async function loadDetail(id: string) {
  if (ui.detail?.id === id) return;
  ui.detail = null;
  ui.tab = "summary";
  ui.openCheck = null;
  ui.views = new Map();
  ui.files = [];
  ui.treeFilter = "";
  ui.activeFile = 0;
  ui.logQuery = "";
  try {
    const r = await api<{ job: Job; patch: string; evidence: string }>(
      `/api/runs/${encodeURIComponent(id)}`,
    );
    ui.detail = { id, ...r };
    ui.files = parsePatch(r.patch);
    ui.steps = buildSteps(r.job);
    // Failed and warning steps open by default, like a CI log.
    ui.logOpen = new Set(
      ui.steps.filter((s) => s.status === "fail" || s.status === "warn").map((s) => s.id),
    );
  } catch (e) {
    toast((e as Error).message, true);
    go("runs");
  }
  render();
}
/** Show the unchanged lines hidden before hunk `g` (or after the last hunk). */
async function expandGap(fi: number, g: number, rerender = true) {
  const f = ui.files[fi];
  const det = ui.detail;
  if (!f || !det) return;
  const vw = viewOf(fi);
  if (!vw.full) {
    try {
      const r = await api<{ text: string }>(
        `/api/runs/${encodeURIComponent(det.id)}/file?side=${f.status === "deleted" ? "before" : "after"}&path=${encodeURIComponent(f.path)}`,
      );
      vw.full = r.text.split("\n");
    } catch (e) {
      toast((e as Error).message, true);
      return;
    }
  }
  vw.expanded.add(g);
  if (rerender) render();
}

async function apply(id: string) {
  if (!confirm("Apply this patch to your working tree and stage it?")) return;
  ui.busy.add(`apply:${id}`);
  render();
  try {
    const r = await api<{ message: string }>(`/api/runs/${encodeURIComponent(id)}/apply`, {
      method: "POST",
    });
    toast(r.message);
  } catch (err) {
    toast((err as Error).message, true);
  } finally {
    ui.busy.delete(`apply:${id}`);
    await refresh();
    render();
  }
}

let tipEl: HTMLDivElement | null = null;
/** When the drawer / palette opened: their entrance animation plays once, not on every render. */
const opened = { drawer: 0, palette: 0 };
const fresh = (t: number) => (Date.now() - t < 400 ? "anim" : "");
function render() {
  const d = ui.data;
  if (!d) {
    $app.innerHTML = `<aside class="sidebar"><div class="brand">${BRAND_WORDMARK}</div><div class="skel" style="height:48px"></div></aside><main class="main"><div class="page"><div class="skel" style="height:28px;width:240px;margin-bottom:24px"></div><div class="grid g4">${'<div class="skel" style="height:128px"></div>'.repeat(4)}</div><div class="skel mt" style="height:320px"></div></div></main>`;
    return;
  }
  const [route, arg] = ui.route.split("/");
  const crumbs = [d.repo.name];
  let body = "";
  if (route === "runs" && arg) {
    crumbs.push("Upgrades", ui.detail?.job?.input?.packageName ?? "…");
    body = detailPage(d);
  } else if (route === "runs") {
    crumbs.push("Upgrades");
    body = runsPage(d);
  } else if (route === "deps") {
    crumbs.push("Dependencies");
    body = depsPage(d);
  } else if (route === "safety") {
    crumbs.push("Safety");
    body = safetyPage(d);
  } else if (route === "sandbox") {
    crumbs.push("Sandbox & models");
    body = sandboxPage(d);
  } else {
    crumbs.push("Overview");
    body = overview(d);
  }
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id;
  const caret = active && "selectionStart" in active ? active.selectionStart : null;
  const term = document.getElementById("term");
  const atBottom = !term || term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  $app.className = "shell";
  if (ui.drawer && !opened.drawer) opened.drawer = Date.now();
  if (!ui.drawer) opened.drawer = 0;
  if (ui.palette && !opened.palette) opened.palette = Date.now();
  if (!ui.palette) opened.palette = 0;
  $app.innerHTML = `${sidebar(d)}<main class="main">${topbar(crumbs)}${body}</main>${drawer(d)}${palette(d)}`;
  if (focusId) {
    const el = document.getElementById(focusId) as HTMLInputElement | null;
    if (el) {
      el.focus();
      if (caret !== null) el.setSelectionRange(caret, caret);
    }
  }
  const t2 = document.getElementById("term");
  if (t2 && atBottom) t2.scrollTop = t2.scrollHeight;
  // On narrow screens the tab strip scrolls: keep the open tab in view.
  const tabs = document.querySelector<HTMLElement>(".tabs");
  const on = tabs?.querySelector<HTMLElement>(".tab.on");
  if (tabs && on && tabs.scrollWidth > tabs.clientWidth)
    tabs.scrollLeft = Math.max(
      0,
      on.getBoundingClientRect().left - tabs.getBoundingClientRect().left - 16,
    );
}

async function onRoute() {
  ui.route = location.hash.replace(/^#\/?/, "");
  const [route, arg] = ui.route.split("/");
  if (route === "runs" && arg) loadDetail(arg);
  render();
  window.scrollTo({ top: 0 });
}

document.addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  const v = t.dataset.v ?? "";
  const d = ui.data;
  if (!d) return;
  switch (act) {
    case "go":
      go(t.dataset.to ?? "");
      break;
    case "new":
      e.preventDefault();
      openNew(t.dataset.pkg ?? "", t.dataset.ver ?? "");
      break;
    case "theme":
      toggleTheme();
      break;
    case "close":
      ui.drawer = null;
      render();
      break;
    case "open-run":
      if (
        (e.target as HTMLElement).closest("a,button") &&
        (e.target as HTMLElement).closest("a,button") !== t
      )
        break;
      go(`runs/${t.dataset.id}`);
      break;
    case "open-live":
      ui.drawer = {
        mode: "live",
        pkg: "",
        version: "",
        provider: "",
        budget: 0,
        liveId: t.dataset.id,
      };
      render();
      break;
    case "filter":
      ui.filter = v;
      render();
      break;
    case "filter-ready":
      ui.filter = "ready";
      break;
    case "tab":
      ui.tab = v as Tab;
      render();
      break;
    case "scan":
      scan();
      break;
    case "diff-mode":
      ui.split = v === "split";
      try {
        localStorage.setItem("bumpsmith-diff", v);
      } catch {
        // not persisted
      }
      render();
      break;
    case "wrap":
      ui.wrap = !ui.wrap;
      render();
      break;
    case "file-toggle": {
      const vw = viewOf(Number(t.dataset.f));
      if (vw.viewed) vw.viewed = false;
      else vw.open = !vw.open;
      saveViewed();
      render();
      break;
    }
    case "file-viewed": {
      const vw = viewOf(Number(t.dataset.f));
      vw.viewed = (t as HTMLInputElement).checked;
      if (!vw.viewed) vw.open = true;
      saveViewed();
      render();
      break;
    }
    case "file-load":
      viewOf(Number(t.dataset.f)).loaded = true;
      render();
      break;
    case "file-jump": {
      const fi = Number(t.dataset.f);
      ui.activeFile = fi;
      const vw = viewOf(fi);
      vw.open = true;
      render();
      document.getElementById(`file-${fi}`)?.scrollIntoView({ block: "start" });
      break;
    }
    case "diff-expand":
      await expandGap(Number(t.dataset.f), Number(t.dataset.g));
      break;
    case "file-expand-all": {
      const fi = Number(t.dataset.f);
      const f = ui.files[fi];
      if (f) for (let g = 0; g <= f.hunks.length; g++) await expandGap(fi, g, false);
      render();
      break;
    }
    case "copy-text":
      await navigator.clipboard.writeText(t.dataset.v ?? "");
      toast("Copied");
      break;
    case "log-step":
      if (ui.logOpen.has(v)) ui.logOpen.delete(v);
      else ui.logOpen.add(v);
      render();
      break;
    case "log-all":
      ui.logOpen = v === "open" ? new Set(ui.steps.map((s) => s.id)) : new Set();
      render();
      break;
    case "log-download": {
      const blob = new Blob([logText(ui.steps)], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `bumpsmith-${ui.detail?.id ?? "run"}.log`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      break;
    }
    case "goto-log":
      ui.tab = "log";
      ui.logOpen.add(v);
      render();
      document.getElementById(`step-${v}`)?.scrollIntoView({ block: "start" });
      break;
    case "report-mode":
      ui.reportMode = v === "code" ? "code" : "preview";
      render();
      break;
    case "toggle-check":
      ui.openCheck = ui.openCheck === v ? null : v;
      render();
      break;
    case "pick-pkg":
      if (ui.drawer) {
        if (ui.drawer.pkg !== v && ui.drawer.auto) ui.drawer.version = "";
        ui.drawer.pkg = v;
        render();
        fetchLatest(v);
        (document.getElementById("f-ver") as HTMLInputElement | null)?.focus();
      }
      break;
    case "pick-prov":
      if (ui.drawer) {
        ui.drawer.provider = v;
        render();
      }
      break;
    case "start": {
      const dr = ui.drawer;
      if (!dr) break;
      try {
        const { id } = await api<{ id: string }>("/api/runs", {
          method: "POST",
          body: JSON.stringify({
            package: dr.pkg,
            version: dr.version,
            provider: dr.provider,
            budget: dr.budget,
          }),
        });
        ui.live.set(id, {
          id,
          package: dr.pkg,
          version: dr.version,
          provider: dr.provider,
          started_at: new Date().toISOString(),
          lines: [],
          stage: "prepare",
          jobId: null,
          done: false,
          exitCode: null,
        });
        ui.drawer = { ...dr, mode: "live", liveId: id };
        render();
        followLive(id);
      } catch (err) {
        toast((err as Error).message, true);
      }
      break;
    }
    case "apply":
      e.stopPropagation();
      await apply(t.dataset.id ?? "");
      break;
    case "copy-patch":
      if (ui.detail) {
        await navigator.clipboard.writeText(ui.detail.patch);
        toast("Patch copied");
      }
      break;
    case "delete": {
      const id = t.dataset.id ?? "";
      if (!confirm("Delete this run and its evidence? This cannot be undone.")) break;
      try {
        await api(`/api/runs/${encodeURIComponent(id)}/delete`, { method: "POST" });
        await refresh();
        ui.detail = null;
        toast("Run deleted");
        go("runs");
      } catch (err) {
        toast((err as Error).message, true);
      }
      break;
    }
    case "palette":
      ui.palette = true;
      ui.palQuery = "";
      ui.palIndex = 0;
      render();
      (document.getElementById("pal") as HTMLInputElement | null)?.focus();
      break;
    case "close-pal":
      ui.palette = false;
      render();
      break;
    case "pal-run":
      paletteItems(d)[Number(v)]?.run();
      ui.palette = false;
      render();
      break;
  }
});

document.addEventListener("input", (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === "q") {
    ui.query = el.value;
    render();
  } else if (el.id === "tree-q") {
    ui.treeFilter = el.value;
    render();
  } else if (el.id === "log-q") {
    ui.logQuery = el.value;
    render();
  } else if (el.id === "pal") {
    ui.palQuery = el.value;
    ui.palIndex = 0;
    render();
  } else if (ui.drawer && el.id === "f-pkg") {
    if (ui.drawer.auto) {
      ui.drawer.version = "";
      ui.drawer.auto = false;
    }
    ui.drawer.pkg = el.value.trim();
    render();
    lookupLatestSoon();
  } else if (ui.drawer && el.id === "f-ver") {
    ui.drawer.version = el.value.trim();
    ui.drawer.auto = false;
    render();
  } else if (ui.drawer && el.id === "f-budget") {
    ui.drawer.budget = Number(el.value);
    render();
  }
});
// Look up the latest version once typing pauses (no lookups on every keystroke).
let latestTimer = 0;
function lookupLatestSoon() {
  clearTimeout(latestTimer);
  latestTimer = window.setTimeout(() => {
    const pkg = ui.drawer?.pkg ?? "";
    if (/^(@[\w.-]+\/)?[\w.-]{2,}$/.test(pkg)) fetchLatest(pkg);
  }, 450);
}
document.addEventListener("keydown", (e) => {
  const d = ui.data;
  if (!d) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    ui.palette = !ui.palette;
    ui.palQuery = "";
    ui.palIndex = 0;
    render();
    (document.getElementById("pal") as HTMLInputElement | null)?.focus();
    return;
  }
  if (e.key === "Escape") {
    if (ui.palette) ui.palette = false;
    else if (ui.drawer) ui.drawer = null;
    render();
    return;
  }
  if (ui.palette) {
    const n = paletteItems(d).length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      ui.palIndex = (ui.palIndex + (e.key === "ArrowDown" ? 1 : -1) + n) % Math.max(n, 1);
      render();
      document.querySelector(".pal-i.on")?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      paletteItems(d)[ui.palIndex]?.run();
      ui.palette = false;
      render();
    }
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
  if (!typing && !ui.drawer && e.key.toLowerCase() === "n" && !e.metaKey && !e.ctrlKey) openNew();
  if (ui.drawer?.mode === "new" && e.key === "Enter" && typing)
    document.querySelector<HTMLButtonElement>('[data-act="start"]:not([disabled])')?.click();
});
document.addEventListener("mousemove", (e) => {
  const hint = (e.target as HTMLElement).closest<HTMLElement>("[data-hint]")?.dataset.hint;
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    document.body.append(tipEl);
  }
  if (!hint) {
    tipEl.classList.remove("on");
    return;
  }
  tipEl.textContent = hint;
  tipEl.style.left = `${e.clientX}px`;
  tipEl.style.top = `${e.clientY}px`;
  tipEl.classList.add("on");
});
window.addEventListener("hashchange", onRoute);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

(async () => {
  render();
  try {
    await refresh();
  } catch (e) {
    $app.innerHTML = `<div class="page"><div class="panel"><div class="blank"><h3>Could not load</h3><p>${esc((e as Error).message)}</p></div></div></div>`;
    return;
  }
  for (const l of ui.data?.live ?? []) if (!l.done) followLive(l.id);
  await onRoute();
  setInterval(async () => {
    if (document.hidden || ui.drawer || ui.palette) return;
    const before = ui.data?.runs.map((r) => r.id).join();
    await refresh().catch(() => {});
    if (ui.data?.runs.map((r) => r.id).join() !== before) render();
  }, 15000);
})();
