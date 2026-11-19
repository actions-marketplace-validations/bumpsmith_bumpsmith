// A ready-to-use demo workspace for trying the dashboard: a real repository from the benchmark,
// real upgrade runs, a dependency scan and a small team, behind a fixed sign-in.
//
//   pnpm demo:workspace            # http://127.0.0.1:4479, data in .demo/ (ignored by git)
//   pnpm demo:workspace --reset    # throw the demo away and build it again
//
// The first run builds it (about a minute: the dependency scan reads the registry); later runs
// reuse it. Two-factor authentication is turned off for this demo organisation so you can sign in
// with the password alone. Accounts and names are fictional.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startDashboard } from "../../src/dashboard/server.ts";
import { base32Decode, hotp } from "../../src/server/crypto.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const RUNS = join(ROOT, "bench", "runs");
const HOME = join(ROOT, ".demo");
const PORT = Number(process.env.DEMO_PORT ?? 4479);
const LOGIN = { email: "maya@northwind.dev", password: "anvil-sparks-demo-7" };
const TEAM: [string, string, string, boolean][] = [
  ["Diego Alvarez", "diego@northwind.dev", "Maintainer", true],
  ["Priya Raman", "priya@northwind.dev", "Reviewer", true],
  ["Sam Okafor", "sam@northwind.dev", "Viewer", true],
  ["", "lena@northwind.dev", "Auditor", false],
];
const DEMO_TOKENS: [string, number, string[]][] = [
  ["GitHub Actions · home-hub", 90, ["runs.view", "runs.start"]],
  ["Renovate helper", 30, ["runs.view"]],
  ["Laptop CLI", 365, ["runs.view", "runs.start", "workspaces.view"]],
  ["Grafana panel", 90, ["runs.view", "workspaces.view"]],
  ["Release script", 30, ["runs.view", "runs.start"]],
  ["Slack notifier", 90, ["runs.view"]],
  ["Audit export (SIEM)", 365, ["audit.view"]],
  ["Staging smoke tests", 7, ["runs.view", "runs.start"]],
];
const RUN_IDS = [
  "20261116143403-19a1bd", // node-fetch 2.7.0 -> 3.3.2 (the repository is this run's "before")
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
];

const repo = join(HOME, "home-hub");
const runs = join(repo, ".bumpsmith", "runs");
const dataDir = join(HOME, "data");
const fresh = process.argv.includes("--reset") || !existsSync(join(HOME, "ready"));

if (fresh) {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  cpSync(join(RUNS, RUN_IDS[0] as string, "before"), repo, { recursive: true });
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Northwind",
    GIT_AUTHOR_EMAIL: "dev@northwind.example",
    GIT_COMMITTER_NAME: "Northwind",
    GIT_COMMITTER_EMAIL: "dev@northwind.example",
  };
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore", env });
  const gi = join(repo, ".gitignore");
  writeFileSync(gi, `${existsSync(gi) ? readFileSync(gi, "utf8") : ""}\n.bumpsmith/\n`);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Home hub");
  mkdirSync(runs, { recursive: true });
  for (const id of RUN_IDS) {
    const src = join(RUNS, id);
    if (!existsSync(join(src, "job.json"))) continue;
    cpSync(src, join(runs, id), {
      recursive: true,
      filter: (p) => !/[/\\](repo|before)([/\\]|$)/.test(p.slice(src.length)),
    });
  }
  process.stdout.write("Scanning dependencies (registry lookups only, no AI)…\n");
  execFileSync("pnpm", ["-s", "tsx", "src/cli.ts", "scan", "--repo", repo], {
    cwd: ROOT,
    stdio: "ignore",
  });
}

const d = await startDashboard({ repoDir: repo, runsDir: runs, dataDir, port: PORT, cliEntry: "" });
const base = d.url.replace(/\/$/, "");

if (fresh) {
  const post = (p: string, b: unknown, h: Record<string, string> = {}) =>
    fetch(base + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...h },
      body: JSON.stringify(b),
    });
  const must = async (r: Response, what: string) => {
    if (!r.ok) throw new Error(`${what}: ${r.status} ${await r.text()}`);
    return r;
  };
  const r = await must(
    await post("/auth/setup", {
      orgName: "Northwind",
      name: "Maya Chen",
      email: LOGIN.email,
      password: LOGIN.password,
      token: d.setupUrl?.split("#/setup/")[1],
    }),
    "setup",
  );
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const h = { cookie, "x-csrf-token": ((await r.json()) as { csrf: string }).csrf };
  // Owners must enrol in two-factor first; then the demo organisation turns it off so the demo
  // signs in with a password alone.
  const { secret } = (await (
    await must(await post("/api/me/mfa/start", {}, h), "mfa start")
  ).json()) as {
    secret: string;
  };
  const code = (step = 0) =>
    hotp(base32Decode(secret), Math.floor(Date.now() / 30000) + step)
      .toString()
      .padStart(6, "0");
  await must(await post("/api/me/mfa/confirm", { code: code() }, h), "mfa confirm");
  let s = await post("/api/org/security", { mfa: "off" }, h);
  if (s.status === 401 || s.status === 403) {
    await must(await post("/api/me/reauth", { code: code(1) }, h), "reauth");
    s = await post("/api/org/security", { mfa: "off" }, h);
  }
  await must(s, "security policy");
  await must(await post("/api/me/mfa/disable", {}, h), "mfa disable");
  await must(await post("/api/onboarding/done", {}, h), "onboarding");
  const roles = (
    (await (await fetch(`${base}/api/roles`, { headers: h })).json()) as {
      roles: { id: string; name: string }[];
    }
  ).roles;
  for (const [name, email, role, joins] of TEAM) {
    const roleId = roles.find((x) => x.name === role)?.id ?? "";
    const inv = (await (
      await must(await post("/api/members/invite", { email, roleId }, h), "invite")
    ).json()) as {
      link: string;
    };
    if (joins)
      await post("/auth/invite", {
        token: inv.link.split("#/invite/")[1],
        name,
        password: LOGIN.password,
      });
  }
  // A few API tokens, so the Account page shows a real, paginated list.
  for (const [name, days, scopes] of DEMO_TOKENS)
    await must(await post("/api/me/tokens", { name, days, scopes }, h), "token");
  await fetch(`${base}/auth/logout`, { method: "POST", headers: h });
  writeFileSync(join(HOME, "ready"), new Date().toISOString());
}

process.stdout.write(`
Bumpsmith demo workspace is running.

  Open      ${base}/
  Email     ${LOGIN.email}
  Password  ${LOGIN.password}

  Workspace home-hub (a real repository from the benchmark) with ${RUN_IDS.length} real upgrade runs,
  a dependency scan, and a team of five (Owner, Maintainer, Reviewer, Viewer, invited Auditor).
  Teammates sign in with the same password, for example priya@northwind.dev (Reviewer).

  Data lives in .demo/ (ignored by git). Stop with Ctrl+C; run again to reuse it, or pass --reset.
`);
