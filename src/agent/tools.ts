import { z } from "zod";
import type { CheckCommand } from "../inventory/inventory.ts";
import type { Sandbox } from "../sandbox/sandbox.ts";
import type { CheckName } from "../schemas/job.ts";
import { containsMask, maskSecrets, redactDeep } from "../security/secrets.ts";
import { type EditPolicy, PolicyError } from "./policy.ts";

/** Provider-neutral tool definition; each model provider adapts it. */
export interface AgentTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>): Promise<string>;
}

export function defineTool<S extends z.ZodObject>(t: AgentTool<S>): AgentTool<S> {
  return t;
}

const PRUNE = [
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  ".next",
  ".bumpsmith-cache",
  ".yarn",
];
const MAX_READ_LINES = 600;
const MAX_TOOL_OUTPUT = 12_000;

function clip(text: string, max = MAX_TOOL_OUTPUT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max / 3);
  const tail = text.slice(-((max * 2) / 3));
  return `${head}\n... [${text.length - max} characters omitted] ...\n${tail}`;
}

export interface ToolLog {
  tool: string;
  input: unknown;
  ok: boolean;
  summary: string;
  at: string;
}

export interface ToolContext {
  sandbox: Sandbox;
  policy: EditPolicy;
  checks: CheckCommand[];
  log: ToolLog[];
  /** Seconds left in the job; agent checks never run past it. */
  remainingSec?: () => number;
  /** Number of secrets masked in tool output (reported privately to the customer). */
  secretFindings?: number;
  /** Baseline duration per check (ms), used to size agent check timeouts. */
  baselineMs?: Partial<Record<CheckName, number>>;
}

/** clamp(5x baseline, 2 min, 15 min), never past the job deadline. */
export function agentCheckTimeout(ctx: ToolContext, name: CheckName): number {
  const base = ctx.baselineMs?.[name];
  let t = base ? Math.min(15 * 60, Math.max(2 * 60, Math.ceil((base * 5) / 1000))) : 15 * 60;
  const left = ctx.remainingSec?.();
  if (left !== undefined) t = Math.min(t, Math.max(30, left - 4 * 60));
  return t;
}

/** Confirm inside the container that a path does not escape /workspace through a symlink. */
async function assertInsideWorkspace(ctx: ToolContext, rel: string): Promise<void> {
  const r = await ctx.sandbox.exec(["realpath", "-m", "--", `/workspace/${rel}`], {
    timeoutSec: 10,
  });
  const real = r.stdout.trim();
  if (r.exitCode !== 0 || !(real === "/workspace" || real.startsWith("/workspace/")))
    throw new PolicyError(`${rel} resolves outside the workspace`);
}

async function readRaw(ctx: ToolContext, rel: string): Promise<string> {
  await assertInsideWorkspace(ctx, rel);
  const r = await ctx.sandbox.exec(["cat", "--", rel], { timeoutSec: 20 });
  if (r.exitCode !== 0) throw new Error(`cannot read ${rel}: ${r.stderr.trim() || "not found"}`);
  return r.stdout;
}

async function writeRaw(ctx: ToolContext, rel: string, content: string): Promise<void> {
  // The model only ever saw masked secrets; writing a placeholder back would destroy the
  // real value in the customer's file.
  if (containsMask(content))
    throw new Error(
      "refusing to write a masked-secret placeholder; leave lines containing secrets untouched",
    );
  await assertInsideWorkspace(ctx, rel);
  const r = await ctx.sandbox.exec(
    ["sh", "-c", 'mkdir -p "$(dirname -- "$1")" && cat > "$1"', "sh", rel],
    { input: content, timeoutSec: 20 },
  );
  if (r.exitCode !== 0) throw new Error(`cannot write ${rel}: ${r.stderr.trim()}`);
}

function wrap<S extends z.ZodObject>(ctx: ToolContext, tool: AgentTool<S>): AgentTool<S> {
  return {
    ...tool,
    async run(input) {
      const at = new Date().toISOString();
      try {
        // T8: every tool result is masked before it can reach the model.
        const masked = maskSecrets(await tool.run(input));
        if (masked.findings.length)
          ctx.secretFindings = (ctx.secretFindings ?? 0) + masked.findings.length;
        const out = masked.text;
        ctx.log.push({
          tool: tool.name,
          input: redactDeep(input),
          ok: true,
          summary: out.slice(0, 200),
          at,
        });
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const safe = maskSecrets(msg).text;
        ctx.log.push({
          tool: tool.name,
          input: redactDeep(input),
          ok: false,
          summary: safe.slice(0, 200),
          at,
        });
        return `ERROR: ${safe}`;
      }
    },
  };
}

export function buildTools(ctx: ToolContext): AgentTool[] {
  const checkNames = ctx.checks.map((c) => c.name) as [CheckName, ...CheckName[]];
  const tools: AgentTool[] = [
    defineTool({
      name: "list_files",
      description:
        "List files under a directory of the repository (dependency and build folders are skipped). Returns at most 400 paths.",
      input: z.object({
        path: z.string().describe("Directory relative to the repository root; '.' for the root"),
      }),
      async run({ path }) {
        const rel = ctx.policy.checkRead(path);
        await assertInsideWorkspace(ctx, rel);
        const prune = PRUNE.flatMap((d, i) => (i ? ["-o", "-name", d] : ["-name", d]));
        const r = await ctx.sandbox.exec(
          ["find", rel, "(", ...prune, ")", "-prune", "-o", "-type", "f", "-print"],
          { timeoutSec: 30 },
        );
        const files = r.stdout
          .split("\n")
          .filter(Boolean)
          .map((f) => f.replace(/^\.\//, ""));
        return files.length > 400
          ? `${files.slice(0, 400).join("\n")}\n... ${files.length - 400} more`
          : files.join("\n") || "(no files)";
      },
    }),
    defineTool({
      name: "read_file",
      description: `Read a text file with line numbers. Use start_line/end_line for large files (max ${MAX_READ_LINES} lines per call).`,
      input: z.object({
        path: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      }),
      async run({ path, start_line, end_line }) {
        const rel = ctx.policy.checkRead(path);
        const text = await readRaw(ctx, rel);
        const lines = text.split("\n");
        const start = (start_line ?? 1) - 1;
        const end = Math.min(
          end_line ?? start + MAX_READ_LINES,
          start + MAX_READ_LINES,
          lines.length,
        );
        const body = lines
          .slice(start, end)
          .map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`)
          .join("\n");
        return end < lines.length ? `${body}\n... (${lines.length} lines total)` : body;
      },
    }),
    defineTool({
      name: "search",
      description:
        "Search repository files for a fixed string (not a regex). Returns matching lines as path:line:text, at most 200.",
      input: z.object({
        text: z.string().min(1),
        path: z
          .string()
          .optional()
          .describe("Directory or file to search; defaults to the repository root"),
      }),
      async run({ text, path }) {
        const rel = ctx.policy.checkRead(path ?? ".");
        const excludes = PRUNE.map((d) => `--exclude-dir=${d}`);
        const r = await ctx.sandbox.exec(["grep", "-rnIF", ...excludes, "--", text, rel], {
          timeoutSec: 30,
        });
        const lines = r.stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => l.replace(/^\.\//, ""));
        if (!lines.length) return "(no matches)";
        return clip(lines.slice(0, 200).join("\n"));
      },
    }),
    defineTool({
      name: "edit_file",
      description:
        "Replace exactly one occurrence of old_text with new_text in a file. Fails if old_text matches zero or several times. Files outside the upgrade's allowlist need a reason.",
      input: z.object({
        path: z.string(),
        old_text: z.string().min(1),
        new_text: z.string(),
        reason: z.string().optional().describe("Required only for files outside the allowlist"),
      }),
      async run({ path, old_text, new_text, reason }) {
        const rel = ctx.policy.checkEdit(path, reason);
        const text = await readRaw(ctx, rel);
        const count = text.split(old_text).length - 1;
        if (count === 0)
          throw new Error("old_text was not found; read the file again and copy the text exactly");
        if (count > 1)
          throw new Error(`old_text matches ${count} times; include more surrounding lines`);
        await writeRaw(
          ctx,
          rel,
          text.replace(old_text, () => new_text),
        );
        return `Edited ${rel}`;
      },
    }),
    defineTool({
      name: "create_file",
      description:
        "Create a new file or overwrite an existing one. Prefer edit_file for existing files.",
      input: z.object({ path: z.string(), content: z.string(), reason: z.string().optional() }),
      async run({ path, content, reason }) {
        const rel = ctx.policy.checkEdit(path, reason);
        await writeRaw(ctx, rel, content);
        return `Wrote ${rel} (${content.length} characters)`;
      },
    }),
    defineTool({
      name: "run_check",
      description: `Run one of the repository's checks and get its exit code and output tail. Available: ${checkNames.join(", ")}. "install" re-installs dependencies (needed after editing a manifest).`,
      input: z.object({ name: z.enum(checkNames) }),
      async run({ name }) {
        const check = ctx.checks.find((c) => c.name === name);
        if (!check) throw new Error(`unknown check ${name}`);
        const r = await ctx.sandbox.execCheck(check.argv, {
          network: name === "install",
          timeoutSec: agentCheckTimeout(ctx, name),
          guardManifest: name !== "install",
          cwd: check.cwd,
        });
        const out = `${r.stdout}\n${r.stderr}`.trim();
        return `$ ${check.argv.join(" ")}\nexit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${clip(out, 8000)}`;
      },
    }),
  ];
  return tools.map((t) => wrap(ctx, t));
}
