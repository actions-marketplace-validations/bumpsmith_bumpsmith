// A small, safe Markdown renderer for evidence.md (GitHub-flavoured subset): headings,
// paragraphs, nested lists, blockquotes, tables, fenced code, inline code, bold, italics
// and links. Everything is escaped first; links must be http(s).
import { esc, highlight } from "./ui.ts";

function inline(raw: string): string {
  const codes: string[] = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\uE000${codes.length - 1}\uE000`;
  });
  s = s
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (_m, t: string, u: string) =>
        `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`,
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_(\S[^\n]*?)_(?=$|[\s).,;:])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:])/g, "$1<em>$2</em>");
  return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => codes[Number(i)] ?? "");
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

interface Item {
  indent: number;
  ordered: boolean;
  text: string;
}

function list(items: Item[]): string {
  // Build nested lists from indentation.
  let html = "";
  const stack: { indent: number; ordered: boolean }[] = [];
  for (const it of items) {
    while (stack.length && (stack[stack.length - 1]?.indent ?? 0) > it.indent) {
      const top = stack.pop();
      html += `</li></${top?.ordered ? "ol" : "ul"}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || top.indent < it.indent) {
      stack.push({ indent: it.indent, ordered: it.ordered });
      html += `<${it.ordered ? "ol" : "ul"}><li>`;
    } else html += "</li><li>";
    const quote = /^>\s?(.*)$/.exec(it.text);
    html += quote ? `<blockquote>${inline(quote[1] ?? "")}</blockquote>` : inline(it.text);
  }
  while (stack.length) {
    const top = stack.pop();
    html += `</li></${top?.ordered ? "ol" : "ul"}>`;
  }
  return html;
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  let html = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```\s*([\w-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) body.push(lines[i++] ?? "");
      i++;
      const lang = fence[1] ?? "";
      html += `<pre><code>${body.map((b) => highlight(b, `x.${lang || "txt"}`)).join("\n")}</code></pre>`;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]?.length ?? 1;
      html += `<h${level}>${inline(h[2] ?? "")}</h${level}>`;
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      html += "<hr />";
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      html += `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? ""))
        body.push((lines[i++] ?? "").replace(/^>\s?/, ""));
      html += `<blockquote><p>${inline(body.join(" "))}</p></blockquote>`;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: Item[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i] ?? "");
        if (!m) {
          // A continuation line of the previous item.
          const cont = lines[i] ?? "";
          if (cont.trim() && /^\s{2,}/.test(cont) && items.length) {
            const last = items[items.length - 1] as Item;
            last.text += ` ${cont.trim()}`;
            i++;
            continue;
          }
          break;
        }
        items.push({ indent: m[1]?.length ?? 0, ordered: /\d/.test(m[2] ?? ""), text: m[3] ?? "" });
        i++;
      }
      html += list(items);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !/^(#{1,6}\s|```|>\s?|\s*([-*+]|\d+\.)\s+|\s*\|)/.test(lines[i] ?? "")
    )
      para.push(lines[i++] ?? "");
    if (para.length) html += `<p>${inline(para.join(" "))}</p>`;
    else i++;
  }
  return html;
}
