// Records the README walkthroughs: a real dashboard, real benchmark runs, and a person-like
// pointer (human.ts). Frames come from Chromium's screencast at 2x; compose.py turns them into
// the finished video (window frame, camera moves, captions).
//
//   pnpm tsx scripts/demo/record.ts hero  /tmp/demo/hero
//   pnpm tsx scripts/demo/record.ts team  /tmp/demo/team
//   python3 scripts/demo/compose.py /tmp/demo/hero docs/media/hero.mp4
//
// The demo workspace is the repository from a real benchmark task (node-fetch 2 -> 3), checked
// out at the commit the run started from, so "Apply patch" really applies. The history around it
// is one real benchmark run per package. Accounts and names are fictional.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { startDashboard } from "../../src/dashboard/server.ts";
import { base32Decode, hotp } from "../../src/server/crypto.ts";
import { renderAssets } from "./assets.ts";
import { Human } from "./human.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const RUNS = join(ROOT, "bench", "runs");
const HERO = "20261116143403-19a1bd"; // node-fetch 2.7.0 -> 3.3.2, ready
const HISTORY = [
  HERO,
  "20261116134448-dda99b", // msw 2 -> 3
  "20261117010500-9df1fb", // boxen 5 -> 8
  "20261116080720-6c37bf", // chalk 4 -> 6
  "20261117010741-f60655", // conf 15 -> 16
  "20261117021730-83d6b0", // nock 14 -> 15
  "20261117010132-69612f", // globby 14 -> 16
  "20261117005711-5921de", // find-up 5 -> 8
  "20261117004606-be75dc", // lru-cache 6 -> 11
  "20261117005331-c7b2f0", // eslint-plugin-react-hooks 5 -> 7
  "20261116153106-8f719d", // pino 9 -> 10
  "20261116153919-6c9ea0", // @sentry/node 10 -> 11
  "20261116132319-eec84b", // stripe 22 -> 23
  "20261116130225-6900f7", // got 13 -> 16
  "20261117011046-d33aca", // ky, needs a human
  "20261117021859-c477fb", // sinon, needs a human
  "20261116191105-619876", // execa, needs a human
  "20261116140047-41e0f9", // react-router-dom, blocked
  "20261116140120-d11922", // p-limit, blocked
  "20261117020056-d2c293", // helmet, could not run
];
const PASSWORD = "Harbor-Lantern-Quartz-58";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "bumpsmith-demo-"));
  const repo = join(tmp, "home-hub");
  cpSync(join(RUNS, HERO, "before"), repo, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", repo, ...a], {
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Northwind",
        GIT_AUTHOR_EMAIL: "dev@northwind.example",
        GIT_COMMITTER_NAME: "Northwind",
        GIT_COMMITTER_EMAIL: "dev@northwind.example",
      },
    });
  // Bumpsmith's results live in .bumpsmith/ (ignored), as in a real repository.
  writeFileSync(
    join(repo, ".gitignore"),
    `${readFileSync(join(repo, ".gitignore"), "utf8")}\n.bumpsmith/\n`,
  );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Home hub");
  const runs = join(repo, ".bumpsmith", "runs");
  mkdirSync(runs, { recursive: true });
  for (const id of HISTORY) {
    const src = join(RUNS, id);
    if (!existsSync(join(src, "job.json"))) continue;
    // The dashboard reads job.json, patch.diff, evidence.md and after/ (for diff context).
    cpSync(src, join(runs, id), {
      recursive: true,
      filter: (p) => !/[/\\](repo|before)([/\\]|$)/.test(p.slice(src.length)),
    });
  }
  // A real dependency scan (registry lookups only, no AI), for the Dependencies page.
  execFileSync("pnpm", ["-s", "tsx", "src/cli.ts", "scan", "--repo", repo], {
    cwd: ROOT,
    stdio: "ignore",
  });
  const d = await startDashboard({
    repoDir: repo,
    runsDir: runs,
    dataDir: join(tmp, "data"),
    port: 5800 + Math.floor(Math.random() * 100),
    cliEntry: "",
  });
  const base = d.url.replace(/\/$/, "");
  const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify(b),
    });
  const r = await post("/auth/setup", {
    orgName: "Northwind",
    name: "Maya Chen",
    email: "maya@northwind.dev",
    password: PASSWORD,
    token: d.setupUrl?.split("#/setup/")[1],
  });
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const h = { cookie, "x-csrf-token": ((await r.json()) as { csrf: string }).csrf };
  const { secret } = (await (await post("/api/me/mfa/start", {}, h)).json()) as { secret: string };
  const code = () =>
    hotp(base32Decode(secret), Math.floor(Date.now() / 30000))
      .toString()
      .padStart(6, "0");
  await post("/api/me/mfa/confirm", { code: code() }, h);
  await post("/api/onboarding/done", {}, h);
  const roles = (
    (await (await fetch(`${base}/api/roles`, { headers: h })).json()) as {
      roles: { id: string; name: string }[];
    }
  ).roles;
  const roleId = (n: string) => roles.find((x) => x.name === n)?.id ?? "";
  const team: [string, string, string, boolean][] = [
    ["Diego Alvarez", "diego@northwind.dev", "Maintainer", true],
    ["Priya Raman", "priya@northwind.dev", "Reviewer", true],
    ["Sam Okafor", "sam@northwind.dev", "Viewer", true],
    ["", "lena@northwind.dev", "Auditor", false],
  ];
  for (const [name, email, role, joins] of team) {
    const inv = (await (
      await post("/api/members/invite", { email, roleId: roleId(role) }, h)
    ).json()) as { link: string };
    if (!joins) continue;
    const token = inv.link.split("#/invite/")[1];
    await post("/auth/invite", { token, name, password: PASSWORD });
  }
  return { tmp, base, cookie, close: d.close, ws: "home-hub" };
}

async function record(scene: string, out: string) {
  const env = await setup();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "frames"), { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scene.endsWith("-dark") ? "dark" : "light",
  });
  await ctx.addCookies([
    { name: "bs_session", value: env.cookie.split("=")[1] ?? "", url: env.base },
  ]);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("bumpsmith-onboarding", "skip");
      localStorage.setItem("bumpsmith-rail", "0");
    } catch {
      // ignore
    }
  });
  const page = await ctx.newPage();
  const h = new Human(page, scene.length * 31 + 7);
  const W = `${env.base}/#/w/${env.ws}`;
  const frames: { ts: number; file: string }[] = [];
  const cdp = await ctx.newCDPSession(page);
  let n = 0;
  cdp.on("Page.screencastFrame", (f) => {
    const file = `f${String(n++).padStart(6, "0")}.jpg`;
    writeFileSync(join(out, "frames", file), Buffer.from(f.data, "base64"));
    frames.push({ ts: f.metadata.timestamp ?? Date.now() / 1000, file });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  const start = async (url: string, ready: string) => {
    await page.goto(url);
    await page.locator(ready).first().waitFor({ state: "visible", timeout: 20000 });
    await sleep(900);
    await h.place(1180, 760);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 96,
      maxWidth: 2880,
      maxHeight: 1800,
      everyNthFrame: 1,
    });
    await sleep(300);
    h.mark("start");
  };
  try {
    if (scene.startsWith("hero")) await hero(page, h, W, start);
    else if (scene.startsWith("team")) await teamScene(page, h, env.base, W, start);
    else if (scene.startsWith("palette")) await paletteScene(page, h, W, start);
    else throw new Error(`unknown scene ${scene}`);
    h.mark("end");
    await sleep(400);
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    writeFileSync(
      join(out, "timeline.json"),
      JSON.stringify(
        { viewport: [1440, 900], dpr: 2, scene, frames, events: h.events, pointer: h.pointer },
        null,
        1,
      ),
    );
    await renderAssets(browser, out, {
      url: "localhost:4477",
      theme: scene.endsWith("-dark") ? "dark" : "light",
      title: TITLES[scene.replace(/-dark$/, "")] ?? "Bumpsmith",
      captions: [
        ...new Set(h.events.flatMap((e) => (e.type === "caption" && e.text ? [e.text] : []))),
      ],
    });
    await browser.close();
    await env.close();
    rmSync(env.tmp, { recursive: true, force: true });
  }
  console.log(`${scene}: ${frames.length} frames -> ${out}`);
}

const TITLES: Record<string, string> = {
  hero: "Fixes your code when a dependency ships a breaking change.",
  team: "Self-host it for your whole team, from day one.",
  palette: "Upgrade any dependency, verified in a sandbox.",
};

type Start = (url: string, ready: string) => Promise<void>;

/** From a red upgrade to a verified, reviewed patch you can apply. */
async function hero(page: Page, h: Human, W: string, start: Start) {
  await start(`${W}/`, ".queue-i");
  h.caption("Dependabot opened 20 major upgrades. Bumpsmith fixed what they broke.");
  await h.read(2600);
  await h.click('.sidebar a[href$="/runs"]');
  await page.locator("#q").waitFor();
  await h.pause(500);
  await h.click("#q");
  h.zoom(await h.box(".page .ph, .page .rh"), 1.5);
  await h.type("node-fetch");
  await h.read(700);
  h.zoom(null);
  await h.pause(300);
  await h.click('tr[data-act="open-run"]');
  await page.locator(".tabs").waitFor();
  h.caption("It read the release notes, found every call site and fixed them in a sandbox.");
  await h.pause(500);
  const pipe = page.locator(".panel").filter({ hasText: "Pipeline" }).first();
  h.zoom(await h.box(pipe), 1.55);
  for (const step of [
    "Read the changelog",
    "Find affected code",
    "Fix what broke",
    "Independent review",
  ]) {
    await h.hover(pipe.getByText(step, { exact: true }), [500, 800]);
  }
  await h.read(700);
  h.zoom(null);

  await h.click('[data-act="tab"][data-v="breaking"]');
  h.caption("Every breaking change, quoted word for word from the release notes.");
  await h.pause(700);
  const firstChange = page.locator(".page.wide .panel").nth(0);
  h.zoom(await h.box(firstChange), 1.45);
  await h.read(3000);
  h.zoom(null);

  await h.click('[data-act="tab"][data-v="changes"]');
  h.caption("The fix, in plain sight: a CommonJS wrapper, and the removed timeout option mapped.");
  await h.pause(900);
  const diff = page.locator(".fd").first();
  h.zoom(await h.box(diff), 1.35);
  await h.hover(diff.locator(".fd-h"), [300, 500]);
  await h.read(1400);
  await h.scroll(380, 900);
  await h.read(2200);
  h.zoom(null);
  await h.scroll(-380, 600);

  await h.click('[data-act="tab"][data-v="checks"]');
  h.caption("Your own install and tests, run before and after the upgrade.");
  await h.pause(800);
  h.zoom(await h.box(page.locator(".page.wide table.t").first()), 1.5);
  await h.read(2600);
  h.zoom(null);

  await h.click('[data-act="tab"][data-v="summary"]');
  await h.pause(600);
  await h.moveTo(760, 640);
  await h.scroll(560, 1000);
  await h.pause(300);
  h.caption("A separate reviewer says what it could not verify. You decide.");
  const review = page.locator(".review-sum").first();
  h.zoom(await h.box(review), 1.5);
  await h.hover(review, [400, 600]);
  await h.read(4200);
  h.zoom(null);
  await h.scroll(-560, 700);
  await h.pause(300);
  h.caption("Apply the patch, or merge the pull request. A human always decides.");
  await h.click('.rh [data-act="apply"]');
  await page.locator(".dialog").waitFor();
  await h.read(900);
  await h.click('.dialog button[type="submit"]');
  await h.read(2800);
  h.caption(null);
  await h.read(600);
}

/** People, roles and access: the enterprise side. */
async function teamScene(page: Page, h: Human, base: string, _W: string, start: Start) {
  await start(`${base}/#/org/members`, "table.members");
  h.caption("Invite your team. Two-factor and SSO for everyone.");
  await h.read(1600);
  await h.click('[data-act="member-invite"]');
  await page.locator(".dialog input").first().waitFor();
  await h.pause(300);
  await h.click(".dialog input[type=email], .dialog input");
  await h.type("alex@northwind.dev");
  await h.read(900);
  await h.press("Escape");
  await h.pause(400);
  await h.click('.sidebar a[href$="org/access"]');
  await page.locator(".matrix").waitFor();
  h.caption("Decide who can do what, repository by repository.");
  await h.pause(500);
  const mx = await h.box(page.locator(".matrix"));
  h.zoom({ ...mx, height: Math.min(mx.height, 430) }, 1.3);
  await h.read(1500);
  await h.click('[data-act="ws-visibility"][data-v="restricted"]');
  await h.read(1800);
  await h.click('[data-act="ws-visibility"][data-v="org"]');
  await h.read(800);
  h.zoom(null);
  await h.click('.sidebar a[href$="org/security"]');
  await page.locator(".page").waitFor();
  h.caption("SAML and OIDC single sign-on, MFA policy and session limits.");
  await h.read(2200);
  await h.scroll(500, 900);
  await h.read(1800);
  await h.click('.sidebar a[href$="org/audit"]');
  await page.locator(".page").waitFor();
  h.caption("Every sign-in and change goes into a tamper-evident audit log.");
  await h.pause(600);
  h.zoom(await h.box(page.locator(".badge.big").first()), 1.8);
  await h.read(2200);
  h.zoom(null);
  await h.read(1000);
  h.caption(null);
}

/** ⌘K: jump anywhere, upgrade anything. */
async function paletteScene(page: Page, h: Human, W: string, start: Start) {
  await start(`${W}/deps`, ".page table.t");
  h.caption("Your upgrade debt at a glance: every dependency a major version behind.");
  await h.read(1400);
  await h.hover(page.locator(".page table.t tbody tr").first(), [700, 1000]);
  await h.read(900);
  h.caption("⌘K to jump anywhere or start an upgrade.");
  await h.press("Meta+k");
  await page.locator(".cmdk-dialog").waitFor();
  await h.pause(400);
  h.zoom(await h.box(".cmdk-dialog"), 1.5);
  await h.type("express");
  await h.read(900);
  await h.press("Enter");
  h.zoom(null);
  await page.locator(".drawer").waitFor();
  h.caption("Pick a model, set a budget, and watch it run in the sandbox.");
  await h.pause(500);
  h.zoom(await h.box(".drawer"), 1.4);
  await h.read(3000);
  h.zoom(null);
  await h.press("Escape");
  h.caption(null);
  await h.read(800);
}

const [scene = "hero", out = join(tmpdir(), "bumpsmith-demo", scene)] = process.argv.slice(2);
await record(scene, resolve(out));
process.exit(0);
