// GitHub-style "Files changed": parsing, word-level highlights, unified and split views,
// expandable context, collapsed generated files. Everything user-supplied goes through esc().
import { esc, highlight, icon, markRange } from "./ui.ts";

export interface DLine {
  kind: "add" | "del" | "ctx";
  text: string;
  a: number | null;
  b: number | null;
}
export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: DLine[];
}
export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: "modified" | "added" | "deleted" | "renamed";
  binary: boolean;
  added: number;
  removed: number;
  hunks: Hunk[];
}

/** Parse a unified git diff. Hunk line counts decide where a hunk ends. */
export function parsePatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let f: FileDiff | null = null;
  let h: Hunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let a = 0;
  let b = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      f = {
        path: m?.[2] ?? line.slice(11),
        oldPath: null,
        status: "modified",
        binary: false,
        added: 0,
        removed: 0,
        hunks: [],
      };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (h && (oldLeft > 0 || newLeft > 0)) {
      const c = line[0];
      if (c === "+") {
        h.lines.push({ kind: "add", text: line.slice(1), a: null, b: b++ });
        f.added++;
        newLeft--;
        continue;
      }
      if (c === "-") {
        h.lines.push({ kind: "del", text: line.slice(1), a: a++, b: null });
        f.removed++;
        oldLeft--;
        continue;
      }
      if (c === " " || line === "") {
        h.lines.push({ kind: "ctx", text: line.slice(1), a: a++, b: b++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === "\\") continue; // "\ No newline at end of file"
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hm) {
      h = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: hm[5] ?? "",
        lines: [],
      };
      f.hunks.push(h);
      oldLeft = h.oldLines;
      newLeft = h.newLines;
      a = h.oldStart;
      b = h.newStart;
      continue;
    }
    if (line.startsWith("new file mode")) f.status = "added";
    else if (line.startsWith("deleted file mode")) f.status = "deleted";
    else if (line.startsWith("rename from ")) {
      f.status = "renamed";
      f.oldPath = line.slice(12);
    } else if (line.startsWith("Binary files")) f.binary = true;
    else if (line.startsWith("--- /dev/null")) f.status = "added";
    else if (line.startsWith("+++ /dev/null")) f.status = "deleted";
  }
  return files;
}

/** First new-file line a hunk covers, and the line after it (zero-length hunks included). */
const hunkNewStart = (h: Hunk) => (h.newLines === 0 ? h.newStart + 1 : h.newStart);
const hunkNewEnd = (h: Hunk) => (h.newLines === 0 ? h.newStart + 1 : h.newStart + h.newLines);
const hunkOldStart = (h: Hunk) => (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart);
const hunkOldEnd = (h: Hunk) => (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart + h.oldLines);

/** Unchanged lines hidden before hunk `i` (or after the last hunk when i === hunks.length). */
export function gapLines(
  file: FileDiff,
  i: number,
  full: string[] | null,
): { from: number; to: number; offset: number } | null {
  const hs = file.hunks;
  if (!hs.length || file.status === "added" || file.status === "deleted") return null;
  if (i < hs.length) {
    const h = hs[i] as Hunk;
    const from = i === 0 ? 1 : hunkNewEnd(hs[i - 1] as Hunk);
    const to = hunkNewStart(h) - 1;
    if (to < from) return null;
    return { from, to, offset: hunkOldStart(h) - hunkNewStart(h) };
  }
  const last = hs[hs.length - 1] as Hunk;
  const from = hunkNewEnd(last);
  const to = full ? full.length - (full[full.length - 1] === "" ? 1 : 0) : Number.POSITIVE_INFINITY;
  if (to < from) return null;
  return { from, to, offset: hunkOldEnd(last) - hunkNewEnd(last) };
}

/** Common prefix and suffix of two strings, for word-level highlights. */
export function wordDiff(x: string, y: string): { pre: number; suf: number } {
  let pre = 0;
  const n = Math.min(x.length, y.length);
  while (pre < n && x[pre] === y[pre]) pre++;
  // Extend back to a word boundary so highlights cover whole tokens.
  while (pre > 0 && /\w/.test(x[pre - 1] ?? "") && /\w/.test(x[pre] ?? "")) pre--;
  let suf = 0;
  while (suf < n - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  while (suf > 0 && /\w/.test(x[x.length - suf] ?? "") && /\w/.test(x[x.length - suf - 1] ?? ""))
    suf--;
  return { pre, suf };
}

/** Code with an optional highlighted range [s, e). */
function codeHtml(text: string, path: string, range: [number, number] | null) {
  const html = highlight(text, path);
  if (!range || range[0] >= range[1] || text.length > 600) return html;
  return markRange(html, range[0], range[1], "span", ' class="wx"');
}

/** Pair each run of deletions with the additions that follow it (for word diff and split view). */
function pairRuns(lines: DLine[]) {
  const ranges = new Map<DLine, [number, number]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind !== "del") {
      i++;
      continue;
    }
    let j = i;
    while (lines[j]?.kind === "del") j++;
    let k = j;
    while (lines[k]?.kind === "add") k++;
    const dels = lines.slice(i, j);
    const adds = lines.slice(j, k);
    for (let p = 0; p < Math.min(dels.length, adds.length); p++) {
      const d = dels[p] as DLine;
      const ad = adds[p] as DLine;
      const { pre, suf } = wordDiff(d.text, ad.text);
      // Skip highlights when almost the whole line changed: they only add noise.
      const changed = Math.max(d.text.length, ad.text.length) - pre - suf;
      if (changed > 0 && changed < Math.max(d.text.length, ad.text.length) * 0.9) {
        ranges.set(d, [pre, d.text.length - suf]);
        ranges.set(ad, [pre, ad.text.length - suf]);
      }
    }
    i = k;
  }
  return ranges;
}

export interface FileView {
  open: boolean;
  viewed: boolean;
  loaded: boolean; // generated / large files: diff loaded on request
  full: string[] | null; // the new file, once fetched (expand context)
  expanded: Set<number>; // gap indexes shown
}

const n = (v: number | null) => (v === null ? "" : `data-n="${v}"`);

function expander(fi: number, gi: number, dir: "up" | "down" | "both", count: number | null) {
  const label = count === null ? "Expand" : `Expand ${count} line${count === 1 ? "" : "s"}`;
  return `<button class="dx" data-act="diff-expand" data-f="${fi}" data-g="${gi}" title="${label}" aria-label="${label}">${icon(dir === "down" ? "chevronDown" : dir === "up" ? "chevronUp" : "unfold")}</button>`;
}

function contextRows(
  full: string[],
  gap: { from: number; to: number; offset: number },
  path: string,
  split: boolean,
) {
  let out = "";
  for (let ln = gap.from; ln <= gap.to; ln++) {
    const text = full[ln - 1] ?? "";
    const code = highlight(text, path);
    out += split
      ? `<tr class="dl dc2"><td class="dn" ${n(ln + gap.offset)}></td><td class="dc"><span class="dm"> </span>${code}</td><td class="dn" ${n(ln)}></td><td class="dc"><span class="dm"> </span>${code}</td></tr>`
      : `<tr class="dl dc2"><td class="dn" ${n(ln + gap.offset)}></td><td class="dn" ${n(ln)}></td><td class="dc"><span class="dm"> </span>${code}</td></tr>`;
  }
  return out;
}

function hunkRow(file: FileDiff, fi: number, hi: number, view: FileView, split: boolean) {
  const h = file.hunks[hi] as Hunk;
  const gap = gapLines(file, hi, view.full);
  const count = gap ? gap.to - gap.from + 1 : 0;
  const btn =
    gap && !view.expanded.has(hi) ? expander(fi, hi, hi === 0 ? "up" : "both", count) : "";
  const head = `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` <span class="sec">${esc(h.section)}</span>` : ""}`;
  return split
    ? `<tr class="dh"><td class="dn dhx">${btn}</td><td class="dc" colspan="3">${head}</td></tr>`
    : `<tr class="dh"><td class="dn dhx" colspan="2">${btn}</td><td class="dc">${head}</td></tr>`;
}

function unifiedRows(file: FileDiff, fi: number, view: FileView) {
  const ranges = new Map<DLine, [number, number]>();
  for (const h of file.hunks) for (const [k, v] of pairRuns(h.lines)) ranges.set(k, v);
  let out = "";
  file.hunks.forEach((h, hi) => {
    const gap = gapLines(file, hi, view.full);
    if (gap && view.expanded.has(hi) && view.full)
      out += contextRows(view.full, gap, file.path, false);
    else out += hunkRow(file, fi, hi, view, false);
    for (const l of h.lines) {
      const cls = l.kind === "add" ? "da" : l.kind === "del" ? "dd" : "";
      const mk = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      out += `<tr class="dl ${cls}"><td class="dn" ${n(l.a)}></td><td class="dn" ${n(l.b)}></td><td class="dc"><span class="dm">${mk}</span>${codeHtml(l.text, file.path, ranges.get(l) ?? null)}</td></tr>`;
    }
  });
  out += tailRows(file, fi, view, false);
  return out;
}

function splitRows(file: FileDiff, fi: number, view: FileView) {
  let out = "";
  file.hunks.forEach((h, hi) => {
    const gap = gapLines(file, hi, view.full);
    if (gap && view.expanded.has(hi) && view.full)
      out += contextRows(view.full, gap, file.path, true);
    else out += hunkRow(file, fi, hi, view, true);
    const ranges = pairRuns(h.lines);
    const ls = h.lines;
    for (let i = 0; i < ls.length; ) {
      const l = ls[i] as DLine;
      if (l.kind === "ctx") {
        const code = highlight(l.text, file.path);
        out += `<tr class="dl"><td class="dn" ${n(l.a)}></td><td class="dc"><span class="dm"> </span>${code}</td><td class="dn" ${n(l.b)}></td><td class="dc"><span class="dm"> </span>${code}</td></tr>`;
        i++;
        continue;
      }
      let j = i;
      while (ls[j]?.kind === "del") j++;
      let k = j;
      while (ls[k]?.kind === "add") k++;
      const dels = ls.slice(i, j);
      const adds = ls.slice(j, k);
      for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
        const d = dels[p];
        const ad = adds[p];
        const left = d
          ? `<td class="dn dd" ${n(d.a)}></td><td class="dc dd"><span class="dm">-</span>${codeHtml(d.text, file.path, ranges.get(d) ?? null)}</td>`
          : `<td class="dn de"></td><td class="dc de"></td>`;
        const right = ad
          ? `<td class="dn da" ${n(ad.b)}></td><td class="dc da"><span class="dm">+</span>${codeHtml(ad.text, file.path, ranges.get(ad) ?? null)}</td>`
          : `<td class="dn de"></td><td class="dc de"></td>`;
        out += `<tr class="dl">${left}${right}</tr>`;
      }
      i = k > i ? k : i + 1;
    }
  });
  out += tailRows(file, fi, view, true);
  return out;
}

function tailRows(file: FileDiff, fi: number, view: FileView, split: boolean) {
  const gi = file.hunks.length;
  const gap = gapLines(file, gi, view.full);
  if (!gap) return "";
  if (view.expanded.has(gi) && view.full) return contextRows(view.full, gap, file.path, split);
  const count = Number.isFinite(gap.to) ? gap.to - gap.from + 1 : null;
  if (count === 0) return "";
  const btn = expander(fi, gi, "down", count);
  return split
    ? `<tr class="dh dt-end"><td class="dn dhx">${btn}</td><td class="dc" colspan="3"></td></tr>`
    : `<tr class="dh dt-end"><td class="dn dhx" colspan="2">${btn}</td><td class="dc"></td></tr>`;
}

export const isLockfile = (p: string) =>
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|pdm\.lock)$/.test(
    p,
  );
export const isManifest = (p: string) =>
  /(^|\/)(package\.json|pyproject\.toml|Pipfile|setup\.(py|cfg)|requirements[^/]*\.(txt|in))$/.test(
    p,
  );

/** GitHub's five diffstat squares. */
export function diffSquares(added: number, removed: number) {
  const total = added + removed;
  const colored = Math.min(5, total);
  const green = total ? Math.round((colored * added) / total) : 0;
  const red = colored - green;
  return `<span class="sq">${Array.from({ length: 5 }, (_, i) => `<i class="${i < green ? "a" : i < green + red ? "d" : ""}"></i>`).join("")}</span>`;
}

export type Who = "agent" | "lock" | "manifest" | "other";
export const whoOf = (p: string, edited: Set<string>): Who =>
  edited.has(p) ? "agent" : isLockfile(p) ? "lock" : isManifest(p) ? "manifest" : "other";

const WHO_LABEL: Record<Who, string> = {
  agent: "edited by the agent",
  lock: "package manager",
  manifest: "version bump",
  other: "",
};

/** One file card: sticky header, then the diff (or why it is hidden). */
export function fileCard(
  file: FileDiff,
  fi: number,
  view: FileView,
  opts: { split: boolean; wrap: boolean; who: Who; reason: string | null },
) {
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);
  const changed = file.added + file.removed;
  const generated = opts.who === "lock";
  const large = changed > 400;
  const hidden = !view.loaded && (generated || large);
  const status =
    file.status === "added"
      ? `<span class="badge ok">new file</span>`
      : file.status === "deleted"
        ? `<span class="badge bad">deleted</span>`
        : file.status === "renamed"
          ? `<span class="badge info">renamed from ${esc(file.oldPath ?? "")}</span>`
          : "";
  const header = `<div class="fd-h">
    <button class="btn icon ghost fd-tg" data-act="file-toggle" data-f="${fi}" aria-expanded="${view.open && !view.viewed}" title="${view.open ? "Collapse" : "Expand"} file">${icon(view.open && !view.viewed ? "chevronDown" : "chevronRight")}</button>
    ${!hidden && !file.binary && file.status === "modified" ? `<button class="btn icon ghost" data-act="file-expand-all" data-f="${fi}" title="Expand all lines">${icon("unfold")}</button>` : ""}
    <span class="fd-stat">${changed}${diffSquares(file.added, file.removed)}</span>
    <span class="fd-path" title="${esc(file.path)}"><span class="dir">${esc(dir)}</span><b>${esc(name)}</b></span>
    <button class="btn icon ghost" data-act="copy-text" data-v="${esc(file.path)}" title="Copy path">${icon("copy")}</button>
    ${status}
    ${opts.who !== "other" ? `<span class="who who-${opts.who}" ${opts.reason ? `title="${esc(opts.reason)}"` : ""}>${WHO_LABEL[opts.who]}</span>` : ""}
    <label class="viewed ${view.viewed ? "on" : ""}"><input type="checkbox" data-act="file-viewed" data-f="${fi}" ${view.viewed ? "checked" : ""}/>Viewed</label>
  </div>`;
  if (!view.open || view.viewed) return `<section class="fd" id="file-${fi}">${header}</section>`;
  let body: string;
  if (file.binary) body = `<div class="fd-note">Binary file not shown.</div>`;
  else if (hidden)
    body = `<div class="fd-note">${generated ? "Lockfile changes are written by the package manager and are not shown by default." : `Large diff (${changed} lines) is not shown by default.`}<button class="btn" data-act="file-load" data-f="${fi}">Load diff</button></div>`;
  else if (!file.hunks.length)
    body = `<div class="fd-note">${file.status === "renamed" ? "File renamed without changes." : "No content changes."}</div>`;
  else
    body = `<div class="dtw"><table class="dt ${opts.split ? "dt-split" : "dt-uni"} ${opts.wrap ? "dt-wrap" : ""}">${
      opts.split
        ? `<colgroup><col class="cn"><col><col class="cn"><col></colgroup>${splitRows(file, fi, view)}`
        : `<colgroup><col class="cn"><col class="cn"><col></colgroup>${unifiedRows(file, fi, view)}`
    }</table></div>`;
  return `<section class="fd ${opts.who === "agent" ? "fd-agent" : ""}" id="file-${fi}">${header}${body}</section>`;
}

// ───────────── file tree ─────────────

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file: number | null;
}

/** Folder tree with single-child folder chains collapsed ("packages/monosize/src"). */
export function fileTree(
  files: FileDiff[],
  opts: { active: number; filter: string; edited: Set<string>; viewed: (i: number) => boolean },
) {
  const root: TreeNode = { name: "", path: "", children: new Map(), file: null };
  const q = opts.filter.toLowerCase();
  files.forEach((f, i) => {
    if (q && !f.path.toLowerCase().includes(q)) return;
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((part, pi) => {
      const path = parts.slice(0, pi + 1).join("/");
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, path, children: new Map(), file: pi === parts.length - 1 ? i : null };
        node.children.set(part, next);
      }
      node = next;
    });
  });
  const compress = (node: TreeNode): TreeNode => {
    for (const [k, c] of node.children) node.children.set(k, compress(c));
    if (node.file === null && node.children.size === 1 && node !== root) {
      const only = [...node.children.values()][0] as TreeNode;
      if (only.file === null) return { ...only, name: `${node.name}/${only.name}` };
    }
    return node;
  };
  const tree = compress(root);
  const statusIcon = (f: FileDiff) =>
    f.status === "added"
      ? `<span class="fs fs-a" title="added">${icon("plusSquare")}</span>`
      : f.status === "deleted"
        ? `<span class="fs fs-d" title="deleted">${icon("minusSquare")}</span>`
        : f.status === "renamed"
          ? `<span class="fs fs-r" title="renamed">${icon("arrowR")}</span>`
          : `<span class="fs fs-m" title="modified">${icon("dotSquare")}</span>`;
  const render = (node: TreeNode, depth: number): string =>
    [...node.children.values()]
      .sort(
        (a, b) => Number(a.file !== null) - Number(b.file !== null) || a.name.localeCompare(b.name),
      )
      .map((c) => {
        const pad = `style="padding-left:${8 + depth * 16}px"`;
        if (c.file === null)
          return `<div class="tn tn-dir" ${pad}>${icon("folder")}<span>${esc(c.name)}</span></div>${render(c, depth + 1)}`;
        const f = files[c.file] as FileDiff;
        return `<button class="tn tn-file ${c.file === opts.active ? "on" : ""} ${opts.viewed(c.file) ? "viewed" : ""}" ${pad} data-act="file-jump" data-f="${c.file}" title="${esc(f.path)}">${icon("file")}<span class="tn-name">${esc(c.name)}</span>${opts.edited.has(f.path) ? `<i class="tn-agent" title="edited by the agent"></i>` : ""}${statusIcon(f)}</button>`;
      })
      .join("");
  const body = render(tree, 0);
  return body || `<div class="tn-empty">No files match</div>`;
}

/** Before/after example as a small diff (GitHub "suggested change" style). */
/**
 * API signatures from .d.ts files arrive on one line with their doc comments. Drop the
 * comments and put each member of the outer body on its own line so the change is readable.
 */
export function tidySignature(src: string): string {
  if (!src || src.includes("\n")) return src;
  const s = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length < 100 || !s.includes("{")) return s;
  let out = "";
  let depth = 0;
  let quote = "";
  const skipSpace = (i: number) => {
    let j = i;
    while (s[j + 1] === " ") j++;
    return j;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (quote) {
      out += ch;
      if (ch === quote && s[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "{") {
      depth++;
      if (depth === 1) {
        out += "{\n  ";
        i = skipSpace(i);
      } else out += ch;
    } else if (ch === "}") {
      if (depth === 1) out = `${out.trimEnd()}\n}`;
      else out += ch;
      depth = Math.max(0, depth - 1);
    } else if (ch === ";" && depth === 1) {
      out += ";\n  ";
      i = skipSpace(i);
    } else out += ch;
  }
  return out.trimEnd();
}

/** Line diff (longest common subsequence) for short before/after snippets. */
export function lineDiff(a: string[], b: string[]): DLine[] {
  const del = (t: string): DLine => ({ kind: "del", text: t, a: null, b: null });
  const add = (t: string): DLine => ({ kind: "add", text: t, a: null, b: null });
  if (a.length * b.length > 40_000) return [...a.map(del), ...b.map(add)];
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number) => dp[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      (dp[i] as number[])[j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const out: DLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] as string, a: null, b: null });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) out.push(del(a[i++] as string));
    else out.push(add(b[j++] as string));
  }
  while (i < n) out.push(del(a[i++] as string));
  while (j < m) out.push(add(b[j++] as string));
  return out;
}

export function snippetDiff(rawBefore: string, rawAfter: string, path: string) {
  const before = tidySignature(rawBefore);
  const after = tidySignature(rawAfter);
  const lines = lineDiff(before ? before.split("\n") : [], after ? after.split("\n") : []);
  const ranges = pairRuns(lines);
  const firstDel = lines.findIndex((l) => l.kind === "del");
  const firstAdd = lines.findIndex((l) => l.kind === "add");
  return `<div class="dtw snip"><table class="dt dt-uni dt-wrap"><colgroup><col><col></colgroup>${lines
    .map((l, i) => {
      const cls = l.kind === "add" ? "da" : l.kind === "del" ? "dd" : "dc2";
      const label = i === firstDel ? "before" : i === firstAdd ? "after" : "";
      const mark = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      return `<tr class="dl ${cls}"><td class="dn sn">${label}</td><td class="dc"><span class="dm">${mark}</span>${codeHtml(l.text, path, ranges.get(l) ?? null)}</td></tr>`;
    })
    .join("")}</table></div>`;
}
