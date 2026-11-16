import type { UsageEntry } from "../schemas/job.ts";
import type {
  AgentRequest,
  AgentResult,
  ModelProvider,
  Role,
  StructuredRequest,
  StructuredResult,
} from "./provider.ts";

/** Scripted provider for tests: no network, no spend. */
export class FakeProvider implements ModelProvider {
  readonly name = "fake";
  readonly model = "fake-model";
  readonly calls: { kind: "structured" | "agent"; role: Role; user: string }[] = [];

  constructor(
    private readonly script: {
      structured?: (req: StructuredRequest<unknown>) => unknown;
      agent?: (req: AgentRequest) => Promise<string>;
    },
  ) {}

  private usage(role: Role): UsageEntry {
    return {
      role,
      provider: this.name,
      model: this.model,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      api_equivalent_usd: 0,
      duration_ms: 0,
    };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push({ kind: "structured", role: req.role, user: req.user });
    if (!this.script.structured) throw new Error("FakeProvider: no structured script");
    const data = req.schema.parse(this.script.structured(req as StructuredRequest<unknown>));
    return { data, usage: this.usage(req.role) };
  }

  async runAgent(req: AgentRequest): Promise<AgentResult> {
    this.calls.push({ kind: "agent", role: req.role, user: req.user });
    if (!this.script.agent) throw new Error("FakeProvider: no agent script");
    const finalText = await this.script.agent(req);
    return { finalText, stop: "completed", usage: [this.usage(req.role)] };
  }
}
