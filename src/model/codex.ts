import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { UsageEntry } from "../schemas/job.ts";
import { run } from "../util/proc.ts";
import { startToolServer } from "./claude-code.ts";
import type {
  AgentRequest,
  AgentResult,
  Effort,
  ModelProvider,
  Role,
  StructuredRequest,
  StructuredResult,
} from "./provider.ts";
import { USAGE_LIMIT_RE, UsageLimitError } from "./provider.ts";

/**
 * Runs the user's own Codex CLI (`codex exec`) signed in with their own ChatGPT plan. For
 * local, personal use: Bumpsmith never sees the login; the unmodified binary does.
 *
 * Safety: every built-in Codex capability that could touch the machine or the network is
 * switched off (shell, unified exec, browser, computer use, web search, plugins, apps,
 * sub-agents, hooks, memories). The model can only use Bumpsmith's own path-confined tools,
 * served over a localhost MCP endpoint that requires a per-run bearer token. Codex runs in
 * an empty temporary directory with its read-only sandbox and the user's config ignored.
 */

const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "apps",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "plugins",
  "hooks",
  "memories",
  "tool_suggest",
  "skill_mcp_dependency_install",
  "goals",
  "workspace_dependencies",
];

const EFFORT: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

interface CodexEvents {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  error: string | null;
}

function parseEvents(jsonl: string): CodexEvents {
  const out: CodexEvents = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, error: null };
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as {
        type?: string;
        usage?: Record<string, number>;
        message?: string;
        error?: { message?: string };
      };
      if (e.type === "turn.completed" && e.usage) {
        out.inputTokens += e.usage.input_tokens ?? 0;
        out.cachedTokens += e.usage.cached_input_tokens ?? 0;
        out.outputTokens += e.usage.output_tokens ?? 0;
      }
      if (e.type === "turn.failed" || e.type === "error")
        out.error = e.error?.message ?? e.message ?? "codex error";
    } catch {
      // ignore non-JSON lines
    }
  }
  return out;
}

export class CodexProvider implements ModelProvider {
  readonly name = "codex";

  constructor(
    readonly model = process.env.BUMPSMITH_CODEX_MODEL ?? "",
    private readonly bin = process.env.BUMPSMITH_CODEX_BIN ?? "codex",
  ) {}

  private async exec(
    prompt: string,
    effort: Effort,
    extra: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ text: string; events: CodexEvents; started: number }> {
    const cwd = await mkdtemp(join(tmpdir(), "bumpsmith-codex-"));
    const outFile = join(cwd, "last-message.txt");
    const started = Date.now();
    // Bill the user's ChatGPT plan, never an API key that happens to be in the environment.
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    delete childEnv.OPENAI_API_KEY;
    try {
      const args = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "-C",
        cwd,
        "-c",
        'web_search="disabled"',
        "-c",
        `model_reasoning_effort="${EFFORT[effort]}"`,
        ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
        ...(this.model ? ["-m", this.model] : []),
        ...extra,
        "-o",
        outFile,
        "-",
      ];
      const r = await run(this.bin, args, {
        cwd,
        env: childEnv,
        input: prompt,
        timeoutMs,
        maxBytes: 8 * 1024 * 1024,
      });
      const events = parseEvents(r.stdout);
      const text = await readFile(outFile, "utf8").catch(() => "");
      const all = `${r.stderr}\n${events.error ?? ""}`;
      if (!text && USAGE_LIMIT_RE.test(all)) throw new UsageLimitError(all.trim());
      if (!text)
        throw new Error(
          `codex produced no answer (exit ${r.exitCode}): ${(events.error ?? r.stderr).slice(-600)}`,
        );
      return { text, events, started };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private usage(role: Role, ev: CodexEvents, started: number): UsageEntry {
    return {
      role,
      provider: this.name,
      model: this.model || "codex-default",
      input_tokens: Math.max(0, ev.inputTokens - ev.cachedTokens),
      output_tokens: ev.outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: ev.cachedTokens,
      // Covered by the user's ChatGPT plan; no list price is applied.
      api_equivalent_usd: 0,
      duration_ms: Date.now() - started,
    };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const schema = JSON.stringify(z.toJSONSchema(req.schema as z.ZodType, { target: "draft-7" }));
    const prompt = `${req.system}\n\nRespond with ONLY a JSON value (no prose, no code fences) that validates against this JSON Schema:\n${schema}\n\n${req.user}`;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const { text, events, started } = await this.exec(
        attempt === 0
          ? prompt
          : `${prompt}\n\nYour previous answer was invalid (${lastError}). Return only valid JSON.`,
        req.effort,
        [],
        {},
        15 * 60_000,
      );
      const json = text
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "");
      try {
        const parsed = req.schema.safeParse(JSON.parse(json));
        if (parsed.success)
          return { data: parsed.data, usage: this.usage(req.role, events, started) };
        lastError = parsed.error.message.slice(0, 300);
      } catch (err) {
        lastError = (err as Error).message.slice(0, 200);
      }
    }
    throw new Error(`codex structured output failed validation: ${lastError}`);
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    const { url, token, server } = await startToolServer(req.tools);
    try {
      const { text, events } = await this.exec(
        `${req.system}\n\nUse only the tools from the "bumpsmith" MCP server.\n\n${req.user}`,
        req.effort,
        [
          "-c",
          `mcp_servers.bumpsmith.url="${url}"`,
          "-c",
          'mcp_servers.bumpsmith.bearer_token_env_var="BUMPSMITH_MCP_TOKEN"',
          "-c",
          "mcp_servers.bumpsmith.tool_timeout_sec=1200",
          "-c",
          "mcp_servers.bumpsmith.startup_timeout_sec=30",
        ],
        { BUMPSMITH_MCP_TOKEN: token },
        Math.max(60_000, (req.timeoutSec ?? 60 * 60) * 1000),
      );
      return {
        finalText: text,
        stop: events.error ? "error" : "completed",
        usage: [this.usage(req.role, events, started)],
        ...(events.error ? { error: events.error } : {}),
      };
    } finally {
      server.close();
    }
  }
}

export async function codexLoggedIn(
  bin = process.env.BUMPSMITH_CODEX_BIN ?? "codex",
): Promise<boolean> {
  const r = await run(bin, ["login", "status"], { timeoutMs: 20_000 }).catch(() => null);
  return !!r && r.exitCode === 0 && !/not logged in/i.test(`${r.stdout}${r.stderr}`);
}

// Exported for tests.
export { DISABLED_FEATURES, parseEvents };
