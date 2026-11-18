// Bumpsmith as an MCP server: the same tools for a local agent (stdio, `bumpsmith mcp`) and for
// applications connecting to a self-hosted server (`/mcp`, with a personal API token).
//
// What a host provides differs: locally, repositories are folders and runs are child processes
// of this one; on a server, repositories are workspaces the token's owner can see, and runs go
// through the dashboard (so they show up live there too). The tools themselves are identical.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { npmApiDiff, renderApiDiff } from "../change/dts-diff.ts";
import { scanRepository } from "../inventory/scan.ts";
import { checkMalicious, getRelease, latestRelease, releaseGate } from "../registry/registry.ts";
import { redactSecrets } from "../security/secrets.ts";

export interface McpRepo {
  /** What a caller passes as `repository`: a slug on a server, a path locally. */
  id: string;
  name: string;
  path: string;
  runsDir: string;
  /** Permission check (always true locally). */
  can(permission: "runs.view" | "runs.start" | "runs.apply"): boolean;
}

export interface McpLiveRun {
  id: string;
  package: string;
  version: string;
  stage: string;
  done: boolean;
  exitCode: number | null;
  jobId: string | null;
  lines: string[];
}

export interface McpHost {
  mode: "local" | "server";
  repos(): Promise<McpRepo[]>;
  /** The repository named, or the default one; throws when it is unknown or not allowed. */
  repo(id?: string): Promise<McpRepo>;
  /** Start `bumpsmith fix` for this repository (it runs in the background). */
  start(
    repo: McpRepo,
    pkg: string,
    version: string,
    opts: { provider?: string; budget: number },
  ): McpLiveRun;
  live(id: string): McpLiveRun | undefined;
  /** Run a short CLI command (explain) and return its output. */
  exec(repo: McpRepo, args: string[]): Promise<{ code: number; out: string }>;
  /** Stage a verified patch in the working tree (local only). */
  apply?(repo: McpRepo, patchFile: string): Promise<string>;
}

const ID = /^\d{14}-[0-9a-f]{6}$/;
const LIVE_ID = /^[0-9a-f]{12}$/;
const SPEC = /^(@?[\w.-]+\/)?[\w.-]+$/;
const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: redactSecrets(t) }],
  isError,
});
const clip = (t: string, max: number) =>
  t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;

async function readJob(repo: McpRepo, id: string) {
  if (!ID.test(id)) return null;
  const dir = join(repo.runsDir, id);
  if (!dir.startsWith(repo.runsDir + sep) || !existsSync(join(dir, "job.json"))) return null;
  const job = JSON.parse(await readFile(join(dir, "job.json"), "utf8"));
  const evidence = await readFile(join(dir, "evidence.md"), "utf8").catch(() => "");
  const patch = await readFile(join(dir, "patch.diff"), "utf8").catch(() => "");
  return { dir, job, evidence, patch };
}

function summary(job: {
  id: string;
  state: string;
  confidence?: string | null;
  cost_usd?: number;
  duration_ms?: number;
  from?: string | null;
  input: { packageName: string; to: string };
}) {
  return `${job.input.packageName} ${job.from ?? "?"} → ${job.input.to}: ${job.state.toUpperCase()} (confidence ${job.confidence ?? "n/a"}, $${(job.cost_usd ?? 0).toFixed(2)}, ${Math.round((job.duration_ms ?? 0) / 1000)}s), run ${job.id}`;
}

const STATES = `States: "ready" (verified in the sandbox and approved by the independent review; safe to apply), "safe" (version bump only, checks pass), "needs_human" (could not prove the change; read the evidence), "blocked_policy" (refused: malicious, too new, or a safety rule), "failed_infra" (the sandbox could not run the repository).`;

export function createMcpServer(host: McpHost, version: string): McpServer {
  const mcp = new McpServer(
    { name: "bumpsmith", title: "Bumpsmith", version },
    {
      instructions: `Bumpsmith upgrades a dependency across a breaking change and proves it: it reads the release notes (every breaking change backed by a quote), finds the affected code, edits it in an isolated sandbox, runs the repository's own install/build/typecheck/lint/tests before and after, and has an independent reviewer check the diff.

Typical flow: check_release (is the version safe to adopt?) → explain_upgrade (what breaks, where) → start_upgrade → get_upgrade until it finishes → read the evidence → apply_upgrade only when the state is "ready" or "safe", and tell the user what changed. Never present a "needs_human" result as fixed. ${STATES}`,
    },
  );
  const repoArg = z
    .string()
    .optional()
    .describe(
      host.mode === "local"
        ? "Path to the repository (default: the folder Bumpsmith was started in)."
        : "Repository slug from list_repositories (default: the only one, if there is just one).",
    );

  mcp.registerTool(
    "list_repositories",
    {
      title: "List repositories",
      description: "Repositories you can use with the other tools.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rs = await host.repos();
      return text(
        rs.length
          ? rs.map((r) => `${r.id}\t${r.name}\t${r.path}`).join("\n")
          : "No repositories yet. Add one in the Bumpsmith dashboard.",
      );
    },
  );

  mcp.registerTool(
    "scan_dependencies",
    {
      title: "Scan for upgrade debt",
      description:
        "List the repository's direct dependencies that are one or more major versions behind, with the latest version and whether it has passed the release-age wait. No AI; only package names are looked up on the public registry.",
      inputSchema: z.object({ repository: repoArg }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ repository }) => {
      const repo = await host.repo(repository);
      if (!repo.can("runs.view"))
        return text("Your access does not include this repository.", true);
      const { inv, report } = await scanRepository(repo.path);
      const rows = report.behind.map(
        (b) =>
          `- ${b.package} ${b.current} → ${b.latest} (${b.majorsBehind} major${b.majorsBehind > 1 ? "s" : ""} behind)${b.latestEligible ? "" : " [newest release still inside the release-age wait]"}`,
      );
      return text(
        `${inv.ecosystem} (${inv.packageManager}): ${report.directDependencies} direct dependencies, ${report.behind.length} a major version or more behind.\n${rows.join("\n")}`,
      );
    },
  );

  mcp.registerTool(
    "check_release",
    {
      title: "Check a release before adopting it",
      description:
        "Is this version safe to adopt? Reports publish age, yanked and deprecated status, and whether OSV lists it as malicious, against Bumpsmith's release gate (3-day minimum age by default). No AI.",
      inputSchema: z.object({
        ecosystem: z.enum(["npm", "pypi"]),
        package: z.string().regex(SPEC).describe("Package name, e.g. zod or @sentry/node"),
        version: z.string().optional().describe("Version to check (default: the latest)"),
        min_age_days: z.number().min(0).max(60).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ ecosystem, package: pkg, version: v, min_age_days }) => {
      const ver = v ?? (await latestRelease(ecosystem, pkg))?.version;
      if (!ver) return text(`No release found for ${pkg} on ${ecosystem}.`, true);
      const rel = await getRelease(ecosystem, pkg, ver);
      const mal = await checkMalicious(ecosystem, pkg, ver);
      const g = releaseGate(rel, mal, min_age_days ?? 3);
      return text(
        `${pkg}@${ver} (${ecosystem}): ${g.allowed ? "OK to adopt" : "NOT OK to adopt"}\n- published: ${rel.publishedAt?.toISOString() ?? "unknown"}${g.ageDays !== null ? ` (${g.ageDays.toFixed(1)} days ago)` : ""}\n- yanked: ${rel.yanked ? "yes" : "no"}\n- deprecated: ${rel.deprecated || "no"}\n- malicious (OSV): ${mal.malicious ? mal.ids.join(", ") : "not listed"}${g.reasons.length ? `\nReasons: ${g.reasons.join("; ")}` : ""}\n- source: ${rel.repositoryUrl ?? "unknown"}`,
      );
    },
  );

  mcp.registerTool(
    "api_diff",
    {
      title: "Diff a package's public API",
      description:
        "Compare the TypeScript type definitions of two versions of an npm package: removed, added and changed exports. No AI. Useful to see exactly what a major version changed.",
      inputSchema: z.object({
        package: z.string().regex(SPEC),
        from: z.string(),
        to: z.string(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ package: pkg, from, to }) =>
      text(clip(renderApiDiff(await npmApiDiff(pkg, from, to)), 40_000)),
  );

  mcp.registerTool(
    "explain_upgrade",
    {
      title: "Explain an upgrade",
      description:
        "What breaks when this repository moves a direct dependency to a new version, and every place in the code that is affected. Reads the release notes, changelog and type definitions (uses the configured model; a few cents).",
      inputSchema: z.object({
        repository: repoArg,
        package: z.string().regex(SPEC),
        version: z.string().describe("Target version, e.g. 4.1.0"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ repository, package: pkg, version: v }) => {
      const repo = await host.repo(repository);
      if (!repo.can("runs.view"))
        return text("Your access does not include this repository.", true);
      const r = await host.exec(repo, ["explain", `${pkg}@${v}`, "--repo", repo.path]);
      return text(clip(r.out.trim() || "(no output)", 40_000), r.code !== 0);
    },
  );

  mcp.registerTool(
    "start_upgrade",
    {
      title: "Upgrade a dependency and fix the code",
      description: `Upgrade a dependency in an isolated sandbox, fix the code the upgrade breaks, verify with the repository's own checks before and after, and review the diff. Takes a few minutes and runs in the background: poll get_upgrade with the returned id. Nothing is written to the repository until apply_upgrade.`,
      inputSchema: z.object({
        repository: repoArg,
        package: z.string().regex(SPEC),
        version: z.string().regex(/^\d[\w.+-]*$/),
        provider: z
          .string()
          .regex(/^[\w-]+$/)
          .optional()
          .describe(
            "Model provider (default: the configured one), e.g. anthropic-api, claude-code, codex, openai",
          ),
        budget_usd: z.number().min(0.5).max(50).optional().describe("Spend cap (default 8)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ repository, package: pkg, version: v, provider, budget_usd }) => {
      const repo = await host.repo(repository);
      if (!repo.can("runs.start"))
        return text("Your access does not allow starting upgrades here.", true);
      const lr = host.start(repo, pkg, v, { provider, budget: budget_usd ?? 8 });
      return text(
        `Started ${pkg} → ${v} as ${lr.id}. Poll get_upgrade with id "${lr.id}" (every 20–30 seconds); a run usually takes 2–6 minutes.`,
      );
    },
  );

  mcp.registerTool(
    "get_upgrade",
    {
      title: "Get an upgrade's status or result",
      description: `Status of a running upgrade (id from start_upgrade) or the result of a finished one (run id from list_upgrades): state, confidence, cost, the evidence (what changed upstream, what changed here, checks before and after, the review). ${STATES}`,
      inputSchema: z.object({
        repository: repoArg,
        id: z.string(),
        include_patch: z.boolean().optional().describe("Also return the patch (unified diff)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repository, id, include_patch }) => {
      const repo = await host.repo(repository);
      if (!repo.can("runs.view"))
        return text("Your access does not include this repository.", true);
      let runId = id;
      if (LIVE_ID.test(id)) {
        const lr = host.live(id);
        if (!lr) return text(`No running upgrade ${id}.`, true);
        if (!lr.done)
          return text(
            `RUNNING ${lr.package} → ${lr.version}, stage: ${lr.stage}${lr.jobId ? `, run ${lr.jobId}` : ""}\nRecent log:\n${lr.lines.slice(-12).join("\n")}\n\nPoll again in 20–30 seconds.`,
          );
        if (!lr.jobId)
          return text(
            `FAILED before a run was created (exit ${lr.exitCode}).\n${lr.lines.slice(-20).join("\n")}`,
            true,
          );
        runId = lr.jobId;
      }
      const r = await readJob(repo, runId);
      if (!r) return text(`No run ${runId} in this repository.`, true);
      return text(
        `${summary(r.job)}\n\n${clip(r.evidence, 30_000)}${include_patch && r.patch ? `\n\n## Patch\n\n\`\`\`diff\n${clip(r.patch, 40_000)}\n\`\`\`` : ""}`,
      );
    },
  );

  mcp.registerTool(
    "list_upgrades",
    {
      title: "List upgrades",
      description: "Recent upgrade runs in this repository, newest first, with their state.",
      inputSchema: z.object({
        repository: repoArg,
        state: z
          .enum(["ready", "safe", "needs_human", "blocked_policy", "failed_infra"])
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ repository, state, limit }) => {
      const repo = await host.repo(repository);
      if (!repo.can("runs.view"))
        return text("Your access does not include this repository.", true);
      const { listRuns } = await import("../dashboard/server.ts");
      const runs = (await listRuns(repo.runsDir))
        .filter((r) => !state || r.state === state)
        .slice(0, limit ?? 20);
      return text(
        runs.length
          ? runs
              .map(
                (r) =>
                  `${r.id}\t${r.package} ${r.from ?? "?"} → ${r.to}\t${r.state}\t${r.confidence ?? "-"}\t$${r.cost_usd.toFixed(2)}`,
              )
              .join("\n")
          : "No upgrades yet.",
      );
    },
  );

  if (host.apply)
    mcp.registerTool(
      "apply_upgrade",
      {
        title: "Apply a verified upgrade",
        description:
          'Stage a finished upgrade\'s patch in the working tree (git apply --check, then git apply --index). Only "ready" and "safe" results apply; the user reviews with git diff --cached and commits.',
        inputSchema: z.object({ repository: repoArg, id: z.string().regex(ID) }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ repository, id }) => {
        const repo = await host.repo(repository);
        if (!repo.can("runs.apply")) return text("Your access does not allow applying.", true);
        const r = await readJob(repo, id);
        if (!r) return text(`No run ${id} in this repository.`, true);
        if (r.job.state !== "ready" && r.job.state !== "safe")
          return text(
            `Not applied: ${id} is "${r.job.state}", not verified. Read the evidence with get_upgrade and decide with the user.`,
            true,
          );
        if (!r.patch.trim()) return text("This run has no patch.", true);
        return text(
          await (host.apply as NonNullable<McpHost["apply"]>)(repo, join(r.dir, "patch.diff")),
        );
      },
    );

  return mcp;
}
