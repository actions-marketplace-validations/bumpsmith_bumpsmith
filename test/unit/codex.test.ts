import { describe, expect, it } from "vitest";
import { DISABLED_FEATURES, parseEvents } from "../../src/model/codex.ts";

describe("codex provider", () => {
  it("switches off every built-in capability that can reach the machine or the network", () => {
    for (const f of [
      "shell_tool",
      "unified_exec",
      "browser_use",
      "computer_use",
      "apps",
      "plugins",
      "multi_agent",
      "hooks",
    ])
      expect(DISABLED_FEATURES).toContain(f);
  });
  it("adds up token usage and surfaces failures from the JSON event stream", () => {
    const ev = parseEvents(
      [
        '{"type":"thread.started"}',
        '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":200,"output_tokens":300}}',
        "not json",
        '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
      ].join("\n"),
    );
    expect(ev).toEqual({ inputTokens: 1300, cachedTokens: 200, outputTokens: 350, error: null });
    expect(
      parseEvents('{"type":"turn.failed","error":{"message":"usage limit reached"}}').error,
    ).toBe("usage limit reached");
  });
});
