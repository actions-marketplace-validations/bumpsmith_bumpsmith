// ANSI colour codes in check output (test runners, Nx, pnpm, pytest), rendered the way the
// GitHub Actions log does instead of showing "[38;5;214m" noise. Only SGR codes become
// styles; every other escape sequence is dropped. Text is escaped; styles are computed
// from numbers only.
import { esc } from "./ui.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC
const CSI = /\u001b\[([0-9;?]*)([A-Za-z])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC
const OSC = /\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC
const LONE = /\u001b[@-Z\\-_]?/g;

// The 16 base colours, tuned for the dark log background.
const BASE = [
  "#6e7681",
  "#ff7b72",
  "#3fb950",
  "#d29922",
  "#58a6ff",
  "#bc8cff",
  "#39c5cf",
  "#b1bac4",
  "#8b949e",
  "#ffa198",
  "#56d364",
  "#e3b341",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#f0f6fc",
];

function c256(n: number): string {
  if (n < 16) return BASE[n] as string;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const lv = (v: number) => (v ? 55 + v * 40 : 0);
  return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
}

export const stripAnsi = (s: string) => s.replace(OSC, "").replace(CSI, "").replace(LONE, "");

export const hasAnsi = (s: string) => s.includes("\u001b");

interface Sgr {
  b?: boolean;
  d?: boolean;
  i?: boolean;
  u?: boolean;
  inv?: boolean;
  fg?: string;
  bg?: string;
}

function apply(st: Sgr, params: string): Sgr {
  const p = params === "" ? [0] : params.split(";").map((x) => Number(x) || 0);
  const s = { ...st };
  for (let k = 0; k < p.length; k++) {
    const n = p[k] as number;
    if (n === 0) for (const key of Object.keys(s)) delete s[key as keyof Sgr];
    else if (n === 1) s.b = true;
    else if (n === 2) s.d = true;
    else if (n === 3) s.i = true;
    else if (n === 4) s.u = true;
    else if (n === 7) s.inv = true;
    else if (n === 22) s.b = s.d = false;
    else if (n === 23) s.i = false;
    else if (n === 24) s.u = false;
    else if (n === 27) s.inv = false;
    else if (n >= 30 && n <= 37) s.fg = BASE[n - 30];
    else if (n >= 90 && n <= 97) s.fg = BASE[n - 82];
    else if (n >= 40 && n <= 47) s.bg = BASE[n - 40];
    else if (n >= 100 && n <= 107) s.bg = BASE[n - 92];
    else if (n === 39) delete s.fg;
    else if (n === 49) delete s.bg;
    else if ((n === 38 || n === 48) && p[k + 1] === 5) {
      s[n === 38 ? "fg" : "bg"] = c256(Math.min(255, Math.max(0, p[k + 2] ?? 0)));
      k += 2;
    } else if ((n === 38 || n === 48) && p[k + 1] === 2) {
      const [r, g, b] = [p[k + 2], p[k + 3], p[k + 4]].map((v) =>
        Math.min(255, Math.max(0, v ?? 0)),
      );
      s[n === 38 ? "fg" : "bg"] = `rgb(${r},${g},${b})`;
      k += 4;
    }
  }
  return s;
}

function style(s: Sgr): string {
  const css: string[] = [];
  let fg = s.fg;
  let bg = s.bg;
  if (s.inv) [fg, bg] = [bg ?? "#0d0d0c", fg ?? "#d8d5cf"];
  if (fg) css.push(`color:${fg}`);
  if (bg) css.push(`background:${bg}`);
  if (s.b) css.push("font-weight:600");
  if (s.d) css.push("opacity:.7");
  if (s.i) css.push("font-style:italic");
  if (s.u) css.push("text-decoration:underline");
  return css.join(";");
}

/** Escaped HTML for one line of output with its ANSI colours applied. */
export function ansiHtml(raw: string): string {
  const text = raw.replace(OSC, "");
  let out = "";
  let st: Sgr = {};
  let last = 0;
  const emit = (seg: string) => {
    if (!seg) return;
    const clean = esc(seg.replace(LONE, ""));
    const css = style(st);
    out += css ? `<span style="${css}">${clean}</span>` : clean;
  };
  for (const m of text.matchAll(CSI)) {
    emit(text.slice(last, m.index));
    if (m[2] === "m") st = apply(st, m[1] ?? "");
    last = (m.index ?? 0) + m[0].length;
  }
  emit(text.slice(last));
  return out;
}
