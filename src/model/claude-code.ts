import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AgentTool } from "../agent/tools.ts";
import type { UsageEntry } from "../schemas/job.ts";
import { run } from "../util/proc.ts";
import { costUsd } from "./pricing.ts";
import {
  type AgentRequest,
  type AgentResult,
  type ModelProvider,
  RefusalError,
  type Role,
  SIGN_IN_RE,
  SignInError,
  type StructuredRequest,
  type StructuredResult,
  USAGE_LIMIT_RE,
  UsageLimitError,
} from "./provider.ts";

/**
 * DEVELOPMENT/TESTING PROVIDER. Drives the locally installed Claude Code CLI in
 * headless mode so the founder can test with their own Claude subscription.
 * Never use this for customer jobs; production uses AnthropicProvider (paid API).
 *
 * Isolation: all built-in Claude Code tools are disabled (--tools ""), user and
 * project settings are not loaded (--setting-sources ""), and the only tools are
 * the Bumpsmith sandbox tools, served from this process over a loopback MCP server
 * that requires a random bearer token.
 */

interface ClaudeResult {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  stop_reason?: string | null;
  terminal_reason?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
  api_error_status?: number | null;
}

const MCP_NAME = "bumpsmith";

export async function startToolServer(
  tools: AgentTool[],
): Promise<{ url: string; token: string; server: Server }> {
  const token = randomBytes(24).toString("hex");
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer(async (req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const mcp = new McpServer({ name: MCP_NAME, version: "0.0.1" });
    for (const t of tools) {
      mcp.registerTool(
        t.name,
        { description: t.description, inputSchema: t.input },
        async (args: unknown) => {
          const text = await t.run(args as never);
          return { content: [{ type: "text", text }], isError: text.startsWith("ERROR:") };
        },
      );
    }
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, token, server };
}

export class ClaudeCodeProvider implements ModelProvider {
  readonly name = "claude-code";

  constructor(
    readonly model = "claude-opus-5-5",
    private readonly bin = process.env.BUMPSMITH_CLAUDE_BIN ?? "claude",
  ) {}

  /** One retry after a pause when the CLI exits without a result (killed, rate limited, crashed). */
  private async invoke(args: string[], prompt: string, timeoutMs: number): Promise<ClaudeResult> {
    try {
      return await this.invokeOnce(args, prompt, timeoutMs);
    } catch (err) {
      if (!(err instanceof Error && /produced no JSON/.test(err.message))) throw err;
      await new Promise((r) => setTimeout(r, 60_000));
      return this.invokeOnce(args, prompt, timeoutMs);
    }
  }

  private async invokeOnce(
    args: string[],
    prompt: string,
    timeoutMs: number,
  ): Promise<ClaudeResult> {
    const cwd = await mkdtemp(join(tmpdir(), "bumpsmith-cc-"));
    // Force subscription auth: an API key in the environment would bill the API instead.
    const env = { ...process.env };
    // Everything that outranks the /login subscription, or reroutes requests, per the
    // authentication precedence in the Claude Code docs.
    for (const k of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ])
      delete env[k];
    try {
      const r = await run(
        this.bin,
        [
          "-p",
          "--output-format",
          "json",
          "--model",
          this.model,
          "--no-session-persistence",
          "--setting-sources",
          "",
          ...args,
        ],
        { cwd, env, input: prompt, timeoutMs, maxBytes: 8 * 1024 * 1024 },
      );
      const line = r.stdout
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("{"));
      if (!line) {
        if (SIGN_IN_RE.test(`${r.stdout}\n${r.stderr}`))
          throw new SignInError("claude", `${r.stdout}\n${r.stderr}`.trim());
        if (USAGE_LIMIT_RE.test(`${r.stdout}\n${r.stderr}`))
          throw new UsageLimitError(`${r.stdout}\n${r.stderr}`.trim());
        throw new Error(`claude produced no JSON (exit ${r.exitCode}): ${r.stderr.slice(-800)}`);
      }
      const res = JSON.parse(line) as ClaudeResult;
      // The CLI reports a closed limit as a short result, sometimes with subtype "success".
      const text = res.result ?? "";
      if (text.length < 400 && SIGN_IN_RE.test(text)) throw new SignInError("claude", text);
      if (text.length < 400 && /hit your .{0,40}limit/i.test(text)) throw new UsageLimitError(text);
      if (res.is_error && USAGE_LIMIT_RE.test(text)) throw new UsageLimitError(text);
      return res;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private usage(role: Role, res: ClaudeResult, started: number): UsageEntry {
    const u = {
      input_tokens: res.usage?.input_tokens ?? 0,
      output_tokens: res.usage?.output_tokens ?? 0,
      cache_creation_input_tokens: res.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: res.usage?.cache_read_input_tokens ?? 0,
    };
    const listed = costUsd(this.model, u);
    return {
      role,
      provider: this.name,
      model: this.model,
      ...u,
      api_equivalent_usd: res.total_cost_usd ?? listed,
      duration_ms: Date.now() - started,
    };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const jsonSchema = z.toJSONSchema(req.schema as z.ZodType, { target: "draft-7" });
    const res = await this.invoke(
      [
        "--system-prompt",
        req.system,
        "--json-schema",
        JSON.stringify(jsonSchema),
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({ mcpServers: {} }),
        "--effort",
        req.effort,
        "--max-turns",
        "4",
      ],
      req.user,
      15 * 60_000,
    );
    if (res.stop_reason === "refusal") throw new RefusalError(null);
    if (res.is_error || res.structured_output === undefined)
      throw new Error(
        `claude structured call failed: ${res.subtype} ${res.result?.slice(0, 500) ?? ""}`,
      );
    const parsed = req.schema.safeParse(res.structured_output);
    if (!parsed.success)
      throw new Error(`structured output failed validation: ${parsed.error.message}`);
    return { data: parsed.data, usage: this.usage(req.role, res, started) };
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    const started = Date.now();
    const { url, token, server } = await startToolServer(req.tools);
    try {
      const mcpConfig = {
        mcpServers: {
          [MCP_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
        },
      };
      const res = await this.invoke(
        [
          "--system-prompt",
          req.system,
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify(mcpConfig),
          "--allowedTools",
          `mcp__${MCP_NAME}`,
          "--permission-mode",
          "dontAsk",
          "--effort",
          req.effort,
          "--max-turns",
          String(req.maxTurns),
          "--max-budget-usd",
          req.budgetUsd.toFixed(2),
        ],
        req.user,
        Math.max(60_000, (req.timeoutSec ?? 60 * 60) * 1000),
      );
      const usage = [this.usage(req.role, res, started)];
      const finalText = res.result ?? "";
      if (res.stop_reason === "refusal") return { finalText, stop: "refusal", usage };
      if (/max_turns/.test(res.subtype) || res.terminal_reason === "max_turns")
        return { finalText, stop: "max_turns", usage };
      if (/budget/.test(res.subtype) || /budget/.test(res.terminal_reason ?? ""))
        return { finalText, stop: "budget", usage };
      if (res.is_error)
        return {
          finalText,
          stop: "error",
          usage,
          error: `${res.subtype} ${finalText.slice(0, 500)}`,
        };
      return { finalText, stop: "completed", usage };
    } finally {
      server.close();
    }
  }
}
