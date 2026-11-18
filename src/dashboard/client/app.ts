import {
  ago,
  agoLong,
  BRAND_MARK,
  type Bucket,
  barChart,
  buckets,
  cellOf,
  confPill,
  type DiffFile,
  dur,
  esc,
  flip,
  GRADIENTS,
  highlight,
  icon,
  md,
  median,
  money,
  OUTCOME_GROUPS,
  parseDiff,
  pkgTile,
  type Run,
  sparkline,
  stateOf,
  statePill,
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
  /** Last pipeline stage reached before the result (client-side). */
  reached?: string;
  id: string;
  package: string;
  version: string;
  provider: string;
  started_at: string;
  lines: string[];
  stage: string;
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

const ui = {
  data: null as State | null,
  route: "",
  filter: "all",
  query: "",
  chartMode: "outcomes" as "outcomes" | "spend" | "time",
  chartRange: 30,
  detail: null as { id: string; job: Job; patch: string; evidence: string } | null,
  diffFile: 0,
  diffWrap: false,
  openCheck: null as string | null,
  drawer: null as null | {
    mode: "new" | "live";
    pkg: string;
    version: string;
    provider: string;
    budget: number;
    liveId?: string;
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

const verified = (r: Run) =>
  r.checks.some((c) => c.name !== "install" && (c.after === true || c.sameFailures));
const installed = (r: Run) => r.checks.find((c) => c.name === "install")?.before === true;
const isGood = (r: Run) => r.state === "ready" || r.state === "safe";

function windowed(runs: Run[], fromDays: number, toDays: number) {
  const now = Date.now();
  return runs.filter((r) => {
    const age = (now - Date.parse(r.created_at)) / 86_400_000;
    return age >= fromDays && age < toDays;
  });
}
function delta(cur: number, prev: number, invert = false) {
  if (!prev && !cur) return `<span class="delta flat">—</span>`;
  if (!prev) return `<span class="delta up">new</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const good = invert ? pct <= 0 : pct >= 0;
  return `<span class="delta ${pct === 0 ? "flat" : good ? "up" : "down"}">${pct > 0 ? "▲" : pct < 0 ? "▼" : ""} ${Math.abs(pct)}%</span>`;
}
/** A trend line from the first run to now, in equal steps (adapts to how long you have used it). */
function series(runs: Run[], f: (rs: Run[]) => number, points = 14) {
  const now = Date.now();
  const first = Math.min(now, ...runs.map((r) => Date.parse(r.created_at)));
  const span = Math.max(now - first, 3_600_000);
  const step = span / points;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const a = first + i * step;
    const b = i === points - 1 ? now + 1 : a + step;
    out.push(
      f(
        runs.filter((r) => {
          const t = Date.parse(r.created_at);
          return t >= a && t < b;
        }),
      ),
    );
  }
  return out;
}
const greeting = () => {
  const h = new Date().getHours();
  return h < 5
    ? "Working late"
    : h < 12
      ? "Good morning"
      : h < 18
        ? "Good afternoon"
        : "Good evening";
};
const today = () =>
  new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

function toast(msg: string, bad = false) {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    document.body.append(wrap);
  }
  const t = document.createElement("div");
  t.className = `toast ${bad ? "bad" : ""}`;
  t.innerHTML = `${icon(bad ? "alert" : "check")}<span>${esc(msg)}</span>`;
  wrap.append(t);
  setTimeout(() => {
    t.style.transition = "opacity 300ms, transform 300ms";
    t.style.opacity = "0";
    t.style.transform = "translateY(8px)";
    setTimeout(() => t.remove(), 320);
  }, 3600);
}

// ───────────── shell ─────────────

function sidebar(d: State) {
  const r = d.repo;
  const ready = d.runs.filter((x) => x.state === "ready").length;
  const route = ui.route.split("/")[0] || "overview";
  const link = (id: string, label: string, ic: string, extra = "") =>
    `<a href="#/${id === "overview" ? "" : id}" class="${route === id ? "active" : ""}">${icon(ic)}<span>${label}</span>${extra}</a>`;
  const liveN = [...ui.live.values()].filter((l) => !l.done).length;
  const prov = d.env.providers.find((p) => p.id === d.env.defaultProvider);
  return `<aside class="sidebar">
    <div class="brand">${BRAND_MARK}<span class="brand-word">bumpsmith</span><span class="brand-pill">Local</span></div>
    <div class="ctx-card">
      <div class="ctx-tile">${esc(r.name.slice(0, 2).toUpperCase())}</div>
      <div style="min-width:0">
        <div class="ctx-name">${esc(r.name)}</div>
        <div class="ctx-sub"><span class="dot ${r.changes ? "warn" : r.changes === 0 ? "" : "idle"}"></span>${esc(r.branch ?? "no git")}${r.changes === null ? "" : r.changes ? ` · ${r.changes} changed` : " · clean"}</div>
      </div>
    </div>
    <nav class="nav">
      ${link("overview", "Overview", "grid")}
      ${link("runs", "Upgrades", "layers", liveN ? `<span class="count">${liveN} live</span>` : ready ? `<span class="count">${ready}</span>` : "")}
      ${link("deps", "Dependencies", "package", d.debt ? `<span class="count soft">${d.debt.behind.filter((b) => b.majorsBehind > 0).length}</span>` : "")}
      <div class="nav-label">This repository</div>
      ${link("safety", "Safety & evidence", "shield")}
      ${link("sandbox", "Sandbox & models", "cpu")}
    </nav>
    <div class="side-foot">
      <div class="who" data-act="go" data-to="sandbox">
        <div class="who-av">${prov?.label === "Codex" ? "CX" : prov?.label.startsWith("Claude") ? "CC" : "AI"}</div>
        <div style="min-width:0;flex:1">
          <div class="who-name">${esc(prov?.label ?? d.env.defaultProvider)}</div>
          <div class="who-sub"><span class="dot ${d.env.docker ? "" : "bad"}"></span>${d.env.docker ? `Sandbox ready · Docker ${esc(d.env.docker)}` : "Docker is not running"}</div>
        </div>
        ${icon("chevron")}
      </div>
    </div>
  </aside>`;
}

function topbar(crumbs: string[]) {
  const ready = ui.data?.runs.filter((r) => r.state === "ready").length ?? 0;
  return `<header class="topbar">
    <div class="crumbs">${crumbs.map((c, i) => (i === crumbs.length - 1 ? `<b>${esc(c)}</b>` : `<span>${esc(c)}</span><span class="sep">/</span>`)).join("")}</div>
    <div class="spacer"></div>
    <div class="search" data-act="palette">${icon("search")}<span>Search upgrades and packages</span><kbd>⌘K</kbd></div>
    <button class="icon-btn" data-act="go" data-to="runs" title="Ready to apply">${icon("bell")}${ready ? `<span class="badge">${ready}</span>` : ""}</button>
    <button class="btn ember" data-act="new">${icon("plus")}<span class="hide-sm">New upgrade</span></button>
  </header>`;
}

// ───────────── overview ─────────────

function overview(d: State) {
  const runs = d.runs;
  if (!runs.length && !ui.live.size) return emptyOverview(d);
  const last7 = windowed(runs, 0, 7);
  const prev7 = windowed(runs, 7, 14);
  const readyN = runs.filter((r) => r.state === "ready").length;
  const hero = runs.find((r) => r.state === "ready") ?? runs[0];
  const verifiedPct = (rs: Run[]) =>
    rs.length ? Math.round((rs.filter(verified).length / rs.length) * 100) : 0;
  const spend = (rs: Run[]) => rs.reduce((n, r) => n + r.cost_usd, 0);
  const goodTimes = runs.filter(isGood).map((r) => r.duration_ms);
  const kpis = [
    {
      ic: "layers",
      t: "Upgrades run",
      v: String(runs.length),
      s: series(runs, (rs) => rs.length),
      d: delta(last7.length, prev7.length),
      f: "vs previous 7 days",
    },
    {
      ic: "check",
      t: "Ready to apply",
      v: String(readyN),
      s: series(runs, (rs) => rs.filter((r) => r.state === "ready").length),
      d: delta(
        last7.filter((r) => r.state === "ready").length,
        prev7.filter((r) => r.state === "ready").length,
      ),
      f: "verified and reviewed",
    },
    {
      ic: "wrench",
      t: "Lines fixed by the agent",
      v: runs.reduce((n, r) => n + r.agent_lines, 0).toLocaleString(),
      s: series(runs, (rs) => rs.reduce((n, r) => n + r.agent_lines, 0)),
      d: "",
      f: `${runs.reduce((n, r) => n + r.edited_by_agent, 0)} files edited across ${runs.filter((r) => r.edited_by_agent).length} upgrades`,
    },
    {
      ic: "shield",
      t: "Verified in the sandbox",
      v: `${verifiedPct(runs)}<small>%</small>`,
      s: series(runs, (rs) => verifiedPct(rs)),
      d: delta(verifiedPct(last7), verifiedPct(prev7)),
      f: "a check passed after the bump",
    },
    {
      ic: "dollar",
      t: "Model spend",
      v: money(spend(runs)),
      s: series(runs, spend),
      ink: true,
      d: delta(spend(last7), spend(prev7), true),
      f: "API-equivalent, all time",
    },
    {
      ic: "clock",
      t: "Median time to green",
      v: goodTimes.length ? dur(median(goodTimes)) : "—",
      s: series(runs, (rs) => median(rs.filter(isGood).map((r) => r.duration_ms / 60000))),
      ink: true,
      d: "",
      f: "from start to a verified result",
    },
  ];
  const bs = buckets(runs, ui.chartRange);
  const total =
    ui.chartMode === "outcomes"
      ? `${bs.reduce((n, b) => n + b.runs.length, 0)}`
      : ui.chartMode === "spend"
        ? money(bs.reduce((n, b) => n + b.runs.reduce((m, r) => m + r.cost_usd, 0), 0))
        : dur(median(bs.flatMap((b) => b.runs.filter(isGood).map((r) => r.duration_ms))));
  return `<div class="page">
    <div class="hello in">
      <div>
        <h1>${greeting()}${d.repo.user ? `, ${esc(d.repo.user.split(" ")[0])}` : ""}</h1>
        <p>${today()} · ${readyN ? `<b style="color:var(--ink)">${readyN} upgrade${readyN === 1 ? "" : "s"} ready to apply</b>` : "nothing waiting on you"} in ${esc(d.repo.name)}</p>
      </div>
      <div class="actions">
        <button class="btn" data-act="scan" ${ui.busy.has("scan") ? "disabled" : ""}>${icon("scan")}${ui.busy.has("scan") ? "Scanning…" : "Scan dependencies"}</button>
        ${hero ? `<a class="btn dark" href="#/runs/${esc(hero.id)}">${icon("eye")}Review latest</a>` : ""}
      </div>
    </div>
    ${liveBanner()}
    ${hero ? heroCard(hero) : ""}
    <div class="grid g-kpi">
      ${kpis
        .map(
          (k, i) => `<div class="card kpi in" style="--dl:${80 + i * 50}ms">
        <div class="kpi-h"><span class="ico">${icon(k.ic)}</span>${k.t}</div>
        <div class="kpi-v num">${k.v}</div>
        ${sparkline(k.s, !!k.ink)}
        <div class="kpi-f">${k.d}${k.f}</div>
      </div>`,
        )
        .join("")}
    </div>
    <div class="grid g-main mt">
      <div class="card in" style="--dl:200ms">
        <div class="card-h">
          <div><div class="card-s" style="margin:0">${ui.chartMode === "outcomes" ? "Upgrades" : ui.chartMode === "spend" ? "Model spend" : "Median time to green"} · ${ui.chartRange ? `last ${ui.chartRange} days` : "all time"}</div><div class="big-num num">${total}</div></div>
          <div class="right">
            <div class="seg">${(["outcomes", "spend", "time"] as const).map((m) => `<button data-act="chart-mode" data-v="${m}" class="${ui.chartMode === m ? "on" : ""}">${m === "outcomes" ? "Outcomes" : m === "spend" ? "Spend" : "Time"}</button>`).join("")}</div>
            <div class="seg">${[7, 30, 0].map((n) => `<button data-act="chart-range" data-v="${n}" class="${ui.chartRange === n ? "on" : ""}">${n ? `${n}D` : "All"}</button>`).join("")}</div>
          </div>
        </div>
        <div id="chart" class="${replayChart ? "replay" : ""}">${barChart(bs, ui.chartMode)}</div>
        ${ui.chartMode === "outcomes" ? `<div class="legend">${OUTCOME_GROUPS.map((g) => `<span><i style="background:${g.color}"></i>${g.label}</span>`).join("")}</div>` : ""}
      </div>
      ${activityCard(d)}
    </div>
    <div class="grid g-half mt">
      ${recentTable(runs.slice(0, 7), "Recent upgrades", `${runs.length} in this repository`)}
      <div class="grid" style="align-content:start">
        ${spendCard(runs)}
        ${debtMini(d)}
      </div>
    </div>
    <div class="grid g-half mt">
      ${heatCard(runs)}
      ${funnelCard(runs)}
    </div>
  </div>`;
}

function heroCard(r: Run) {
  const checks = r.checks.filter((c) => c.name !== "install");
  const passed = checks.filter((c) => c.after === true || c.sameFailures).length;
  const s = Math.round(r.duration_ms / 1000);
  const time =
    s >= 3600
      ? `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`
      : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `<div class="card hero in" style="--dl:40ms">
    ${pkgTile(r)}
    <div style="min-width:0;position:relative;z-index:1">
      <div class="hero-title"><h2>${esc(r.package)}</h2>${statePill(r.state)}${confPill(r.confidence)}</div>
      <div class="hero-meta">
        <span class="arrow-v">${esc(r.from ?? "?")} → <b>${esc(r.to)}</b></span>
        <span>${icon("file")}${r.files} file${r.files === 1 ? "" : "s"} · ${r.lines} lines</span>
        <span>${icon("wrench")}${r.rounds ? `${r.rounds} fix round${r.rounds === 1 ? "" : "s"}` : "no code change needed"}</span>
        <span>${icon("clock")}${agoLong(r.created_at)}</span>
      </div>
      <div class="hero-bar"><div class="bar ok"><i style="width:${checks.length ? (passed / checks.length) * 100 : 0}%"></i></div><span class="lbl num">${passed} / ${checks.length} checks verified</span></div>
    </div>
    <div class="hero-right">
      <div class="lbl">Time to ${isGood(r) ? "green" : "result"} · min : sec</div>
      ${flip(time, "lg")}
      <div><a class="link" href="#/runs/${esc(r.id)}">Open upgrade ${icon("arrowR")}</a></div>
    </div>
  </div>`;
}

function activityCard(d: State) {
  const live = [...ui.live.values()].filter((l) => !l.done);
  const items = d.runs.slice(0, live.length ? 5 : 6).map((r) => {
    const st = stateOf(r.state);
    const ic =
      r.state === "ready"
        ? "check"
        : r.state === "safe"
          ? "shield"
          : r.state === "blocked_policy"
            ? "lock"
            : r.state === "failed_infra"
              ? "x"
              : "alert";
    return `<div class="feed-i" data-act="open-run" data-id="${esc(r.id)}">
      <div class="feed-ic ${st.tone}">${icon(ic)}</div>
      <div style="min-width:0"><div class="feed-t">${esc(r.package)} · ${esc(r.from ?? "?")} → ${esc(r.to)}</div><div class="feed-s">${esc(r.reason ?? st.label)}</div></div>
      <div class="feed-w">${ago(r.created_at)}</div>
    </div>`;
  });
  const liveItems = live.map(
    (l) => `<div class="feed-i" data-act="open-live" data-id="${l.id}">
      <div class="feed-ic ember">${icon("bolt")}</div>
      <div style="min-width:0"><div class="feed-t">${esc(l.package)} → ${esc(l.version)}</div><div class="feed-s">${esc(STAGES.find((s) => s.id === l.stage)?.label ?? l.stage)} · ${esc(l.lines[l.lines.length - 1] ?? "starting")}</div></div>
      <div class="feed-w">live</div>
    </div>`,
  );
  return `<div class="card in" style="--dl:240ms">
    <div class="card-h"><div><div class="live-h"><span class="dot ${live.length ? "live" : ""}"></span>${live.length ? "Live" : "Activity"}</div><div class="card-s">${live.length ? `${live.length} upgrade${live.length === 1 ? "" : "s"} running in the sandbox` : "Latest results in this repository"}</div></div>
    <div class="right"><a class="btn sm" href="#/runs">All upgrades</a></div></div>
    <div class="feed">${[...liveItems, ...items].join("")}</div>
  </div>`;
}

function recentTable(runs: Run[], title: string, sub: string, full = false) {
  return `<div class="card flush in" style="--dl:260ms">
    <div class="card-h"><div><div class="card-t">${title}</div><div class="card-s">${esc(sub)}</div></div>${full ? "" : `<div class="right"><a class="btn sm" href="#/runs">View all</a></div>`}</div>
    <div class="table-scroll"><table class="t ${full ? "" : "compact"}">
      <thead><tr><th>Package</th><th>Upgrade</th><th>Status</th><th>Checks</th>${full ? `<th class="r">Changes</th><th class="r">Cost</th>` : ""}<th class="r">When</th></tr></thead>
      <tbody>${runs
        .map(
          (r) => `<tr data-act="open-run" data-id="${esc(r.id)}">
        <td><div class="pkg-cell">${pkgTile(r, "sm")}<div><div class="pkg-name">${esc(r.package)}</div><div class="pkg-sub">${esc(r.ecosystem)}</div></div></div></td>
        <td class="mono ver">${esc(r.from ?? "?")} → <b>${esc(r.to)}</b></td>
        <td>${statePill(r.state)}</td>
        <td><span class="checks" title="${esc(r.checks.map((c) => `${c.name}: ${c.before === null ? "—" : c.before ? "pass" : "fail"} → ${c.after === null ? "not run" : c.after ? "pass" : c.sameFailures ? "same failures" : "fail"}`).join("\n"))}">${r.checks.map((c) => `<i class="${cellOf(c) === "ok" ? "ok" : cellOf(c) === "same" ? "same" : cellOf(c) === "reg" ? "bad" : cellOf(c) === "pre" ? "pre" : ""}"></i>`).join("")}</span></td>
        ${full ? `<td class="r mono muted">${r.files ? `${r.files} file${r.files === 1 ? "" : "s"} · ${r.lines}` : "—"}</td><td class="r mono">${money(r.cost_usd)}</td>` : ""}
        <td class="r muted">${ago(r.created_at)}</td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>
  </div>`;
}

function spendCard(runs: Run[]) {
  const month = new Date();
  const monthRuns = runs.filter((r) => {
    const d = new Date(r.created_at);
    return d.getMonth() === month.getMonth() && d.getFullYear() === month.getFullYear();
  });
  const total = monthRuns.reduce((n, r) => n + r.cost_usd, 0);
  const roles: Record<string, number> = {};
  for (const r of monthRuns)
    for (const [k, v] of Object.entries(r.cost_by_role)) roles[k] = (roles[k] ?? 0) + v;
  const ready = monthRuns.filter((r) => r.state === "ready").length;
  const colors: Record<string, string> = {
    extractor: "#ffb48c",
    fixer: "#f2541b",
    reviewer: "#7a3416",
  };
  const sum = Object.values(roles).reduce((a, b) => a + b, 0) || 1;
  const digits = total.toFixed(2).padStart(5, "0");
  return `<div class="card dark-card in" style="--dl:300ms">
    <div class="card-h" style="margin-bottom:14px"><div class="card-s" style="display:flex;gap:8px;align-items:center;margin:0">${icon("dollar")} Model spend in ${month.toLocaleDateString(undefined, { month: "long" })}</div><span class="chip">${ready} ready</span></div>
    <div style="display:flex;align-items:center;gap:6px">${flip(`$${digits}`, "light")}</div>
    <div class="roles">${
      Object.entries(roles)
        .map(
          ([k, v]) => `<i style="width:${(v / sum) * 100}%;background:${colors[k] ?? "#555"}"></i>`,
        )
        .join("") || `<i style="width:100%;background:#2a2927"></i>`
    }</div>
    <div class="cols">
      ${["extractor", "fixer", "reviewer"].map((k) => `<div><div class="k" style="display:flex;gap:6px;align-items:center"><i style="width:8px;height:8px;border-radius:2px;background:${colors[k]}"></i>${k === "extractor" ? "Changelog" : k === "fixer" ? "Fixer" : "Review"}</div><div class="v">${money(roles[k] ?? 0)}</div></div>`).join("")}
    </div>
    <div class="k" style="margin:-4px 0 16px">${ready ? `${money(total / Math.max(ready, 1))} per ready upgrade` : "Spend shows API-equivalent cost; subscriptions are not billed per run"}</div>
    <a class="btn ember" href="#/runs">${icon("layers")}View upgrades</a>
  </div>`;
}

function debtMini(d: State) {
  const behind = (d.debt?.behind ?? [])
    .filter((b) => b.majorsBehind > 0)
    .sort((a, b) => b.majorsBehind - a.majorsBehind)
    .slice(0, 4);
  return `<div class="card in" style="--dl:340ms">
    <div class="card-h"><div><div class="card-t">Upgrade debt</div><div class="card-s">${d.debt ? `${behind.length ? "Most majors behind" : "Nothing major behind"} · scanned ${agoLong(d.debt.generatedAt)}` : "Scan to see what is behind"}</div></div>
      <div class="right"><a class="btn sm" href="#/deps">All</a></div></div>
    ${
      d.debt
        ? behind
            .map(
              (
                b,
              ) => `<div class="feed-i" data-act="new" data-pkg="${esc(b.package)}" data-ver="${esc(b.latest ?? "")}">
        ${pkgTile({ package: b.package, ecosystem: d.repo.ecosystem ?? "npm" }, "sm")}
        <div style="min-width:0"><div class="feed-t">${esc(b.package)}</div><div class="feed-s mono">${esc(b.current ?? "?")} → ${esc(b.latest ?? "?")}</div></div>
        <span class="pill ${b.majorsBehind >= 2 ? "bad" : "warn"} no-dot">${b.majorsBehind} major${b.majorsBehind === 1 ? "" : "s"}</span>
      </div>`,
            )
            .join("") || `<div class="card-s">Every direct dependency is on its latest major.</div>`
        : `<button class="btn" data-act="scan" style="width:100%;justify-content:center">${icon("scan")}Scan dependencies</button>`
    }
  </div>`;
}

const CHECK_ROWS = ["install", "build", "typecheck", "lint", "test"];
function heatCard(runs: Run[]) {
  const cols = runs.slice(0, 24).reverse();
  const n = Math.max(cols.length, 1);
  return `<div class="card in" style="--dl:360ms">
    <div class="card-h"><div><div class="card-t">Check health</div><div class="card-s">Before and after the bump, for the last ${cols.length} upgrades</div></div></div>
    <div class="heat" style="grid-template-columns:auto repeat(${n}, minmax(0,1fr))">
      ${CHECK_ROWS.map(
        (name, ri) =>
          `<div class="lbl">${name}</div>${cols
            .map((r, ci) => {
              const c = r.checks.find((x) => x.name === name);
              const cls = cellOf(c);
              return `<div class="cell ${cls}" style="animation-delay:${(ri * n + ci) * 8}ms" data-act="open-run" data-id="${esc(r.id)}" data-hint="${esc(`${r.package} ${r.to} · ${name}: ${!c || c.before === null ? "not run" : `${c.before ? "passed" : "failed"} before, ${c.after === null ? "not re-run" : c.after ? "passes" : c.sameFailures ? "same failures" : "fails"} after`}`)}"></div>`;
            })
            .join("")}`,
      ).join("")}
    </div>
    <div class="heat-legend">
      <span><i style="background:var(--ok)"></i>Passes after</span>
      <span><i style="background:#9bd0b0"></i>Same failures as before</span>
      <span><i style="background:#edd3a5"></i>Already failing</span>
      <span><i style="background:var(--bad)"></i>Broken by the bump</span>
      <span><i style="background:var(--chalk-2)"></i>No such check</span>
    </div>
  </div>`;
}

function funnelCard(runs: Run[]) {
  const steps = [
    { t: "Upgrades started", n: runs.length },
    { t: "Dependencies installed", n: runs.filter(installed).length },
    { t: "Verified in the sandbox", n: runs.filter(verified).length },
    { t: "Ready or safe", n: runs.filter(isGood).length },
  ];
  const top = Math.max(steps[0]?.n ?? 1, 1);
  return `<div class="card in" style="--dl:400ms">
    <div class="card-h"><div><div class="card-t">Pipeline</div><div class="card-s">Where upgrades stop, and how many reach a verified result</div></div></div>
    ${steps
      .map((s, i) => {
        return `<div class="fn-step"><div class="fn-top"><span>${s.t}</span><b>${s.n} <span>· ${Math.round((s.n / top) * 100)}%</span></b></div>
        <div class="fn-bar"><i style="width:${(s.n / top) * 100}%;animation-delay:${i * 120}ms;${i === steps.length - 1 ? "background:var(--ember)" : i ? `background:${["#0b0b0c", "#3b3a37", "#6d6a64"][i]}` : ""}"></i></div>
        ${i < steps.length - 1 && steps[i + 1] ? `<div class="fn-drop">↓ ${steps[i + 1] && s.n ? Math.round(((s.n - (steps[i + 1]?.n ?? 0)) / s.n) * 100) : 0}% stop here</div>` : ""}</div>`;
      })
      .join("")}
  </div>`;
}

function emptyOverview(d: State) {
  return `<div class="page"><div class="hello in"><div><h1>${greeting()}${d.repo.user ? `, ${esc(d.repo.user.split(" ")[0])}` : ""}</h1><p>${today()} · ${esc(d.repo.name)}</p></div></div>
    <div class="card in"><div class="empty">
      <svg class="anvil" viewBox="0 0 120 90"><path d="M14 40h80c0 10-8 16-18 16H46l-4 14h36v8H30v-8h4l4-14C24 56 14 50 14 40Z" fill="#0b0b0c"/><path d="M94 40h12c0 6-4 9-12 9Z" fill="#2b2a28"/><circle cx="60" cy="22" r="4" fill="#f2541b"><animate attributeName="opacity" values="1;.2;1" dur="1.6s" repeatCount="indefinite"/></circle><circle cx="74" cy="14" r="2.5" fill="#ff9a6b"><animate attributeName="cy" values="16;6;16" dur="1.8s" repeatCount="indefinite"/></circle><circle cx="48" cy="12" r="2" fill="#ffb48c"><animate attributeName="cy" values="14;4;14" dur="2.1s" repeatCount="indefinite"/></circle></svg>
      <h3>No upgrades yet</h3>
      <p>Pick a dependency and Bumpsmith upgrades it in a sandbox, fixes what breaks, and proves it with your own checks. Results land here.</p>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        <button class="btn ember" data-act="new">${icon("plus")}Start an upgrade</button>
        <button class="btn" data-act="scan">${icon("scan")}Scan dependencies</button>
      </div>
      <p style="margin-top:22px;font-size:13px">Or from the terminal:</p><pre>bumpsmith fix zod@4.1.0</pre>
    </div></div></div>`;
}

function liveBanner() {
  const live = [...ui.live.values()].filter((l) => !l.done);
  if (!live.length) return "";
  return live
    .map(
      (
        l,
      ) => `<div class="card in" style="margin-bottom:18px;display:flex;align-items:center;gap:16px;cursor:pointer;border-color:rgba(242,84,27,.35)" data-act="open-live" data-id="${l.id}">
      <span class="dot live"></span><div style="flex:1;min-width:0"><b>${esc(l.package)} → ${esc(l.version)}</b><div class="card-s" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(STAGES.find((s) => s.id === l.stage)?.label ?? l.stage)} · ${esc(l.lines[l.lines.length - 1] ?? "starting")}</div></div>
      <span class="btn sm">Watch live ${icon("arrowR")}</span></div>`,
    )
    .join("");
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
    <div class="hello in"><div><h1>Upgrades</h1><p>Every upgrade Bumpsmith ran here, with its proof. Stored in <span class="mono" style="font-size:13px">${esc(d.runsDir.replace(d.repo.path, "."))}</span></p></div>
      <div class="actions"><button class="btn ember" data-act="new">${icon("plus")}New upgrade</button></div></div>
    ${liveBanner()}
    <div class="toolbar in" style="--dl:60ms">
      <div class="chips">${groups.map(([id, label, fn]) => `<button class="chip-f ${ui.filter === id ? "on" : ""}" data-act="filter" data-v="${id}">${label}<span>${d.runs.filter(fn).length}</span></button>`).join("")}</div>
      <div class="spacer"></div>
      <input class="input" id="q" placeholder="Filter by package or version" value="${esc(ui.query)}" style="width:260px" />
    </div>
    ${rows.length ? recentTable(rows, "Results", `${rows.length} of ${d.runs.length}`, true) : `<div class="card"><div class="empty"><h3>Nothing here</h3><p>No upgrade matches this filter.</p></div></div>`}
  </div>`;
}

// ───────────── detail ─────────────

const STEP_DEFS = [
  { t: "Change record", ic: "book" },
  { t: "Impact", ic: "search" },
  { t: "Baseline", ic: "flask" },
  { t: "Bump", ic: "package" },
  { t: "Fix", ic: "wrench" },
  { t: "Review", ic: "eye" },
  { t: "Result", ic: "shield" },
];

function detailSteps(job: Job) {
  const s: { st: string; sub: string }[] = [];
  const cr = job.change_record;
  s.push(
    cr
      ? {
          st: "done",
          sub: `${cr.changes.length} breaking change${cr.changes.length === 1 ? "" : "s"} from ${cr.sources?.length ?? 0} source${cr.sources?.length === 1 ? "" : "s"}`,
        }
      : {
          st: job.gate && !job.gate.allowed ? "fail" : "",
          sub: job.gate && !job.gate.allowed ? "stopped at the release gate" : "not built",
        },
  );
  const im = job.impact;
  s.push(
    im
      ? {
          st: "done",
          sub: `${im.items.length} place${im.items.length === 1 ? "" : "s"} in your code · ${im.upgrade_class}`,
        }
      : { st: "", sub: "—" },
  );
  const base = job.baseline as { name: string; passed: boolean }[] | undefined;
  s.push(
    base
      ? {
          st: base.find((c) => c.name === "install")?.passed ? "done" : "fail",
          sub: `${base.filter((c) => c.passed).length} of ${base.length} checks pass before`,
        }
      : { st: "", sub: "—" },
  );
  s.push(
    job.after_bump
      ? { st: "done", sub: `${esc(job.from ?? "?")} → ${esc(job.input.to)}` }
      : { st: base ? "fail" : "", sub: base ? "could not apply" : "—" },
  );
  const rounds = job.rounds?.length ?? 0;
  s.push(
    job.after_bump
      ? {
          st: "done",
          sub: rounds
            ? `${rounds} round${rounds === 1 ? "" : "s"} · ${job.edits?.length ?? 0} file${job.edits?.length === 1 ? "" : "s"} edited`
            : "no code change needed",
        }
      : { st: "", sub: "—" },
  );
  s.push(
    job.review
      ? {
          st: job.review.verdict === "approve" ? "done" : "warn",
          sub: job.review.verdict === "approve" ? "approved" : "changes requested",
        }
      : { st: "", sub: "not reviewed" },
  );
  const tone = stateOf(job.state).tone;
  s.push({
    st: tone === "ok" ? "done" : tone === "bad" ? "fail" : "warn",
    sub: stateOf(job.state).label,
  });
  const lastDone = s.reduce((n, x, i) => (x.st ? i : n), 0);
  return `<div class="steps">
    <div class="prog" style="width:${(lastDone / (STEP_DEFS.length - 1)) * 88}%"></div>
    ${STEP_DEFS.map((d, i) => `<div class="step ${s[i]?.st ?? ""}"><div class="step-dot">${icon(s[i]?.st === "fail" ? "x" : s[i]?.st === "warn" ? "alert" : s[i]?.st === "done" ? "check" : d.ic)}</div><div class="step-n">0${i + 1}</div><div class="step-t">${d.t}</div><div class="step-s">${s[i]?.sub ?? ""}</div></div>`).join("")}
  </div>`;
}

function detailPage(d: State) {
  const det = ui.detail;
  if (!det)
    return `<div class="page"><div class="skel" style="height:120px;margin-bottom:18px"></div><div class="skel" style="height:420px"></div></div>`;
  const { job, patch } = det;
  const run = d.runs.find((r) => r.id === det.id);
  const files = parseDiff(patch);
  const edited = new Set<string>((job.edits ?? []).map((e: { path: string }) => e.path));
  const cmp = (job.verdict?.comparisons ?? []) as {
    name: string;
    baseline: boolean | null;
    after: boolean | null;
    flaky: boolean;
    regression: boolean;
    sameFailures?: { failing: string[]; passed: number };
    newFailures?: string[];
  }[];
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
  const canApply = job.state === "ready" && patch.trim().length > 0;
  const usage = (job.usage ?? []) as {
    role: string;
    api_equivalent_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
  }[];
  const byRole: Record<string, { usd: number; tin: number; tout: number }> = {};
  for (const u of usage) {
    const x = byRole[u.role] ?? { usd: 0, tin: 0, tout: 0 };
    byRole[u.role] = x;
    x.usd += u.api_equivalent_usd;
    x.tin += u.input_tokens + u.cache_read_input_tokens;
    x.tout += u.output_tokens;
  }
  const maxRole = Math.max(...Object.values(byRole).map((x) => x.usd), 0.0001);
  const changes = (job.change_record?.changes ?? []) as {
    id: string;
    kind: string;
    symbols: string[];
    instruction: string;
    confidence: string;
    before: string;
    after: string;
  }[];
  const pass = (v: boolean | null | undefined) =>
    v === null || v === undefined
      ? `<span class="pill no-dot">not run</span>`
      : v
        ? `<span class="pill ok">pass</span>`
        : `<span class="pill bad">fail</span>`;
  return `<div class="page">
    <a class="back" href="#/runs">${icon("arrowL")}All upgrades</a>
    <div class="d-head in">
      ${pkgTile({ package: job.input.packageName, ecosystem: job.input.ecosystem ?? run?.ecosystem ?? "npm", to: job.input.to })}
      <div style="min-width:0">
        <h1>${esc(job.input.packageName)}</h1>
        <div class="meta"><span class="arrow-v">${esc(job.from ?? job.input.from ?? "?")} → <b>${esc(job.input.to)}</b></span>${statePill(job.state)}${confPill(job.confidence ?? null)}<span>·</span><span>${agoLong(job.created_at)}</span><span>·</span><span class="mono" style="font-size:12.5px">${esc(job.provider)}${job.model ? ` · ${esc(job.model)}` : ""}</span></div>
      </div>
      <div class="actions">
        <button class="btn ${canApply ? "ember" : ""}" data-act="apply" data-id="${esc(det.id)}" ${patch.trim() ? "" : "disabled"} title="${canApply ? "Apply to your working tree and stage it" : "Only verified results apply in one click; you can still copy the patch"}">${icon("apply")}${ui.busy.has(`apply:${det.id}`) ? "Applying…" : "Apply patch"}</button>
        <button class="btn" data-act="copy-patch" ${patch.trim() ? "" : "disabled"}>${icon("copy")}Copy patch</button>
        <button class="btn ghost danger" data-act="delete" data-id="${esc(det.id)}" title="Delete this run">${icon("trash")}</button>
      </div>
    </div>
    <div class="card in" style="--dl:60ms;padding:22px 20px 20px">${detailSteps(job)}</div>
    <div class="grid g-half mt">
      <div class="card flush in" style="--dl:120ms">
        <div class="card-h"><div><div class="card-t">Checks</div><div class="card-s">Your own commands, run in the sandbox before and after. Click one for its output.</div></div></div>
        <div class="table-scroll"><table class="t"><thead><tr><th>Check</th><th>Before</th><th>After</th><th>What it means</th><th class="r">Time</th></tr></thead><tbody>
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
                  ? `same ${c.sameFailures.failing.length} failing test${c.sameFailures.failing.length === 1 ? "" : "s"} as before; ${c.sameFailures.passed} pass`
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
                        : "still failing, as before";
            const open = ui.openCheck === n;
            return `<tr data-act="toggle-check" data-v="${esc(n)}"><td class="mono" style="font-weight:600">${esc(n)}</td><td>${pass(c?.baseline ?? b?.passed)}</td><td>${c?.sameFailures ? `<span class="pill ok no-dot">same failures</span>` : pass(c?.after)}</td><td class="muted" style="font-size:13px">${meaning}</td><td class="r mono muted">${b ? dur(b.duration_ms) : ""}</td></tr>
            ${
              open
                ? `<tr><td colspan="5" style="padding:0 20px 16px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">${[
                    ["Before", b],
                    ["After", a],
                  ]
                    .map(
                      ([lbl, x]) =>
                        `<div><div class="card-s" style="margin:6px 0">${lbl} · <span class="mono">${esc((x as typeof b)?.command?.slice(0, 80) ?? "")}</span></div><div class="term" style="height:220px">${esc(((x as typeof b)?.output_tail ?? "no output").slice(-4000))}</div></div>`,
                    )
                    .join("")}</div></td></tr>`
                : ""
            }`;
          })
          .join("")}
        </tbody></table></div>
      </div>
      <div class="card in" style="--dl:160ms">
        <div class="card-h"><div><div class="card-t">What happened</div><div class="card-s">In plain words, from the run</div></div></div>
        <div class="reasons">${
          (job.notes as string[]).length || job.error
            ? [...(job.error ? [`Stopped: ${job.error}`] : []), ...(job.notes as string[])]
                .slice(0, 10)
                .map((n) => {
                  const warn =
                    /fail|not verified|unsupported|could not|stopped|blocked|malicious|timed out|longer than|not re-run|conflict/i.test(
                      n,
                    );
                  return `<div class="reason ${warn ? "warn" : "ok"}"><div class="ri">${icon(warn ? "alert" : "info")}</div><div>${md(n)}</div></div>`;
                })
                .join("")
            : `<div class="reason ok"><div class="ri">${icon("check")}</div><div>Everything went to plan: verified in the sandbox with no surprises.</div></div>`
        }</div>
      </div>
    </div>
    <div class="card flush in mt" style="--dl:200ms">
      <div class="card-h"><div><div class="card-t">The change</div><div class="card-s">${files.length ? `${files.length} file${files.length === 1 ? "" : "s"} · <span style="color:var(--ok)">+${files.reduce((n, f) => n + f.added, 0)}</span> <span style="color:var(--bad)">−${files.reduce((n, f) => n + f.removed, 0)}</span> · <span style="display:inline-flex;gap:6px;align-items:center"><i class="fdot agent"></i>edited by the agent</span> <span style="display:inline-flex;gap:6px;align-items:center;margin-left:8px"><i class="fdot lock"></i>lockfile</span>` : "No changes"}</div></div>
        <div class="right"><button class="btn sm ${ui.diffWrap ? "dark" : ""}" data-act="wrap">${icon("wrap")}Wrap</button></div></div>
      ${files.length ? diffView(files, edited) : `<div class="diff-empty">This run produced no patch${job.state === "safe" ? ": the upgrade needed no change beyond what the package manager did, or nothing at all." : "."}</div>`}
    </div>
    <div class="grid g-half mt">
      <div class="card in" style="--dl:240ms">
        <div class="card-h"><div><div class="card-t">Breaking changes</div><div class="card-s">${job.change_record ? `Read from the changelog, release notes and API diff of ${esc(job.input.packageName)}` : "No change record for this run"}</div></div></div>
        ${
          changes.length
            ? changes
                .slice(0, 12)
                .map(
                  (c) =>
                    `<div class="change"><div class="change-h"><code>${esc(c.symbols?.join(", ") || c.id)}</code><span class="pill no-dot">${esc(c.kind.replace(/_/g, " "))}</span><span class="pill no-dot ${c.confidence === "high" ? "ok" : c.confidence === "medium" ? "info" : "warn"}">${esc(c.confidence)}</span></div><p>${md(c.instruction)}</p></div>`,
                )
                .join("")
            : `<div class="card-s">${job.change_record ? "None found between these versions." : "The run stopped before reading the changelog."}</div>`
        }
      </div>
      <div class="grid" style="align-content:start">
        <div class="card in" style="--dl:280ms">
          <div class="card-h"><div><div class="card-t">Cost</div><div class="card-s">API-equivalent; subscriptions are not billed per run</div></div><div class="right"><span class="big-num num" style="font-size:24px">${money(job.cost_usd ?? 0, 3)}</span></div></div>
          ${
            Object.entries(byRole)
              .map(
                ([k, v]) =>
                  `<div class="cost-row"><span>${k === "extractor" ? "Changelog" : k === "fixer" ? "Fixer" : k === "reviewer" ? "Review" : esc(k)}</span><div class="mini-bar"><i class="ember" style="width:${(v.usd / maxRole) * 100}%"></i></div><span class="mono">${money(v.usd, 3)}</span></div>`,
              )
              .join("") || `<div class="card-s">No model calls.</div>`
          }
          <dl class="kv" style="margin-top:14px"><dt>Duration</dt><dd>${dur(job.duration_ms ?? 0)}</dd><dt>Tokens</dt><dd>${Object.values(
            byRole,
          )
            .reduce((n, x) => n + x.tin, 0)
            .toLocaleString()} in · ${Object.values(byRole)
            .reduce((n, x) => n + x.tout, 0)
            .toLocaleString()} out</dd><dt>Run</dt><dd>${esc(det.id)}</dd></dl>
        </div>
        ${
          job.review
            ? `<div class="card in" style="--dl:320ms"><div class="card-h"><div><div class="card-t">Independent review</div><div class="card-s">A second model checks the diff against five rules</div></div><div class="right">${job.review.verdict === "approve" ? `<span class="pill ok">approved</span>` : `<span class="pill warn">changes requested</span>`}</div></div>
          ${job.review.summary ? `<div class="review-sum">${md(job.review.summary)}</div>` : ""}
          ${(job.review.criteria ?? []).map((c: { id: string; pass: boolean; reason: string }) => `<div class="cost-row" style="grid-template-columns:22px 1fr;align-items:start"><span style="color:${c.pass ? "var(--ok)" : "var(--bad)"}">${icon(c.pass ? "check" : "x")}</span><div><b style="font-weight:600">${esc(c.id.replace(/_/g, " "))}</b><div class="card-s" style="margin-top:2px">${md(c.reason)}</div></div></div>`).join("")}</div>`
            : ""
        }
      </div>
    </div>
  </div>`;
}

function diffView(files: DiffFile[], edited: Set<string>) {
  const i = Math.min(ui.diffFile, files.length - 1);
  const f = files[i] as DiffFile;
  const kind = (p: string) =>
    edited.has(p) ? "agent" : /lock|\.lock$|lock\.json$|lock\.yaml$/.test(p) ? "lock" : "";
  return `<div class="diff-wrap">
    <div class="files">${files.map((x, j) => `<button class="file-b ${j === i ? "on" : ""}" data-act="diff-file" data-v="${j}" title="${esc(x.path)}"><i class="fdot ${kind(x.path)}"></i><span class="nm">${esc(x.path)}</span><span class="st"><span class="a">+${x.added}</span> <span class="r">−${x.removed}</span></span></button>`).join("")}</div>
    <div class="diff ${ui.diffWrap ? "wrap" : ""}">
      <div class="diff-file-h">${icon("file")}<span>${esc(f.path)}</span>${kind(f.path) === "agent" ? `<span class="pill ember no-dot" style="margin-left:auto">edited by the agent</span>` : kind(f.path) === "lock" ? `<span class="pill no-dot" style="margin-left:auto">lockfile, written by the package manager</span>` : ""}</div>
      <table>${(f.lines.length > 1500 ? f.lines.slice(0, 1500) : f.lines)
        .map((l) =>
          l.kind === "hunk"
            ? `<tr class="hunk"><td colspan="3">${esc(l.text)}</td></tr>`
            : `<tr class="${l.kind}"><td class="ln">${l.a ?? ""}</td><td class="ln">${l.b ?? ""}</td><td class="code"><span class="mk">${l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>${highlight(l.text, f.path)}</td></tr>`,
        )
        .join(
          "",
        )}${f.lines.length > 1500 ? `<tr class="hunk"><td colspan="3">… ${f.lines.length - 1500} more lines (copy the patch to see all)</td></tr>` : ""}</table>
    </div>
  </div>`;
}

// ───────────── dependencies ─────────────

function depsPage(d: State) {
  const debt = d.debt;
  const deps = Object.entries(d.repo.dependencies);
  if (!debt)
    return `<div class="page"><div class="hello in"><div><h1>Dependencies</h1><p>${deps.length} direct dependencies${d.repo.packageManager ? ` · ${esc(d.repo.packageManager)}` : ""}</p></div></div>
      <div class="card in"><div class="empty"><div class="ico" style="width:56px;height:56px;margin:0 auto;border-radius:16px">${icon("scan")}</div><h3>Find your upgrade debt</h3><p>A scan looks up the latest version of each direct dependency on the public registry (only package names leave your machine) and shows how far behind you are.</p>
      <button class="btn ember" data-act="scan" ${ui.busy.has("scan") ? "disabled" : ""}>${icon("scan")}${ui.busy.has("scan") ? "Scanning…" : "Scan now"}</button></div></div></div>`;
  const behind = [...debt.behind].sort(
    (a, b) => b.majorsBehind - a.majorsBehind || a.package.localeCompare(b.package),
  );
  const majors = behind.filter((b) => b.majorsBehind > 0);
  const maxM = Math.max(...behind.map((b) => b.majorsBehind), 1);
  return `<div class="page">
    <div class="hello in"><div><h1>Dependencies</h1><p>Scanned ${agoLong(debt.generatedAt)} · ${esc(debt.packageManager)}</p></div>
      <div class="actions"><button class="btn" data-act="scan" ${ui.busy.has("scan") ? "disabled" : ""}>${icon("scan")}${ui.busy.has("scan") ? "Scanning…" : "Scan again"}</button></div></div>
    <div class="grid g-kpi">
      ${[
        [
          "package",
          "Direct dependencies",
          String(debt.directDependencies),
          "declared in your manifests",
        ],
        [
          "alert",
          "Behind a major",
          String(majors.length),
          `${majors.reduce((n, b) => n + b.majorsBehind, 0)} majors in total`,
        ],
        [
          "check",
          "Upgrade-ready today",
          String(majors.filter((b) => b.latestEligible).length),
          "past the release-age rule",
        ],
      ]
        .map(
          ([ic, t, v, f], i) =>
            `<div class="card kpi in" style="--dl:${60 + i * 50}ms"><div class="kpi-h"><span class="ico">${icon(ic as string)}</span>${t}</div><div class="kpi-v num">${v}</div><div class="kpi-f">${f}</div></div>`,
        )
        .join("")}
    </div>
    <div class="card flush in mt" style="--dl:200ms">
      <div class="card-h"><div><div class="card-t">Behind</div><div class="card-s">Upgrade one and Bumpsmith fixes what breaks</div></div></div>
      <div class="table-scroll"><table class="t"><thead><tr><th>Package</th><th>Current</th><th>Latest</th><th>Majors behind</th><th>Released</th><th></th></tr></thead><tbody>
      ${behind
        .map(
          (b) => `<tr data-act="new" data-pkg="${esc(b.package)}" data-ver="${esc(b.latest ?? "")}">
        <td><div class="pkg-cell">${pkgTile({ package: b.package, ecosystem: d.repo.ecosystem ?? "npm" }, "sm")}<div class="pkg-name">${esc(b.package)}</div></div></td>
        <td class="mono">${esc(b.current ?? "?")}</td><td class="mono"><b>${esc(b.latest ?? "?")}</b></td>
        <td><div style="display:flex;gap:10px;align-items:center"><div class="mini-bar"><i class="${b.majorsBehind >= 2 ? "ember" : ""}" style="width:${(b.majorsBehind / maxM) * 100}%"></i></div><span class="mono">${b.majorsBehind}</span></div></td>
        <td class="muted">${b.latestPublishedAt ? agoLong(b.latestPublishedAt) : "—"}${b.latestEligible ? "" : ` <span class="pill info no-dot">too new</span>`}</td>
        <td class="r"><span class="btn sm">${icon("bolt")}Upgrade</span></td>
      </tr>`,
        )
        .join("")}
      </tbody></table></div>
    </div>
  </div>`;
}

// ───────────── safety, sandbox ─────────────

function safetyPage(d: State) {
  const runs = d.runs;
  const blocked = runs.filter((r) => r.state === "blocked_policy");
  const items = [
    [
      "box",
      "Isolated sandbox",
      "Your code runs in a throwaway container with no internet, no host files and no secrets. Network is on only while installing, and then reaches only a read-only registry mirror.",
    ],
    [
      "shield",
      "Release gate",
      "New versions must be a few days old, not yanked, and not listed as malicious (OSV) before anything installs.",
    ],
    [
      "lock",
      "Edit policy",
      "The agent may only edit files tied to the failure. Manifests, CI and protected paths are off limits.",
    ],
    [
      "eye",
      "Independent review",
      "A second model reviews the diff against five rules, and deterministic rules block suspicious code.",
    ],
    [
      "flask",
      "Proof, not claims",
      "Bumpsmith re-runs your own checks itself after every round. A result is ready only if the sandbox proves it.",
    ],
  ];
  return `<div class="page">
    <div class="hello in"><div><h1>Safety & evidence</h1><p>How every upgrade here was kept safe, and what was refused</p></div></div>
    <div class="grid g-half">
      <div class="card in"><div class="card-h"><div><div class="card-t">Guarantees</div><div class="card-s">On by default, for every run</div></div></div>
        <div class="reasons">${items.map(([ic, t, s]) => `<div class="reason ok"><div class="ri">${icon(ic as string)}</div><div><b>${t}</b><div class="card-s" style="margin-top:3px">${s}</div></div></div>`).join("")}</div></div>
      <div class="card in" style="--dl:80ms"><div class="card-h"><div><div class="card-t">Refused</div><div class="card-s">${blocked.length ? `${blocked.length} upgrade${blocked.length === 1 ? "" : "s"} stopped by a safety rule` : "Nothing has been blocked here"}</div></div></div>
        <div class="feed">${blocked.map((r) => `<div class="feed-i" data-act="open-run" data-id="${esc(r.id)}"><div class="feed-ic bad">${icon("lock")}</div><div style="min-width:0"><div class="feed-t">${esc(r.package)} ${esc(r.to)}</div><div class="feed-s">${esc(r.reason ?? "blocked")}</div></div><div class="feed-w">${ago(r.created_at)}</div></div>`).join("") || `<div class="card-s">When a release is malicious, too new, or a change trips a rule, it shows up here with the reason.</div>`}</div></div>
    </div>
  </div>`;
}

function sandboxPage(d: State) {
  return `<div class="page">
    <div class="hello in"><div><h1>Sandbox & models</h1><p>What runs your upgrades on this machine</p></div></div>
    <div class="grid g-half">
      <div class="card in"><div class="card-h"><div><div class="card-t">Models</div><div class="card-s">Use your own subscription or key. Choose per upgrade.</div></div></div>
        <div class="provs">${d.env.providers.map((p) => `<div class="prov ${p.ok ? "" : "off"}" style="cursor:default"><div class="who-av" style="width:34px;height:34px;font-size:11px">${esc(p.label.slice(0, 2).toUpperCase())}</div><div><div class="pn">${esc(p.label)}${p.id === d.env.defaultProvider ? ` <span class="pill ember no-dot" style="height:20px">default</span>` : ""}</div><div class="pd">${esc(p.detail)}</div></div><span class="st">${p.ok ? "available" : "not set up"}</span></div>`).join("")}</div></div>
      <div class="grid" style="align-content:start">
        <div class="card in" style="--dl:80ms"><div class="card-h"><div><div class="card-t">Sandbox</div><div class="card-s">Docker containers with no route out</div></div><div class="right">${d.env.docker ? `<span class="pill ok">ready</span>` : `<span class="pill bad">Docker not running</span>`}</div></div>
          <dl class="kv"><dt>Docker</dt><dd>${esc(d.env.docker ?? "start Docker Desktop or OrbStack")}</dd><dt>Network</dt><dd>registry mirror only, during installs</dd><dt>Runtimes</dt><dd>Node 22 · 24 · 26, Python 3.10–3.15</dd><dt>Runs</dt><dd>${esc(d.runsDir)}</dd></dl></div>
        <div class="card in" style="--dl:120ms"><div class="card-h"><div><div class="card-t">Privacy</div><div class="card-s">This dashboard</div></div></div>
          <div class="card-s" style="line-height:1.6">Runs only on 127.0.0.1 and reads files in this repository. It sends nothing anywhere. Fonts are bundled, there is no analytics, and every action needs a token that only this page has.</div></div>
      </div>
    </div>
  </div>`;
}

// ───────────── new upgrade + live drawer ─────────────

const STAGES = [
  { id: "prepare", label: "Copying your repository" },
  { id: "analyse", label: "Reading the changelog" },
  { id: "baseline", label: "Running your checks before" },
  { id: "bump", label: "Applying the bump" },
  { id: "verify", label: "Running your checks after" },
  { id: "fix", label: "Fixing what broke" },
  { id: "review", label: "Independent review" },
  { id: "done", label: "Result" },
];

function drawer(d: State) {
  const dr = ui.drawer;
  if (!dr) return "";
  if (dr.mode === "live" && dr.liveId) {
    const l = ui.live.get(dr.liveId);
    const result = l?.done && l.jobId ? d.runs.find((r) => r.id === l.jobId) : undefined;
    const good = result ? result.state === "ready" || result.state === "safe" : l?.exitCode === 0;
    // While running: the current stage. Once done: everything up to the last stage reached,
    // then the result, marked by how it ended.
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
    return `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-label="Upgrade in progress">
      <div class="drawer-h"><div style="flex:1"><div class="card-s" style="margin:0 0 4px;display:flex;gap:8px;align-items:center"><span class="dot ${l?.done ? "" : "live"}"></span>${l?.done ? "Finished" : "Running in the sandbox"}</div><h3>${esc(l?.package ?? dr.pkg)} → ${esc(l?.version ?? dr.version)}</h3></div><button class="icon-btn" data-act="close" title="Close (keeps running)">${icon("x")}</button></div>
      <div class="drawer-b">
        <div class="vsteps">${STAGES.map((s, i) => {
          const c = cls(i);
          return `<div class="vstep ${c}"><div class="vd">${icon(c === "done" ? "check" : c === "fail" ? "x" : c === "active" ? "bolt" : "clock")}</div><div class="vt">${i === STAGES.length - 1 && result ? esc(stateOf(result.state).label) : s.label}</div><div class="vs">${c === "active" ? "now" : c === "fail" && i < STAGES.length - 1 ? "stopped here" : ""}</div></div>`;
        }).join("")}</div>
        ${result && !good && result.reason ? `<div class="reason warn"><div class="ri">${icon("alert")}</div><div>${md(result.reason)}</div></div>` : ""}
        <div><div class="card-s" style="margin:0 0 8px">Log</div><div class="term" id="term">${(l?.lines ?? []).map((x) => `<div class="${/^job /.test(x) ? "ln-j" : /^(READY|SAFE)/.test(x) ? "ln-ok" : /error|fail/i.test(x) ? "ln-bad" : ""}">${esc(x)}</div>`).join("")}${l?.done ? "" : `<span class="cursor"></span>`}</div></div>
      </div>
      <div class="drawer-f">${l?.done ? `<span style="flex:1;align-self:center;display:flex;gap:8px;align-items:center">${result ? `${statePill(result.state)}${confPill(result.confidence)}` : `<b>${l.exitCode === 0 ? "Done" : "Finished with problems"}</b>`}</span>${l.jobId ? `<a class="btn ember" data-act="close" href="#/runs/${esc(l.jobId)}">Open result ${icon("arrowR")}</a>` : ""}` : `<span class="card-s" style="flex:1;align-self:center;margin:0">You can close this; the upgrade keeps running.</span><button class="btn" data-act="close">Hide</button>`}</div>
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
  return `<div class="scrim" data-act="close"></div><aside class="drawer" role="dialog" aria-label="New upgrade">
    <div class="drawer-h"><div style="flex:1"><div class="card-s" style="margin:0 0 4px">${esc(d.repo.name)} · ${esc(d.repo.packageManager ?? "")}</div><h3>New upgrade</h3></div><button class="icon-btn" data-act="close">${icon("x")}</button></div>
    <div class="drawer-b">
      <div class="field"><label for="f-pkg">Package</label><div class="combo"><input class="input mono" id="f-pkg" autocomplete="off" placeholder="zod" value="${esc(dr.pkg)}" />
        ${showList ? `<div class="combo-list">${matches.map((m) => `<div class="combo-i" data-act="pick-pkg" data-v="${esc(m)}">${esc(m)}<span>${esc(d.repo.dependencies[m] ?? "")}</span></div>`).join("")}</div>` : ""}</div>
        <div class="hint">${d.repo.dependencies[dr.pkg] ? `You have <span class="mono">${esc(d.repo.dependencies[dr.pkg])}</span>` : dr.pkg ? "Not a direct dependency here; transitive packages work too." : `${deps.length} direct dependencies`}</div></div>
      <div class="field"><label for="f-ver">Version</label><input class="input mono" id="f-ver" placeholder="${esc(latest ?? "4.1.0")}" value="${esc(dr.version)}" />
        <div class="hint">${latest ? `Latest is <a href="#" data-act="use-latest" style="color:var(--ember-ink);font-weight:600" class="mono">${esc(latest)}</a>` : "An exact version"}</div></div>
      <div class="field"><label>Model</label><div class="provs">${d.env.providers
        .map(
          (p) =>
            `<div class="prov ${dr.provider === p.id ? "on" : ""} ${p.ok ? "" : "off"}" data-act="${p.ok ? "pick-prov" : ""}" data-v="${p.id}"><span class="r"></span><div><div class="pn">${esc(p.label)}</div><div class="pd">${esc(p.detail)}</div></div><span class="st">${p.ok ? "available" : "not set up"}</span></div>`,
        )
        .join("")}</div></div>
      <div class="field"><label for="f-budget">Spend cap · <span class="mono">${money(dr.budget, 0)}</span></label><input type="range" class="range" id="f-budget" min="1" max="30" step="1" value="${dr.budget}" /><div class="hint">The run stops before going over it (API-equivalent cost).</div></div>
      ${d.env.docker ? "" : `<div class="reason warn"><div class="ri">${icon("alert")}</div><div>Docker is not running. Start Docker Desktop or OrbStack first: every upgrade runs in a sandbox.</div></div>`}
    </div>
    <div class="drawer-f"><button class="btn" data-act="close">Cancel</button><div class="spacer"></div><button class="btn ember" data-act="start" ${dr.pkg && /^\d/.test(dr.version) && d.env.docker ? "" : "disabled"}>${icon("bolt")}Start upgrade</button></div>
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
        toast(
          `${l.package} ${l.version}: ${l.exitCode === 0 ? "verified" : "finished, see the result"}`,
          l.exitCode !== 0,
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
    { g: "Go to", ic: "grid", t: "Overview", run: () => go("") },
    { g: "Go to", ic: "layers", t: "Upgrades", run: () => go("runs") },
    { g: "Go to", ic: "package", t: "Dependencies", run: () => go("deps") },
    { g: "Go to", ic: "shield", t: "Safety & evidence", run: () => go("safety") },
    { g: "Go to", ic: "cpu", t: "Sandbox & models", run: () => go("sandbox") },
    ...d.runs.slice(0, 40).map((r) => ({
      g: "Upgrades",
      ic: "diff",
      t: `${r.package} ${r.from ?? "?"} → ${r.to}`,
      k: stateOf(r.state).short,
      run: () => go(`runs/${r.id}`),
    })),
    ...Object.keys(d.repo.dependencies)
      .slice(0, 200)
      .map((p) => ({
        g: "Upgrade a dependency",
        ic: "bolt",
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
  return `<div class="scrim" data-act="close-pal" style="background:rgba(11,11,12,.18)"></div><div class="palette" role="dialog" aria-label="Command palette">
    <input id="pal" placeholder="Search upgrades, dependencies, actions…" value="${esc(ui.palQuery)}" autocomplete="off" />
    <div class="list">${
      items
        .map((it, i) => {
          const head = it.g !== g ? `<div class="pal-g">${esc(it.g)}</div>` : "";
          g = it.g;
          return `${head}<div class="pal-i ${i === ui.palIndex ? "on" : ""}" data-act="pal-run" data-v="${i}">${icon(it.ic)}<span>${esc(it.t)}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ""}</div>`;
        })
        .join("") || `<div class="card-s" style="padding:16px">No matches</div>`
    }</div></div>`;
}

// ───────────── routing, rendering, events ─────────────

function go(path: string) {
  location.hash = `#/${path}`;
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
      if (!ui.drawer.version && r.version) ui.drawer.version = r.version;
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
  ui.diffFile = 0;
  ui.openCheck = null;
  try {
    const r = await api<{ job: Job; patch: string; evidence: string }>(
      `/api/runs/${encodeURIComponent(id)}`,
    );
    ui.detail = { id, ...r };
    unsettle();
  } catch (e) {
    toast((e as Error).message, true);
    go("runs");
  }
  render();
}

let tipEl: HTMLDivElement | null = null;
let settled = false;
let replayChart = false;
function render() {
  const d = ui.data;
  if (!d) {
    $app.innerHTML = `<aside class="sidebar"><div class="brand">${BRAND_MARK}<span class="brand-word">bumpsmith</span></div><div class="skel" style="height:62px"></div></aside><main class="main"><div class="page"><div class="skel" style="height:48px;width:40%;margin-bottom:24px"></div><div class="skel" style="height:150px;margin-bottom:18px"></div><div class="grid g-kpi">${'<div class="skel" style="height:140px"></div>'.repeat(6)}</div></div></main>`;
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
    crumbs.push("Safety & evidence");
    body = safetyPage(d);
  } else if (route === "sandbox") {
    crumbs.push("Sandbox & models");
    body = sandboxPage(d);
  } else {
    crumbs.push("Overview");
    body = overview(d);
  }
  // Keep focus and caret in text fields across re-renders.
  const active = document.activeElement as HTMLInputElement | null;
  const focusId = active?.id;
  const caret = active && "selectionStart" in active ? active.selectionStart : null;
  const scrollTerm = document.getElementById("term");
  const atBottom =
    !scrollTerm || scrollTerm.scrollHeight - scrollTerm.scrollTop - scrollTerm.clientHeight < 40;
  $app.className = `shell${settled ? " settled" : ""}`;
  $app.innerHTML = `${GRADIENTS}${sidebar(d)}<main class="main">${topbar(crumbs)}${body}</main>${drawer(d)}${palette(d)}`;
  if (focusId) {
    const el = document.getElementById(focusId) as HTMLInputElement | null;
    if (el) {
      el.focus();
      if (caret !== null) el.setSelectionRange(caret, caret);
    }
  }
  const term = document.getElementById("term");
  if (term && atBottom) term.scrollTop = term.scrollHeight;
}

let settleTimer = 0;
/** Let a page's entrance animations play once, then stop re-renders from replaying them. */
function unsettle() {
  settled = false;
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    settled = true;
    $app.classList.add("settled");
  }, 1600);
}
async function onRoute() {
  ui.route = location.hash.replace(/^#\/?/, "");
  const [route, arg] = ui.route.split("/");
  if (route === "runs" && arg) loadDetail(arg);
  unsettle();
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
    case "close":
      ui.drawer = null;
      render();
      break;
    case "open-run":
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
    case "chart-mode":
      ui.chartMode = v as typeof ui.chartMode;
      replayChart = true;
      render();
      replayChart = false;
      break;
    case "chart-range":
      ui.chartRange = Number(v);
      replayChart = true;
      render();
      replayChart = false;
      break;
    case "filter":
      ui.filter = v;
      render();
      break;
    case "scan":
      scan();
      break;
    case "diff-file":
      ui.diffFile = Number(v);
      render();
      break;
    case "wrap":
      ui.diffWrap = !ui.diffWrap;
      render();
      break;
    case "toggle-check":
      ui.openCheck = ui.openCheck === v ? null : v;
      render();
      break;
    case "pick-pkg":
      if (ui.drawer) {
        ui.drawer.pkg = v;
        render();
        fetchLatest(v);
        (document.getElementById("f-ver") as HTMLInputElement | null)?.focus();
      }
      break;
    case "use-latest":
      e.preventDefault();
      if (ui.drawer) {
        ui.drawer.version = ui.latest[ui.drawer.pkg] ?? "";
        render();
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
    case "apply": {
      const id = t.dataset.id ?? "";
      if (!confirm("Apply this patch to your working tree and stage it?")) break;
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
      break;
    }
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
  } else if (el.id === "pal") {
    ui.palQuery = el.value;
    ui.palIndex = 0;
    render();
  } else if (ui.drawer && el.id === "f-pkg") {
    ui.drawer.pkg = el.value.trim();
    render();
  } else if (ui.drawer && el.id === "f-ver") {
    ui.drawer.version = el.value.trim();
    render();
  } else if (ui.drawer && el.id === "f-budget") {
    ui.drawer.budget = Number(el.value);
    render();
  }
});
document.addEventListener("focusout", (e) => {
  if ((e.target as HTMLElement).id === "f-pkg" && ui.drawer)
    setTimeout(() => {
      fetchLatest(ui.drawer?.pkg ?? "");
      render();
    }, 150);
});

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

// Tooltips for chart columns and heatmap cells.
document.addEventListener("mousemove", (e) => {
  const t = e.target as HTMLElement;
  const hint = t.closest<HTMLElement>("[data-hint]")?.dataset.hint;
  const tipIdx = (t as unknown as SVGElement).dataset?.tip;
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tip";
    document.body.append(tipEl);
  }
  if (hint) {
    tipEl.innerHTML = esc(hint);
  } else if (tipIdx !== undefined && ui.data) {
    const b = buckets(ui.data.runs, ui.chartRange)[Number(tipIdx)] as Bucket | undefined;
    if (!b) return;
    tipEl.innerHTML = `<b>${esc(b.label)}</b>${OUTCOME_GROUPS.map((g) => `<div class="row"><span>${g.label}</span><span>${b.runs.filter((r) => g.states.includes(r.state)).length}</span></div>`).join("")}<div class="row"><span>Spend</span><span>${money(b.runs.reduce((n, r) => n + r.cost_usd, 0))}</span></div>`;
  } else {
    tipEl.classList.remove("on");
    return;
  }
  tipEl.style.left = `${e.clientX}px`;
  tipEl.style.top = `${e.clientY}px`;
  tipEl.classList.add("on");
});

window.addEventListener("hashchange", onRoute);

(async () => {
  render();
  try {
    await refresh();
  } catch (e) {
    $app.innerHTML = `<div class="page"><div class="card"><div class="empty"><h3>Could not load</h3><p>${esc((e as Error).message)}</p></div></div></div>`;
    return;
  }
  for (const l of ui.data?.live ?? []) if (!l.done) followLive(l.id);
  await onRoute();
  // Pick up runs started from the terminal while the dashboard is open.
  setInterval(async () => {
    if (document.hidden || ui.drawer || ui.palette) return;
    const before = ui.data?.runs.map((r) => r.id).join();
    await refresh().catch(() => {});
    if (ui.data?.runs.map((r) => r.id).join() !== before) render();
  }, 15000);
})();
