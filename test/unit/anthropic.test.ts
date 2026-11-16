import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/agent/tools.ts";
import { AnthropicProvider } from "../../src/model/anthropic.ts";

/** Captures requests the SDK would send and replies with canned Messages API responses. */
function mockClient(replies: unknown[]) {
  const requests: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: String(url), headers, body: JSON.parse(String(init?.body)) });
    const reply = replies.shift() as Record<string, unknown>;
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    if (body.stream)
      return new Response(toSse(reply), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = new Anthropic({
    apiKey: "test-key",
    fetch: fetchImpl as typeof fetch,
    maxRetries: 0,
  });
  return { client, requests };
}

/** Render a Message as the Messages API server-sent event stream. */
function toSse(msg: Record<string, unknown>): string {
  const ev = (type: string, data: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`;
  const content = msg.content as Record<string, unknown>[];
  const u = msg.usage as Record<string, number>;
  let out = ev("message_start", {
    message: { ...msg, content: [], stop_reason: null, usage: { ...u, output_tokens: 1 } },
  });
  content.forEach((b, index) => {
    if (b.type === "text") {
      out += ev("content_block_start", { index, content_block: { type: "text", text: "" } });
      out += ev("content_block_delta", { index, delta: { type: "text_delta", text: b.text } });
    } else {
      out += ev("content_block_start", { index, content_block: { ...b, input: {} } });
      out += ev("content_block_delta", {
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) },
      });
    }
    out += ev("content_block_stop", { index });
  });
  out += ev("message_delta", {
    delta: {
      stop_reason: msg.stop_reason,
      stop_sequence: null,
      stop_details: msg.stop_details ?? null,
    },
    usage: u,
  });
  out += ev("message_stop", {});
  return out;
}

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const message = (content: unknown[], stop_reason: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  stop_details: null,
  usage,
});

describe("AnthropicProvider request shape (API version 2026-10-21, claude-opus-5-5)", () => {
  it("sends structured output with explicit effort, fallbacks, caching and no sampling params", async () => {
    const { client, requests } = mockClient([
      message([{ type: "text", text: '{"answer":7}' }], "end_turn"),
    ]);
    const p = new AnthropicProvider("claude-opus-5-5", client);
    const res = await p.structured({
      role: "extractor",
      system: "sys",
      user: "hi",
      schema: z.object({ answer: z.number() }),
      effort: "high",
    });
    expect(res.data).toEqual({ answer: 7 });
    expect(res.usage.api_equivalent_usd).toBeCloseTo((100 * 4 + 20 * 20) / 1e6);
    const r = requests[0];
    expect(r?.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(r?.body.model).toBe("claude-opus-5-5");
    expect(r?.body.fallbacks).toBe("default");
    expect(r?.body.cache_control).toEqual({ type: "ephemeral" });
    expect((r?.body.output_config as { effort: string } | undefined)?.effort).toBe("high");
    expect((r?.body.output_config as { format: { type: string } } | undefined)?.format.type).toBe(
      "json_schema",
    );
    for (const banned of ["temperature", "top_p", "top_k", "tool_choice", "thinking"])
      expect(r?.body).not.toHaveProperty(banned);
  });

  it("raises on refusal", async () => {
    const { client } = mockClient([
      {
        ...message([], "refusal"),
        stop_details: { type: "refusal", category: "cyber", explanation: "x" },
      },
    ]);
    const p = new AnthropicProvider("claude-opus-5-5", client);
    await expect(
      p.structured({
        role: "reviewer",
        system: "s",
        user: "u",
        schema: z.object({}),
        effort: "high",
      }),
    ).rejects.toThrow(/declined/);
  });

  it("runs the tool loop, executes tools and accounts usage per turn", async () => {
    const { client, requests } = mockClient([
      message(
        [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.ts" } }],
        "tool_use",
      ),
      message([{ type: "text", text: "done" }], "end_turn"),
    ]);
    const calls: string[] = [];
    const tool = defineTool({
      name: "read_file",
      description: "read",
      input: z.object({ path: z.string() }),
      run: async ({ path }) => {
        calls.push(path);
        return "contents";
      },
    });
    const p = new AnthropicProvider("claude-opus-5-5", client);
    const res = await p.runAgent({
      role: "fixer",
      system: "s",
      user: "u",
      tools: [tool],
      effort: "high",
      maxTurns: 5,
      budgetUsd: 5,
    });
    expect(res.error).toBeUndefined();
    expect(calls).toEqual(["src/a.ts"]);
    expect(res.stop).toBe("completed");
    expect(res.finalText).toBe("done");
    expect(res.usage).toHaveLength(2);
    const second = requests[1]?.body.messages as {
      role: string;
      content: { type: string; tool_use_id?: string }[];
    }[];
    expect(second.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_1",
    });
    expect(requests[0]?.body).not.toHaveProperty("tool_choice");
    expect(requests[0]?.body.stream).toBe(true);
    const sentTools = requests[0]?.body.tools as { eager_input_streaming?: boolean }[];
    expect(sentTools[0]?.eager_input_streaming).toBe(true);
  });

  it("stops when the dollar budget is exhausted", async () => {
    const big = { ...usage, input_tokens: 2_000_000 };
    const { client } = mockClient([
      {
        ...message(
          [{ type: "tool_use", id: "t", name: "read_file", input: { path: "a" } }],
          "tool_use",
        ),
        usage: big,
      },
    ]);
    const tool = defineTool({
      name: "read_file",
      description: "r",
      input: z.object({ path: z.string() }),
      run: async () => "x",
    });
    const p = new AnthropicProvider("claude-opus-5-5", client);
    const res = await p.runAgent({
      role: "fixer",
      system: "s",
      user: "u",
      tools: [tool],
      effort: "high",
      maxTurns: 5,
      budgetUsd: 1,
    });
    expect(res.stop).toBe("budget");
  });
});
