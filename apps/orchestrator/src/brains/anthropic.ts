import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainCall, BrainResult } from "./brain.js";
import { RESPOND_DESCRIPTION, RESPOND_NAME, RESPOND_SCHEMA, parseRespond } from "./respond.js";

/**
 * Claude API (Anthropic TS SDK). The persona prefix carries `cache_control`; it only caches above
 * the model's minimum prompt length, and usage tells us whether it did.
 */
export class AnthropicBrain implements Brain {
  readonly provider = "anthropic" as const;
  readonly client: Anthropic;
  constructor(opts: { apiKey: string; baseURL?: string; maxRetries?: number }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async call(c: BrainCall): Promise<BrainResult> {
    const msg = await this.client.messages.create({
      model: c.model,
      max_tokens: c.maxTokens,
      system: [{ type: "text", text: c.persona, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: c.context }],
      tools: [{ name: RESPOND_NAME, description: RESPOND_DESCRIPTION, input_schema: RESPOND_SCHEMA as never }],
      tool_choice: { type: "tool", name: RESPOND_NAME },
    });
    const u = msg.usage;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m =
      u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h);
    const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === RESPOND_NAME);
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    return {
      // Anthropic reports input_tokens WITHOUT cache reads/writes.
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite5m: write5m,
        cacheWrite1h: write1h,
      },
      ...parseRespond(tool?.input, text),
    };
  }
}
