import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/agent/tools.ts";
import { assertSafeBaseUrl, OpenAICompatibleProvider } from "../../src/model/openai-compatible.ts";

/** A fake chat-completions server: returns queued responses and records requests. */
function fakeClient(responses: ((body: Record<string, unknown>) => unknown)[]) {
  const requests: Record<string, unknown>[] = [];
  const client = new OpenAI({
    apiKey: "test",
    baseURL: "https://fake.example/v1",
    maxRetries: 0,
    fetch: (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(body);
      const next = responses.shift();
      if (!next) throw new Error("no more fake responses");
      const out = next(body) as { status?: number; json: unknown };
      return new Response(JSON.stringify(out.json), {
        status: out.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { client, requests };
}

const completion = (message: Record<string, unknown>) => ({
  json: {
    id: "c1",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: null, ...message },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  },
});

describe("OpenAI-compatible provider", () => {
  it("returns validated structured output and retries once on invalid JSON", async () => {
    const { client, requests } = fakeClient([
      () => completion({ content: '{"answer": 42' }),
      () => completion({ content: '```json\n{"answer": 42}\n```' }),
    ]);
    const p = new OpenAICompatibleProvider({
      preset: "openai",
      model: "m",
      client,
      pricing: { input: 1, output: 2 },
    });
    const r = await p.structured({
      role: "extractor",
      system: "s",
      user: "u",
      schema: z.object({ answer: z.number() }),
      effort: "high",
    });
    expect(r.data).toEqual({ answer: 42 });
    expect(requests).toHaveLength(2);
    expect((requests[0]?.response_format as { type: string } | undefined)?.type).toBe(
      "json_schema",
    );
    expect(r.usage.api_equivalent_usd).toBeCloseTo((100 * 1 + 20 * 2) / 1e6);
  });

  it("falls back to JSON mode when the endpoint rejects JSON schema", async () => {
    const { client, requests } = fakeClient([
      () => ({
        status: 400,
        json: { error: { message: "response_format json_schema not supported" } },
      }),
      () => completion({ content: '{"ok": true}' }),
    ]);
    const p = new OpenAICompatibleProvider({ preset: "ollama", model: "m", client });
    const r = await p.structured({
      role: "reviewer",
      system: "s",
      user: "u",
      schema: z.object({ ok: z.boolean() }),
      effort: "low",
    });
    expect(r.data).toEqual({ ok: true });
    expect((requests[1]?.response_format as { type: string } | undefined)?.type).toBe(
      "json_object",
    );
  });

  it("runs tools in its own loop and rejects malformed tool arguments", async () => {
    const ran: string[] = [];
    const tool = defineTool({
      name: "read_file",
      description: "read",
      input: z.object({ path: z.string() }),
      async run({ path }) {
        ran.push(path);
        return `contents of ${path}`;
      },
    });
    const { client, requests } = fakeClient([
      () =>
        completion({
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
            },
            {
              id: "t2",
              type: "function",
              function: { name: "read_file", arguments: '{"wrong":1}' },
            },
          ],
        }),
      () => completion({ content: "done: edited src/a.ts" }),
    ]);
    const p = new OpenAICompatibleProvider({ preset: "openai", model: "m", client });
    const r = await p.runAgent({
      role: "fixer",
      system: "s",
      user: "u",
      tools: [tool as never],
      effort: "high",
      maxTurns: 5,
      budgetUsd: 1,
    });
    expect(r.stop).toBe("completed");
    expect(r.finalText).toBe("done: edited src/a.ts");
    expect(ran).toEqual(["src/a.ts"]);
    const toolMessages = (
      (requests[1]?.messages ?? []) as { role: string; content: string }[]
    ).filter((m) => m.role === "tool");
    expect(toolMessages[0]?.content).toBe("contents of src/a.ts");
    expect(toolMessages[1]?.content).toMatch(/^ERROR: invalid arguments/);
  });

  it("stops at the turn limit", async () => {
    const loop = () =>
      completion({
        tool_calls: [{ id: "t", type: "function", function: { name: "nope", arguments: "{}" } }],
      });
    const { client } = fakeClient([loop, loop, loop]);
    const p = new OpenAICompatibleProvider({ preset: "openai", model: "m", client });
    const r = await p.runAgent({
      role: "fixer",
      system: "s",
      user: "u",
      tools: [],
      effort: "high",
      maxTurns: 2,
      budgetUsd: 1,
    });
    expect(r.stop).toBe("max_turns");
  });

  it("refuses plain-HTTP endpoints except on this machine, and requires a model", () => {
    expect(() => assertSafeBaseUrl("http://example.com/v1")).toThrow(/non-HTTPS/);
    expect(() => assertSafeBaseUrl("http://localhost:11434/v1")).not.toThrow();
    expect(() => assertSafeBaseUrl("https://openrouter.ai/api/v1")).not.toThrow();
    expect(
      () => new OpenAICompatibleProvider({ preset: "openai", model: "", apiKey: "k" }),
    ).toThrow(/--model is required/);
    expect(() => new OpenAICompatibleProvider({ preset: "nope", model: "m", apiKey: "k" })).toThrow(
      /unknown provider/,
    );
  });
});
