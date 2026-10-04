import OpenAI from "openai";
import { createHash } from "node:crypto";
import type { Brain, BrainCall, BrainResult } from "./brain.js";
import { RESPOND_DESCRIPTION, RESPOND_NAME, RESPOND_SCHEMA, parseRespond, safeJson } from "./respond.js";

/**
 * OpenAI and xAI through the Responses API (official `openai` SDK; xAI is OpenAI-compatible at
 * https://api.x.ai/v1). Verified 2026-10-03 (docs/VERIFIED_APIS.md "Brain APIs for the Mesa"):
 * function tool `{type:"function", name, parameters}`, forced with `tool_choice:{type:"function",
 * name}`; the call comes back as an output item `{type:"function_call", name, arguments: string}`.
 * Usage: `input_tokens` INCLUDES `input_tokens_details.cached_tokens` and (OpenAI GPT-5.6+)
 * `cache_write_tokens`, so ordinary input = input − cached − written.
 */
export const XAI_BASE_URL = "https://api.x.ai/v1";

export class ResponsesBrain implements Brain {
  readonly client: OpenAI;
  constructor(
    readonly provider: "openai" | "xai",
    opts: { apiKey: string; baseURL?: string; maxRetries?: number },
  ) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      maxRetries: opts.maxRetries ?? 2,
      baseURL: opts.baseURL ?? (provider === "xai" ? XAI_BASE_URL : undefined),
    });
  }

  async call(c: BrainCall): Promise<BrainResult> {
    const res = await this.client.responses.create({
      model: c.model,
      instructions: c.persona,
      input: c.context,
      tools: [
        {
          type: "function",
          name: RESPOND_NAME,
          description: RESPOND_DESCRIPTION,
          parameters: RESPOND_SCHEMA as unknown as Record<string, unknown>,
          strict: false,
        },
      ],
      tool_choice: { type: "function", name: RESPOND_NAME },
      max_output_tokens: c.maxTokens,
      store: false,
      // OpenAI routes by this key to keep the persona prefix warm (accounting only for writes).
      ...(this.provider === "openai"
        ? { prompt_cache_key: createHash("sha256").update(c.persona).digest("hex").slice(0, 32) }
        : {}),
    });
    const u = res.usage;
    const cached = u?.input_tokens_details?.cached_tokens ?? 0;
    const written = u?.input_tokens_details?.cache_write_tokens ?? 0;
    const call = res.output.find(
      (o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call" && o.name === RESPOND_NAME,
    );
    return {
      usage: {
        input: Math.max(0, (u?.input_tokens ?? 0) - cached - written),
        output: u?.output_tokens ?? 0,
        cacheRead: cached,
        cacheWrite5m: written,
        cacheWrite1h: 0,
      },
      ...parseRespond(safeJson(call?.arguments), res.output_text ?? ""),
    };
  }
}
