// The dashboard's diff, log and Markdown renderers: they turn untrusted run output (patches,
// command output, evidence.md written from changelogs) into HTML, so correctness and escaping
// are both tested here.
import { describe, expect, it } from "vitest";
import { ansiHtml, stripAnsi } from "../../src/dashboard/client/ansi.ts";
import {
  fileCard,
  gapLines,
  lineDiff,
  parsePatch,
  snippetDiff,
  tidySignature,
  wordDiff,
} from "../../src/dashboard/client/diff.ts";
import { buildSteps, jobLog, logLines, outputLines } from "../../src/dashboard/client/log.ts";
import { renderMarkdown } from "../../src/dashboard/client/markdown.ts";
import { markRange } from "../../src/dashboard/client/ui.ts";

const PATCH = `diff --git a/package.json b/package.json
index 1111111..2222222 100644
--- a/package.json
+++ b/package.json
@@ -10,7 +10,7 @@ "dependencies": {
   "a": "1",
   "b": "2",
   "c": "3",
-  "zod": "^3.23.8",
+  "zod": "^4.1.0",
   "d": "4",
   "e": "5",
   "f": "6"
@@ -40,3 +40,4 @@
   "x": 1,
   "y": 2,
+  "z": 3,
   "w": 4
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const n = 1;
+// <script>alert(1)</script>
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-export {};
diff --git a/src/from.ts b/src/to.ts
similarity index 90%
rename from src/from.ts
rename to src/to.ts
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

describe("parsePatch", () => {
  const files = parsePatch(PATCH);

  it("reads every file with its status and line counts", () => {
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["package.json", "modified", 2, 1],
      ["src/new.ts", "added", 2, 0],
      ["src/old.ts", "deleted", 0, 1],
      ["src/to.ts", "renamed", 0, 0],
      ["logo.png", "modified", 0, 0],
    ]);
    expect(files[3]?.oldPath).toBe("src/from.ts");
    expect(files[4]?.binary).toBe(true);
  });

  it("numbers old and new lines through each hunk", () => {
    const h = files[0]?.hunks[0];
    expect(h?.section).toContain('"dependencies"');
    const del = h?.lines.find((l) => l.kind === "del");
    const add = h?.lines.find((l) => l.kind === "add");
    expect([del?.a, del?.b, add?.a, add?.b]).toEqual([13, null, null, 13]);
    expect(h?.lines.at(-1)).toMatchObject({ kind: "ctx", a: 16, b: 16 });
    expect(files[0]?.hunks[1]?.lines.at(-1)).toMatchObject({ kind: "ctx", a: 42, b: 43 });
  });

  it("finds the hidden lines between hunks, and after the last one", () => {
    const f = files[0];
    if (!f) throw new Error("no file");
    expect(gapLines(f, 0, null)).toEqual({ from: 1, to: 9, offset: 0 });
    expect(gapLines(f, 1, null)).toEqual({ from: 17, to: 39, offset: 0 });
    const full = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).concat("");
    expect(gapLines(f, 2, full)).toEqual({ from: 44, to: 50, offset: -1 });
    expect(gapLines(files[1] as typeof f, 0, null)).toBeNull();
  });
});

describe("diff rendering", () => {
  it("escapes file content and paths", () => {
    const [, added] = parsePatch(PATCH);
    if (!added) throw new Error("no file");
    const html = fileCard(
      added,
      1,
      { open: true, viewed: false, loaded: false, full: null, expanded: new Set() },
      { split: false, wrap: false, who: "agent", reason: null },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("highlights the changed words and keeps their syntax colour", () => {
    expect(wordDiff('"zod": "^3.23.8",', '"zod": "^4.1.0",')).toEqual({ pre: 9, suf: 2 });
    const html = markRange(
      '<span class="tok-s">&quot;^3.23.8&quot;</span>',
      2,
      8,
      "span",
      ' class="wx"',
    );
    expect(html).toBe('<span class="tok-s">&quot;^<span class="wx">3.23.8</span>&quot;</span>');
    expect(markRange("a<b>c</b>d", 0, 3, "mark")).toBe(
      "<mark>a</mark><b><mark>c</mark></b><mark>d</mark>",
    );
  });

  it("formats one-line API signatures and diffs them line by line", () => {
    const before =
      "interface Options { /** Docs. */ readonly a?: boolean; readonly b?: number; readonly locale?: string | readonly string[]; }";
    const after =
      "type Options = { readonly a?: boolean; readonly b?: number; readonly locale?: string | readonly string[]; readonly c?: boolean; };";
    expect(tidySignature(before)).toBe(
      "interface Options {\n  readonly a?: boolean;\n  readonly b?: number;\n  readonly locale?: string | readonly string[];\n}",
    );
    const lines = lineDiff(tidySignature(before).split("\n"), tidySignature(after).split("\n"));
    expect(lines.map((l) => l.kind)).toEqual([
      "del",
      "add",
      "ctx",
      "ctx",
      "ctx",
      "del",
      "add",
      "add",
    ]);
    expect(snippetDiff(before, after, "x.ts")).not.toContain("Docs.");
    expect(tidySignature("(n: number) => string")).toBe("(n: number) => string");
  });
});

describe("job log", () => {
  it("renders ANSI colours as styles and strips them for search", () => {
    const raw =
      "\u001b[7m\u001b[1m\u001b[31m NX \u001b[39m\u001b[22m\u001b[27m failed <x>\u001b]8;;http://a\u0007link\u001b]8;;\u0007";
    expect(stripAnsi(raw)).toBe(" NX  failed <x>link");
    const html = ansiHtml(raw);
    expect(html).toContain("background:#ff7b72");
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("\u001b");
    expect(ansiHtml("\u001b[38;5;214mwarn\u001b[0m ok")).toBe(
      '<span style="color:rgb(255,175,0)">warn</span> ok',
    );
    const out = logLines(outputLines(raw), "fail");
    expect(out).toContain("<mark>fail</mark>");
    expect(out).toMatch(/class="ll err"/);
  });

  it("keeps the last redraw of a progress line and trims blank runs", () => {
    expect(outputLines("\n\nstep 1/3\rstep 3/3\n\n\n\ndone\n\n").map((l) => l.text)).toEqual([
      "step 3/3",
      "",
      "done",
    ]);
  });

  it("builds steps from a run, and a red baseline does not fail the run", () => {
    const check = (name: string, passed: boolean) => ({
      name,
      command: `pnpm ${name}`,
      exit_code: passed ? 0 : 1,
      passed,
      duration_ms: 1200,
      timed_out: false,
      output_tail: passed ? "ok" : "Error: boom",
    });
    const job = {
      id: "r1",
      created_at: "2026-11-18T00:00:00.000Z",
      input: { repo: "/r", packageName: "zod", to: "4.1.0", ecosystem: "npm" },
      provider: "fake",
      state: "ready",
      from: "3.23.8",
      duration_ms: 60_000,
      baseline: [check("build", true), check("lint", false)],
      after_bump: [check("build", false), check("lint", false)],
      rounds: [
        {
          round: 1,
          stop: "completed",
          summary: "Fixed the import.",
          checks: [check("build", true), check("lint", false)],
        },
      ],
      tool_log: [
        {
          tool: "edit_file",
          input: { path: "src/a.ts" },
          ok: true,
          summary: "Edited src/a.ts",
          at: "2026-11-18T00:01:05.000Z",
        },
      ],
      verdict: { passed: true },
      review: { verdict: "approve", criteria: [{ id: "scope", pass: true, reason: "minimal" }] },
      notes: [],
    };
    const steps = buildSteps(job);
    const by = (id: string) => steps.find((s) => s.id === id);
    expect(by("before-lint")?.status).toBe("warn");
    expect(
      by("before-lint")
        ?.lines.slice(-2)
        .map((l) => [l.text, l.kind]),
    ).toEqual([
      ["Process completed with exit code 1.", "warn"],
      ["This check already fails before the upgrade, so it is not counted against it.", "dim"],
    ]);
    expect(by("after-build")?.lines.at(-1)).toEqual({
      text: "Process completed with exit code 1.",
      kind: "err",
    });
    expect(by("before-build")?.lines.at(-1)?.text).toBe("Exited with code 0 in 1s.");
    expect(by("after-lint")?.status).toBe("warn");
    expect(by("after-build")?.status).toBe("fail");
    expect(by("fix")?.lines.find((l) => l.text.startsWith("edit_file"))?.at).toBe("+01:05");
    expect(by("result")?.status).toBe("ok");
    const html = jobLog(steps, { open: new Set(), query: "", title: "Run r1" });
    expect(html).toContain('class="jl-st ok"');
    expect(html).toContain("1 failed");
  });
});

describe("renderMarkdown", () => {
  it("renders the GitHub subset", () => {
    const html = renderMarkdown(
      "# T\n\n**b** and _i_ and `c`\n\n- one\n  - two\n- > quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```",
    );
    expect(html).toContain("<h1>T</h1>");
    expect(html).toContain("<strong>b</strong> and <em>i</em> and <code>c</code>");
    expect(html).toContain(
      "<ul><li>one<ul><li>two</li></ul></li><li><blockquote>quote</blockquote></li></ul>",
    );
    expect(html).toContain(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    expect(html).toContain('<pre><code><span class="tok-k">const</span>');
  });

  it("never lets HTML or script links through", () => {
    const html = renderMarkdown(
      '<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](https://ok.example/"onmouseover=1) `<b>`\n\n```\n<script>\n```',
    );
    expect(html).not.toMatch(/<img|<script|href="javascript/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain(
      '<a href="https://ok.example/&quot;onmouseover=1" target="_blank" rel="noopener noreferrer">y</a>',
    );
    expect(html).toContain("<code>&lt;b&gt;</code>");
  });
});
