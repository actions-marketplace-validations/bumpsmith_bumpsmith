// `bumpsmith mcp`: the MCP server for agents on this machine (Claude Code, Claude Desktop,
// Cursor, VS Code, Codex, Windsurf, Zed, ...), over stdio. Repositories are folders; upgrades
// run as `bumpsmith fix` child processes, so a crash in one never takes the server down and the
// protocol stream on stdout stays clean.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { stageOf } from "../dashboard/server.ts";
import { runOk } from "../util/proc.ts";
import { createMcpServer, type McpHost, type McpLiveRun, type McpRepo } from "./tools.ts";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function bumpsmithVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const f = join(dir, "package.json");
    if (existsSync(f)) {
      const p = JSON.parse(readFileSync(f, "utf8")) as { name?: string; version?: string };
      if (p.name === "bumpsmith") return p.version ?? "0.0.0";
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

export function localHost(defaultRepo: string, cliEntry: string): McpHost {
  const live = new Map<string, McpLiveRun>();
  const cli = (args: string[], cwd: string) =>
    spawn(process.execPath, [...process.execArgv, cliEntry, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  const toRepo = (p: string): McpRepo => {
    const path = resolve(p);
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new Error(`${path} is not a folder on this machine`);
    return {
      id: path,
      name: basename(path),
      path,
      runsDir: join(path, ".bumpsmith", "runs"),
      can: () => true,
    };
  };
  return {
    mode: "local",
    repos: async () => [toRepo(defaultRepo)],
    repo: async (id) => toRepo(id ?? defaultRepo),
    start(repo, pkg, version, opts) {
      const lr: McpLiveRun = {
        id: randomBytes(6).toString("hex"),
        package: pkg,
        version,
        stage: "prepare",
        done: false,
        exitCode: null,
        jobId: null,
        lines: [],
      };
      live.set(lr.id, lr);
      const args = [
        "fix",
        `${pkg}@${version}`,
        "--repo",
        repo.path,
        "--budget",
        String(opts.budget),
      ];
      if (opts.provider) args.push("--provider", opts.provider);
      const child = cli(args, repo.path);
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(ANSI, "").trimEnd();
          if (!line) continue;
          lr.lines.push(line);
          if (lr.lines.length > 400) lr.lines.shift();
          const job = /^job (\S+):/.exec(line)?.[1];
          if (job && !lr.jobId) lr.jobId = job;
          const st = stageOf(line);
          if (st) lr.stage = st;
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (code) => {
        lr.done = true;
        lr.exitCode = code;
        lr.stage = "done";
      });
      return lr;
    },
    live: (id) => live.get(id),
    exec: (repo, args) =>
      new Promise((ok) => {
        const child = cli(args, repo.path);
        let out = "";
        child.stdout.on("data", (d: Buffer) => {
          out += d.toString("utf8");
        });
        child.stderr.on("data", (d: Buffer) => {
          out += d.toString("utf8");
        });
        const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          ok({ code: code ?? 1, out: out.replace(ANSI, "") });
        });
      }),
    async apply(repo, patchFile) {
      await runOk("git", ["-C", repo.path, "apply", "--check", "--index", patchFile]);
      await runOk("git", ["-C", repo.path, "apply", "--index", patchFile]);
      return "Applied and staged. Review with git diff --cached, then commit.";
    },
  };
}

/** Serve over stdio until the client disconnects. Everything else this process prints goes to stderr. */
export async function serveLocal(repo: string, cliEntry: string) {
  // stdout carries the protocol; keep stray logs off it.
  console.log = (...a: unknown[]) => console.error(...a);
  const host = localHost(repo, cliEntry);
  const version = bumpsmithVersion();
  serveStdio(() => createMcpServer(host, version), {
    onerror: (e) => process.stderr.write(`bumpsmith mcp: ${e.message}\n`),
  });
  await new Promise(() => {});
}
