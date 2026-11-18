// Static pieces of the finished video, drawn in Chromium so the type is the dashboard's own Geist:
// the stage (background and browser window), the pointer, caption pills, and title and end cards.
// All at 2x for a 1920x1080 video.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Browser } from "playwright";

const ROOT = resolve(import.meta.dirname, "../..");
const font = (f: string) => readFileSync(join(ROOT, "dashboard", "fonts", f)).toString("base64");
const wordmark = (theme: Theme) =>
  readFileSync(join(ROOT, "dashboard", "brand", `wordmark-${theme}.svg`), "utf8");
type Theme = "light" | "dark";

/** Where the recorded viewport sits on the stage (CSS px of a 1920x1080 frame). */
export const STAGE = { w: 1920, h: 1080, x: 240, y: 108, cw: 1440, ch: 900, bar: 36, radius: 14 };

const head = (theme: Theme) => `<meta charset="utf-8"><style>
@font-face { font-family: Geist; src: url(data:font/woff2;base64,${font("geist.woff2")}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: "Geist Mono"; src: url(data:font/woff2;base64,${font("geist-mono.woff2")}) format("woff2"); font-weight: 100 900; }
html, body { margin: 0; background: transparent; }
body { font-family: Geist, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
.bg { position: absolute; inset: 0;
  background:
    radial-gradient(1100px 700px at 12% -10%, rgba(242, 90, 29, 0.16), transparent 60%),
    radial-gradient(900px 600px at 105% 110%, rgba(242, 90, 29, 0.10), transparent 60%),
    linear-gradient(180deg, #f7f6f2, #ecebe5); }
${
  theme === "dark"
    ? `.bg { background: radial-gradient(1100px 700px at 12% -10%, rgba(242, 90, 29, 0.20), transparent 60%),
    radial-gradient(900px 600px at 105% 110%, rgba(242, 90, 29, 0.12), transparent 60%), linear-gradient(180deg, #121211, #0b0b0a); }
  .win { background: #0f0f0e !important; box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 30px 60px -12px rgba(0,0,0,.6), 0 60px 140px -30px rgba(0,0,0,.7) !important; }
  .bar { background: linear-gradient(#1d1d1c, #171716) !important; box-shadow: inset 0 -1px 0 rgba(255,255,255,.06) !important; }
  .url { background: rgba(255,255,255,.06) !important; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06) !important; color: #8f8c86 !important; }
  .url b { color: #d8d6d0 !important; }
  .wm svg, h1 { color: #f4f3ef !important; } h1 { color: #f4f3ef !important; } p, .row { color: #a3a19b !important; } .row i { background: #4a4844 !important; }
  .grain { opacity: .07; }`
    : ""
}
.grain { position: absolute; inset: 0; opacity: .05;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
</style>`;

const stageHtml = (url: string, theme: Theme) => `${head(theme)}<style>
.win { position: absolute; left: ${STAGE.x}px; top: ${STAGE.y - STAGE.bar}px; width: ${STAGE.cw}px; height: ${STAGE.ch + STAGE.bar}px;
  border-radius: ${STAGE.radius}px; background: #fbfaf8; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(20,20,18,.10), 0 2px 4px rgba(20,20,18,.06), 0 30px 60px -12px rgba(20,20,18,.28), 0 60px 140px -30px rgba(20,20,18,.30); }
.bar { height: ${STAGE.bar}px; display: flex; align-items: center; padding: 0 14px; gap: 8px; background: linear-gradient(#f3f2ee, #ebeae5); box-shadow: inset 0 -1px 0 rgba(20,20,18,.08); }
.dot { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.18); }
.url { position: absolute; left: 50%; transform: translateX(-50%); height: 24px; padding: 0 14px; border-radius: 7px; display: flex; align-items: center; gap: 6px;
  background: rgba(255,255,255,.75); box-shadow: inset 0 0 0 1px rgba(20,20,18,.07); font-size: 12.5px; color: #6b6964; }
.url b { color: #2b2a27; font-weight: 500; }
</style><div class="bg"></div><div class="grain"></div>
<div class="win"><div class="bar"><span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
<div class="url"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#8a877f" stroke-width="2.4"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg><b>${url}</b></div></div></div>`;

const cardHtml = (kind: "title" | "end", title: string, theme: Theme) => `${head(theme)}<style>
.c { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; }
.wm svg { height: 64px; width: auto; color: #121211; display: block; }
h1 { margin: 0; font-size: 46px; line-height: 1.15; font-weight: 600; letter-spacing: -0.025em; color: #121211; text-align: center; max-width: 1180px; }
p { margin: 0; font-size: 22px; color: #6b6964; letter-spacing: -0.005em; }
.cmd { font-family: "Geist Mono"; font-size: 26px; padding: 18px 28px; border-radius: 14px; color: #f4f3ef; background: linear-gradient(#1f1f1d, #141413);
  box-shadow: 0 0 0 1px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.08), 0 20px 50px -14px rgba(20,20,18,.45); }
.cmd span { color: #f25a1d; }
.row { display: flex; gap: 22px; align-items: center; font-size: 21px; color: #2b2a27; }
.row i { width: 6px; height: 6px; border-radius: 50%; background: #c9c6be; }
</style><div class="bg"></div><div class="grain"></div><div class="c">
${
  kind === "title"
    ? `<div class="wm">${wordmark(theme)}</div><h1>${title}</h1><div class="row">Open source<i></i>Self-hosted<i></i>npm and PyPI<i></i>Any model</div>`
    : `<div class="wm">${wordmark(theme)}</div><div class="cmd"><span>$</span> npx bumpsmith dashboard</div><p>github.com/bumpsmith/bumpsmith</p>`
}</div>`;

const captionHtml = (text: string, theme: Theme = "light") => `${head(theme)}<style>
body { display: inline-block; padding: 44px 56px 64px; }
.cap { display: inline-flex; align-items: center; gap: 12px; max-width: 1240px; padding: 14px 24px 15px; border-radius: 16px;
  background: rgba(22, 22, 20, .90); color: #f4f3ef; font-size: 25px; line-height: 1.3; letter-spacing: -0.01em; font-weight: 450;
  box-shadow: 0 0 0 1px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08), 0 18px 40px -12px rgba(0,0,0,.45); }
.cap i { flex: none; width: 9px; height: 9px; border-radius: 3px; background: #f25a1d; }
</style><div class="cap"><i></i><span>${text}</span></div>`;

const cursorHtml = `<style>html,body{margin:0;background:transparent}</style>
<svg width="30" height="30" viewBox="0 0 26 26" style="display:block;filter:drop-shadow(0 1px 1.2px rgba(0,0,0,.30)) drop-shadow(0 3px 5px rgba(0,0,0,.14))">
<path d="M4.2 2.6 L4.2 20.4 L8.7 16.3 L11.6 22.9 L14.6 21.6 L11.8 15.1 L17.9 15.1 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export async function renderAssets(
  browser: Browser,
  out: string,
  opts: { url: string; title: string; captions: string[]; theme?: Theme },
) {
  const ctx = await browser.newContext({
    viewport: { width: STAGE.w, height: STAGE.h },
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  const shot = async (html: string, file: string, clip?: string) => {
    await p.setContent(html);
    await p.evaluate("document.fonts.ready");
    if (clip) await p.locator(clip).screenshot({ path: join(out, file), omitBackground: true });
    else await p.screenshot({ path: join(out, file), omitBackground: true });
  };
  const theme = opts.theme ?? "light";
  await shot(stageHtml(opts.url, theme), "stage.png");
  await shot(cardHtml("title", opts.title, theme), "title.png");
  await shot(cardHtml("end", "", theme), "end.png");
  await shot(cursorHtml, "cursor.png", "svg");
  const caps: Record<string, string> = {};
  for (const [i, text] of opts.captions.entries()) {
    const file = `caption-${i}.png`;
    await shot(captionHtml(text), file, "body");
    caps[text] = file;
  }
  writeFileSync(
    join(out, "assets.json"),
    JSON.stringify({ stage: STAGE, captions: caps }, null, 1),
  );
  await ctx.close();
}
