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
  eyeOff:
    '<path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.5-.6 4.9-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  docker:
    '<path d="M3 12h16a3 3 0 0 0 2-1c-1-1-2.5-1-3-.5 0-2-1.5-2.5-1.5-2.5S15 10 15 12"/><path d="M3 12c0 4 3 7 8 7 5.5 0 8.5-3 10-7"/><path d="M5 9h3v3H5zM8 9h3v3H8zM11 9h3v3h-3zM8 6h3v3H8zM11 6h3v3h-3z"/>',
  chevron: '<path d="m8 9 4-4 4 4"/><path d="m16 15-4 4-4-4"/>',
  external:
    '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  wrap: '<path d="M3 6h18M3 12h15a3 3 0 0 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
  route:
    '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M12 19h4.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H12"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
  alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>',
  minus: '<path d="M6 12h12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 4-6 3-11 8"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  unfold: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  fold: '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>',
  plusSquare: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/>',
  minusSquare: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12h8"/>',
  dotSquare:
    '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  checkCircleFill:
    '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m7.5 12.2 3 3 6-6.4" stroke="#fff" stroke-width="2.2"/>',
  xCircleFill:
    '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m8.8 8.8 6.4 6.4M15.2 8.8l-6.4 6.4" stroke="#fff" stroke-width="2.2"/>',
  alertCircleFill:
    '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="M12 7v6M12 16.6h.01" stroke="#fff" stroke-width="2.4"/>',
  skipCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  hourglass: '<path d="M6 2h12M6 22h12"/><path d="M7 2v4l5 6 5-6V2M7 22v-4l5-6 5 6v4"/>',
};

export const icon = (name: string, cls = "") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ""}</svg>`;

/** A simple mark: a bar being bumped up. Follows the theme through CSS variables. */
// The Bumpsmith wordmark (dashboard/brand/): drawn on a grid, one stroke weight; the dot of the i
// is an ember square raised to the ascender line. Strokes use currentColor so it follows the theme.
export const BRAND_WORDMARK = `<svg class="brand-wordmark" viewBox="-8 -728 4782 936" role="img" aria-label="bumpsmith"><path d="M42.0,-720 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M42.0,-458.0 H260.0 A150,150 0 0 1 410.0,-308.0 V-192.0 A150,150 0 0 1 260.0,-42.0 H42.0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M586.0,-500 V-192.0 A150,150 0 0 0 736.0,-42.0 H926.0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M926.0,-500 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M1102.0,0 V-500" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M1102.0,-458.0 H1292.0 A150,150 0 0 1 1442.0,-308.0 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M1442.0,-458.0 H1632.0 A150,150 0 0 1 1782.0,-308.0 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M1958.0,-500 V200" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M1958.0,-458.0 H2176.0 A150,150 0 0 1 2326.0,-308.0 V-192.0 A150,150 0 0 1 2176.0,-42.0 H1958.0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M2864.0,-458.0 H2606.0 A104.0,104.0 0 0 0 2606.0,-250.0 H2718.0 A104.0,104.0 0 0 1 2718.0,-42.0 H2460.0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M2998.0,0 V-500" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M2998.0,-458.0 H3188.0 A150,150 0 0 1 3338.0,-308.0 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M3338.0,-458.0 H3528.0 A150,150 0 0 1 3678.0,-308.0 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M3854.0,0 V-500" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M4030.0,-640 V-154.5 A112.5,112.5 0 0 0 4142.5,-42.0 H4250.0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M3988.0,-458.0 H4250.0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M4384.0,-720 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><path d="M4384.0,-458.0 H4574.0 A150,150 0 0 1 4724.0,-308.0 V0" fill="none" stroke="currentColor" stroke-width="84" stroke-linejoin="round"/><rect x="3812.0" y="-720" width="84" height="84" rx="10" fill="var(--accent, #f25a1d)"/></svg>`;

// ───────────── formatting ─────────────

export const STATES: Record<string, { label: string; tone: string; short: string }> = {
  ready: { label: "Ready to apply", tone: "ok", short: "Ready" },
  safe: { label: "Safe, no code change", tone: "ok", short: "Safe" },
  needs_human: { label: "Needs a human", tone: "warn", short: "Needs a human" },
  blocked_policy: { label: "Blocked", tone: "bad", short: "Blocked" },
  failed_infra: { label: "Could not run", tone: "bad", short: "Could not run" },
  waiting_release_age: { label: "Waiting for release age", tone: "info", short: "Waiting" },
};
export const stateOf = (s: string) => STATES[s] ?? { label: s, tone: "", short: s };
export const statePill = (s: string) => {
  const st = stateOf(s);
  return `<span class="badge ${st.tone}"><span class="dot ${st.tone}"></span>${esc(st.short)}</span>`;
};
export const confPill = (c: string | null) =>
  c
    ? `<span class="badge ${c === "high" ? "ok" : c === "medium" ? "info" : "warn"}">${esc(c)} confidence</span>`
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
  const m = /^(\d+)([mhd])$/.exec(a);
  if (!m) return a;
  const n = Number(m[1]);
  const unit =
    m[2] === "m" ? "min" : m[2] === "h" ? (n === 1 ? "hour" : "hours") : n === 1 ? "day" : "days";
  return `${n} ${unit} ago`;
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

/** Tone of a state for status dots and icons. */
export const toneOf = (state: string) => stateOf(state).tone || "";

/** Status with an icon, GitHub-style: never colour alone. */
export function status(state: string, label?: string) {
  const st = stateOf(state);
  const ic =
    st.tone === "ok"
      ? "checkCircle"
      : st.tone === "bad"
        ? "xCircle"
        : st.tone === "info"
          ? "clock"
          : "alertCircle";
  return `<span class="st ${st.tone}">${icon(ic)}${esc(label ?? st.short)}</span>`;
}

/** Segmented meter: `on` of `total` ticks lit (at most 24 ticks). */
export function ticks(value: number, total: number, cls = "", n = 24) {
  const lit = total > 0 ? Math.round((value / total) * n) : 0;
  return `<div class="ticks ${cls}">${Array.from({ length: n }, (_, i) => `<i class="${i < lit ? "on" : ""}"></i>`).join("")}</div>`;
}

/** GitHub-style check strip: one circle per check, by what happened after the bump. */
export function checkStrip(checks: Check[]) {
  return `<span class="cs" title="${esc(
    checks
      .map(
        (c) =>
          `${c.name}: ${c.before === null ? "not run" : c.before ? "passed" : "failed"} before, ${c.after === null ? "not re-run" : c.after ? "passes" : c.sameFailures ? "same failures" : "fails"} after`,
      )
      .join("\n"),
  )}">${checks
    .map((c) => {
      const k = cellOf(c);
      const ic =
        k === "ok" || k === "same"
          ? icon("check")
          : k === "reg"
            ? icon("x")
            : k === "pre"
              ? icon("minus")
              : "";
      return `<i class="${k}">${ic}</i>`;
    })
    .join("")}</span>`;
}

/** "6.0.0 → 11.5.3" in mono. */
export const versions = (from: string | null, to: string) =>
  `<span class="ver">${esc(from ?? "?")}<span class="ar">→</span><b>${esc(to)}</b></span>`;

export const ecoBadge = (eco: string) =>
  `<span class="eco">${eco === "pypi" ? "pypi" : "npm"}</span>`;

/** Cell class for the check-health heatmap. */
export function cellOf(c: Check | undefined): string {
  if (!c || c.before === null) return "";
  if (c.after === null) return c.before ? "skip" : "pre";
  if (c.before && c.after) return "ok";
  if (c.before && !c.after) return "reg";
  if (c.sameFailures) return "same";
  return c.after ? "ok" : "pre";
}

const KW =
  /\b(import|from|export|default|const|let|var|function|return|async|await|if|else|elif|for|while|class|new|extends|implements|type|interface|enum|def|lambda|with|as|try|except|catch|finally|raise|throw|yield|None|True|False|null|undefined|true|false|in|of|is|not|and|or|pass|public|private|protected|readonly|static|this|self|typeof|instanceof|void|delete|switch|case|break|continue)\b/g;

/** Escaped text with `backticks` shown as inline code. */
export const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code class="ic">$1</code>');

/** Lightweight highlighting: comments, strings, keywords, numbers, calls. */
export function highlight(code: string, path: string): string {
  // Lines inside a block comment or docstring-style comment block.
  if (/^\s*(\*|\/\*\*?|\*\/)(\s|$|\/)/.test(code)) return `<span class="tok-c">${esc(code)}</span>`;
  if (/\.(json|lock|ya?ml|toml|txt|cfg|in)$|lock\.json$|Pipfile/.test(path)) {
    return esc(code)
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-p">$1</span>$2')
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

/**
 * Wrap the visible characters [from, to) of escaped, highlighted HTML in a tag (the
 * word-diff mark or a search match). Tags already in the HTML are not counted; the wrapper
 * is closed and reopened around them so nesting stays valid, and an entity counts as one
 * character.
 */
export function markRange(
  html: string,
  from: number,
  to: number,
  tag: "span" | "mark",
  attrs = "",
): string {
  const open = `<${tag}${attrs}>`;
  const close = `</${tag}>`;
  let out = "";
  let pos = 0;
  let inside = false;
  for (let i = 0; i < html.length; ) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i) + 1;
      const t = html.slice(i, end);
      out += inside ? `${close}${t}${open}` : t;
      i = end;
      continue;
    }
    if (pos === from && !inside) {
      out += open;
      inside = true;
    }
    const ch = html[i] === "&" ? html.slice(i, html.indexOf(";", i) + 1) : (html[i] as string);
    out += ch;
    i += ch.length;
    pos++;
    if (pos === to && inside) {
      out += close;
      inside = false;
    }
  }
  return (inside ? out + close : out).split(open + close).join("");
}
