// Shared UI building blocks for the dashboard: icons, formatting, charts, diff rendering.
// Everything renders to HTML strings; user data always goes through esc().

export interface Check {
  name: string;
  before: boolean | null;
  after: boolean | null;
  sameFailures: boolean;
}

export interface Run {
  id: string;
  created_at: string;
  finished_at: string | null;
  package: string;
  ecosystem: string;
  from: string | null;
  to: string;
  state: string;
  confidence: string | null;
  cost_usd: number;
  duration_ms: number;
  provider: string;
  model: string;
  checks: Check[];
  files: number;
  lines: number;
  edited_by_agent: number;
  rounds: number;
  review: string | null;
  reason: string | null;
  upgrade_class: string | null;
  breaking_changes: number;
  impact_items: number;
  has_patch: boolean;
  cost_by_role: Record<string, number>;
  agent_lines: number;
}

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Lucide-style 24px stroke icons.
const P: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  package:
    '<path d="M16.5 9.4 7.5 4.2"/><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="M3.3 7 12 12l8.7-5"/><path d="M12 22V12"/>',
  box: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 14h3"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowR: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowL: '<path d="M19 12H5"/><path d="m11 6-6 6 6 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert:
    '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  git: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="9" r="2.5"/><path d="M6 8.5v7M18 11.5c0 3-3 3.5-6 4.5l-3.6 1"/>',
  diff: '<path d="M12 3v14M5 10h14"/><path d="M5 21h14"/>',
  dollar: '<path d="M12 2v20"/><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  wrench:
    '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.3 9.3a2.1 2.1 0 0 1-3-3l9.3-9.3a4 4 0 0 0-2-5.3 4 4 0 0 0 0 3.3Z"/>',
  flask:
    '<path d="M9 3h6"/><path d="M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/>',
  apply: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  spark:
    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
  pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  docker:
    '<path d="M3 12h16a3 3 0 0 0 2-1c-1-1-2.5-1-3-.5 0-2-1.5-2.5-1.5-2.5S15 10 15 12"/><path d="M3 12c0 4 3 7 8 7 5.5 0 8.5-3 10-7"/><path d="M5 9h3v3H5zM8 9h3v3H8zM11 9h3v3h-3zM8 6h3v3H8zM11 6h3v3h-3z"/>',
  chevron: '<path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/>',
  external:
    '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
  route:
    '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12"/>',
  hourglass: '<path d="M6 2h12M6 22h12"/><path d="M7 2v4l5 6 5-6V2M7 22v-4l5-6 5 6v4"/>',
};

export const icon = (name: string, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;

export const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset="1" stop-color="#e2410c"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="#0b0b0c"/><path d="M7 18.5h18l-2.4 4.5H9.4z" fill="url(#bm)"/><path d="M11 21.5h10v3H11z" fill="#3a2a22"/><path d="M12.5 8.5 16 14l3.5-5.5" stroke="#ffb48c" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.5" cy="9" r="1.4" fill="#ff7a3d"/><circle cx="8.5" cy="11.5" r="1" fill="#ff7a3d" opacity=".7"/></svg>`;

// ───────────── formatting ─────────────

export const STATES: Record<string, { label: string; tone: string; short: string }> = {
  ready: { label: "Ready to apply", tone: "ok", short: "Ready" },
  safe: { label: "Safe, no code change", tone: "ok", short: "Safe" },
  needs_human: { label: "Needs a human", tone: "warn", short: "Needs a human" },
  blocked_policy: { label: "Blocked", tone: "bad", short: "Blocked" },
  failed_infra: { label: "Could not run", tone: "bad", short: "Failed" },
  waiting_release_age: { label: "Waiting for release age", tone: "info", short: "Waiting" },
};
export const stateOf = (s: string) => STATES[s] ?? { label: s, tone: "", short: s };
export const statePill = (s: string) => {
  const st = stateOf(s);
  return `<span class="pill ${st.tone}">${esc(st.short)}</span>`;
};
export const confPill = (c: string | null) =>
  c
    ? `<span class="pill no-dot ${c === "high" ? "ok" : c === "medium" ? "info" : "warn"}">${esc(c)} confidence</span>`
    : "";

export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
export const agoLong = (iso: string | null) => {
  const a = ago(iso);
  if (a === "now") return "just now";
  return /^\d+[mhd]$/.test(a)
    ? `${a.slice(0, -1)} ${{ m: "min", h: "h", d: "d" }[a.slice(-1) as "m" | "h" | "d"]} ago`
    : a;
};
export function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export const money = (n: number, d = 2) => `$${n.toFixed(d)}`;
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};

/** Deterministic colours per package for the monogram tiles. */
const TILES = [
  ["#ff7a3d", "#7a1f04"],
  ["#2b2a28", "#0b0b0c"],
  ["#3d6df2", "#0f1f5c"],
  ["#1f9d5c", "#063b22"],
  ["#d64a8d", "#4a0b2b"],
  ["#e8a317", "#5c3a02"],
  ["#7a5af5", "#22125e"],
  ["#14a3a3", "#043b3b"],
];
export function tileColors(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length] ?? TILES[0] ?? ["#ff7a3d", "#7a1f04"];
}
export function monogram(name: string) {
  const scoped = /^@([^/]+)\/(.+)$/.exec(name);
  if (scoped?.[1] && scoped[2]) return `${scoped[1][0]}${scoped[2][0]}`.toUpperCase();
  const base = name
    .replace(/^@[^/]+\//, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();
  const parts = base.split(" ").filter(Boolean);
  const m = parts.length > 1 ? (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "") : base.slice(0, 2);
  return m.toUpperCase() || "?";
}
export function pkgTile(
  r: { package: string; ecosystem: string; to?: string },
  size: "lg" | "sm" = "lg",
) {
  const [a, b] = tileColors(r.package);
  const bg = `background: radial-gradient(130% 110% at 15% 0%, ${a} 0%, ${b} 100%)`;
  if (size === "sm")
    return `<div class="pkg-tile sm" style="${bg}"><div class="mon">${esc(monogram(r.package))}</div></div>`;
  return `<div class="pkg-tile" style="${bg}"><div class="eco">${esc(r.ecosystem === "pypi" ? "PyPI" : "npm")}</div><div class="mon">${esc(monogram(r.package))}</div><div class="ver">${r.to ? `v${esc(r.to)}` : ""}</div></div>`;
}

export function flip(text: string, cls = "") {
  let i = 0;
  return `<div class="flip ${cls}">${[...text]
    .map((ch) =>
      /\d/.test(ch)
        ? `<div class="d"><span style="--dl:${120 + i++ * 90}ms">${ch}</span></div>`
        : `<div class="c">${esc(ch)}</div>`,
    )
    .join("")}</div>`;
}

// ───────────── charts ─────────────

export function sparkline(values: number[], ink = false) {
  const w = 112;
  const h = 46;
  const vs = values.length > 1 ? values : [0, ...(values.length ? values : [0])];
  const max = Math.max(...vs, 1);
  const min = Math.min(...vs, 0);
  const pts: [number, number][] = vs.map((v, i) => [
    (i / (vs.length - 1)) * w,
    h - 6 - ((v - min) / (max - min || 1)) * (h - 14),
  ]);
  // Smooth with a light Catmull-Rom.
  let d = `M${pts[0]?.[0]},${pts[0]?.[1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p1: [number, number] = pts[i] ?? [0, 0];
    const p0: [number, number] = pts[i - 1] ?? p1;
    const p2: [number, number] = pts[i + 1] ?? p1;
    const p3: [number, number] = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  const last = pts[pts.length - 1] ?? [w, h];
  return `<svg class="spark ${ink ? "ink" : ""}" viewBox="0 0 ${w} ${h}"><path class="a" d="${d} L${w},${h} L0,${h} Z"/><path class="l" d="${d}"/><circle cx="${last[0]}" cy="${last[1]}" r="3"/></svg>`;
}

export const GRADIENTS = `<svg width="0" height="0" style="position:absolute"><defs>
<linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2541b" stop-opacity=".22"/><stop offset="1" stop-color="#f2541b" stop-opacity="0"/></linearGradient>
<linearGradient id="sparkink" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0b0c" stop-opacity=".14"/><stop offset="1" stop-color="#0b0b0c" stop-opacity="0"/></linearGradient>
<linearGradient id="areafill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2541b" stop-opacity=".2"/><stop offset="1" stop-color="#f2541b" stop-opacity="0"/></linearGradient>
</defs></svg>`;

export const OUTCOME_GROUPS: { key: string; label: string; color: string; states: string[] }[] = [
  { key: "ready", label: "Ready or safe", color: "#18834a", states: ["ready", "safe"] },
  {
    key: "human",
    label: "Needs a human",
    color: "#e3a43b",
    states: ["needs_human", "waiting_release_age"],
  },
  { key: "blocked", label: "Blocked", color: "#c8121f", states: ["blocked_policy"] },
  { key: "failed", label: "Could not run", color: "#b9b4ab", states: ["failed_infra"] },
];

export interface Bucket {
  label: string;
  start: number;
  runs: Run[];
}

/** Day buckets ending today; `days` = 0 means from the first run. */
export function buckets(runs: Run[], days: number): Bucket[] {
  const dayMs = 86_400_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = today.getTime();
  const first = runs.length ? Math.min(...runs.map((r) => Date.parse(r.created_at))) : end;
  let n = days || Math.max(7, Math.ceil((end - first) / dayMs) + 1);
  let step = 1;
  while (n / step > 42) step++;
  n = Math.ceil(n / step) * step;
  const out: Bucket[] = [];
  for (let i = n - step; i >= 0; i -= step) {
    const start = end - i * dayMs;
    out.push({
      start,
      label: new Date(start).toLocaleDateString(undefined, { day: "numeric", month: "short" }),
      runs: runs.filter((r) => {
        const t = Date.parse(r.created_at);
        return t >= start && t < start + step * dayMs;
      }),
    });
  }
  return out;
}

export function barChart(bs: Bucket[], mode: "outcomes" | "spend" | "time"): string {
  const W = 760;
  const H = 290;
  const pad = { l: 44, r: 8, t: 14, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const val = (b: Bucket) =>
    mode === "outcomes"
      ? b.runs.length
      : mode === "spend"
        ? b.runs.reduce((n, r) => n + r.cost_usd, 0)
        : median(b.runs.map((r) => r.duration_ms / 60000));
  const max = Math.max(...bs.map(val), mode === "outcomes" ? 4 : 0.5);
  const nice = niceMax(max);
  const fmt = (v: number) =>
    mode === "spend"
      ? `$${v < 10 ? v.toFixed(1) : Math.round(v)}`
      : mode === "time"
        ? `${Math.round(v)}m`
        : String(Math.round(v));
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ih - (i / 4) * ih;
    g += `<line class="grid-l" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text x="${pad.l - 10}" y="${y + 3.5}" text-anchor="end">${fmt((nice * i) / 4)}</text>`;
  }
  const bw = iw / bs.length;
  const barW = Math.max(4, Math.min(26, bw * 0.58));
  let bars = "";
  const labelEvery = Math.ceil(bs.length / 8);
  bs.forEach((b, i) => {
    const x = pad.l + i * bw + (bw - barW) / 2;
    const lastLabel = i === bs.length - 1 && (bs.length - 1) % labelEvery >= labelEvery / 2;
    if (i % labelEvery === 0 || lastLabel)
      bars += `<text x="${pad.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
    if (mode === "outcomes") {
      let y = pad.t + ih;
      for (const grp of OUTCOME_GROUPS) {
        const n = b.runs.filter((r) => grp.states.includes(r.state)).length;
        if (!n) continue;
        const h = (n / nice) * ih;
        y -= h;
        bars += `<rect class="col" style="animation-delay:${i * 18}ms" x="${x}" y="${y}" width="${barW}" height="${Math.max(h - 1.5, 1)}" rx="${Math.min(4, barW / 3)}" fill="${grp.color}"/>`;
      }
    } else {
      const v = val(b);
      const h = (v / nice) * ih;
      if (v > 0)
        bars += `<rect class="col" style="animation-delay:${i * 18}ms" x="${x}" y="${pad.t + ih - h}" width="${barW}" height="${h}" rx="${Math.min(4, barW / 3)}" fill="${mode === "spend" ? "#f2541b" : "#0b0b0c"}"/>`;
    }
    bars += `<rect class="hit" data-tip="${i}" x="${pad.l + i * bw}" y="${pad.t}" width="${bw}" height="${ih}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${g}${bars}</svg>`;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * exp;
}

/** Cell class for the check-health heatmap. */
export function cellOf(c: Check | undefined): string {
  if (!c || c.before === null) return "";
  if (c.after === null) return c.before ? "skip" : "pre";
  if (c.before && c.after) return "ok";
  if (c.before && !c.after) return "reg";
  if (c.sameFailures) return "same";
  return c.after ? "ok" : "pre";
}

// ───────────── diff ─────────────

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  lines: {
    kind: "add" | "del" | "ctx" | "hunk";
    text: string;
    a: number | null;
    b: number | null;
  }[];
}

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let a = 0;
  let b = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = { path: m?.[1] ?? line, added: 0, removed: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (
      /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(
        line,
      )
    ) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m?.[1]) cur.path = m[1];
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      cur.lines.push({ kind: "hunk", text: line, a: null, b: null });
      continue;
    }
    if (line.startsWith("+")) {
      cur.lines.push({ kind: "add", text: line.slice(1), a: null, b: b++ });
      cur.added++;
    } else if (line.startsWith("-")) {
      cur.lines.push({ kind: "del", text: line.slice(1), a: a++, b: null });
      cur.removed++;
    } else if (line.startsWith(" ") || line === "") {
      if (line === "" && cur.lines.length === 0) continue;
      cur.lines.push({ kind: "ctx", text: line.slice(1), a: a++, b: b++ });
    }
  }
  return files;
}

const KW =
  /\b(import|from|export|default|const|let|var|function|return|async|await|if|else|for|while|class|new|extends|type|interface|def|lambda|with|as|try|except|catch|finally|raise|throw|yield|None|True|False|null|undefined|true|false|in|of|is|not|and|or|pass)\b/g;

/** Escaped text with `backticks` shown as inline code. */
export const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code class="ic">$1</code>');

/** Lightweight highlighting: comments, strings, keywords, numbers, calls. */
export function highlight(code: string, path: string): string {
  // Lines inside a block comment or docstring-style comment block.
  if (/^\s*(\*|\/\*\*?|\*\/)(\s|$|\/)/.test(code)) return `<span class="tok-c">${esc(code)}</span>`;
  if (/\.(json|lock|ya?ml|toml|txt|cfg|in)$|lock\.json$|Pipfile/.test(path)) {
    return esc(code)
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-f">$1</span>$2')
      .replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-s">$2</span>')
      .replace(/(==|&gt;=|~=|\^|~)(\d[\w.]*)/g, '$1<span class="tok-n">$2</span>');
  }
  const out: string[] = [];
  const re = /(\/\/.*$|#.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  let last = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    out.push(plain(code.slice(last, i)));
    out.push(
      m[1] ? `<span class="tok-c">${esc(m[1])}</span>` : `<span class="tok-s">${esc(m[2])}</span>`,
    );
    last = i + m[0].length;
  }
  out.push(plain(code.slice(last)));
  return out.join("");
}
function plain(s: string) {
  return esc(s)
    .replace(KW, '<span class="tok-k">$1</span>')
    .replace(/(?<!&#)\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-n">$1</span>')
    .replace(/\b([A-Za-z_]\w*)(?=\()/g, '<span class="tok-f">$1</span>');
}
