import Anthropic from "@anthropic-ai/sdk";
import { EmotionTag, ParticipantOutput } from "@chalito/protocol";
import type { Brain, BrainCall, BrainResult } from "./brain.js";

/**
 * Brains on the Claude API (Anthropic TS SDK). Structured output through one forced tool,
 * `respond`, shaped like ParticipantOutput; it is the ONLY tool, so a model can't call anything,
 * and nothing it returns can decide an approval. The persona prefix carries `cache_control`
 * (it only caches above the model's minimum prompt length; usage tells us whether it did).
 */
const RESPOND_TOOL: Anthropic.Tool = {
  name: "respond",
  description: "Your turn at the Mesa.",
  input_schema: {
    type: "object",
    properties: {
      say: { type: "string", description: "What you say to the table (≤2000 chars)." },
      proposals: { type: "array", items: { type: "string" }, maxItems: 5 },
      objections: { type: "array", items: { type: "string" }, maxItems: 5 },
      decision_needed: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
        },
        required: ["question", "options"],
      },
      emotion: {
        type: "object",
        properties: {
          tag: { type: "string", enum: [...EmotionTag.options] },
          intensity: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["tag", "intensity"],
      },
    },
    required: ["say", "emotion"],
  },
};

export class AnthropicBrain implements Brain {
  readonly client: Anthropic;
  constructor(opts: { apiKey: string; baseURL?: string; maxRetries?: number; client?: Anthropic }) {
    this.client =
      opts.client ??
      new Anthropic({
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
      tools: [RESPOND_TOOL],
      tool_choice: { type: "tool", name: "respond" },
    });
    const u = msg.usage;
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    const write5m =
      u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h);
    const usage = {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
    };
    const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "respond");
    const parsed = ParticipantOutput.safeParse(tool?.input);
    if (parsed.success) return { output: parsed.data, usage, repaired: false };
    // Invalid output never reaches the table as-is: keep only bounded text, neutral emotion.
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
    const say = (
      typeof (tool?.input as { say?: unknown })?.say === "string" ? (tool!.input as { say: string }).say : text
    ).slice(0, 2000);
    return {
      output: ParticipantOutput.parse({ say: say || "…", emotion: { tag: "neutral", intensity: 0.3 } }),
      usage,
      repaired: true,
    };
  }
}
