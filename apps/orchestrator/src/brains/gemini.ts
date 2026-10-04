import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import type { Brain, BrainCall, BrainResult } from "./brain.js";
import { RESPOND_DESCRIPTION, RESPOND_NAME, RESPOND_SCHEMA, parseRespond } from "./respond.js";

/**
 * Gemini through @google/genai: Vertex AI on the `global` endpoint for managed turns (D-012:
 * regional endpoints cost +10%), or the Gemini API with the person's own key (BYO). Verified
 * 2026-10-03: `functionDeclarations` with `parametersJsonSchema`, forced with
 * `toolConfig.functionCallingConfig {mode: ANY, allowedFunctionNames}`; the call is
 * `response.functionCalls[0].args`. Usage: `promptTokenCount` INCLUDES `cachedContentTokenCount`;
 * thinking tokens (`thoughtsTokenCount`) are billed as output.
 */
export class GeminiBrain implements Brain {
  readonly provider = "google" as const;
  constructor(readonly ai: GoogleGenAI) {}

  static vertex(project: string, location = "global") {
    return new GeminiBrain(new GoogleGenAI({ vertexai: true, project, location }));
  }
  static apiKey(apiKey: string) {
    return new GeminiBrain(new GoogleGenAI({ apiKey }));
  }

  async call(c: BrainCall): Promise<BrainResult> {
    const res = await this.ai.models.generateContent({
      model: c.model,
      contents: c.context,
      config: {
        systemInstruction: c.persona,
        maxOutputTokens: c.maxTokens,
        tools: [
          {
            functionDeclarations: [
              { name: RESPOND_NAME, description: RESPOND_DESCRIPTION, parametersJsonSchema: RESPOND_SCHEMA },
            ],
          },
        ],
        toolConfig: {
          functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [RESPOND_NAME] },
        },
      },
    });
    const m = res.usageMetadata;
    const cached = m?.cachedContentTokenCount ?? 0;
    const call = res.functionCalls?.find((f) => f.name === RESPOND_NAME);
    let text = "";
    try {
      text = res.text ?? "";
    } catch {
      /* function-call-only responses have no text */
    }
    return {
      usage: {
        input: Math.max(0, (m?.promptTokenCount ?? 0) - cached),
        output: (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0),
        cacheRead: cached,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
      ...parseRespond(call?.args, text),
    };
  }
}
