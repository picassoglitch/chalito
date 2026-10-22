import { describe, expect, it } from "vitest";
import { sanitizeGemini, sanitizeResponses } from "../src/wires/policy.js";

describe("Responses bodies are rebuilt from an allowlist (ADR 0030)", () => {
  const codex = { model: "gpt-5.6-luna", stream: true, input: [], tools: [{ type: "function", name: "shell" }] };

  it("keeps what Codex sends, clamps the output, forces store off, drops unknown and priced fields", () => {
    const r = sanitizeResponses(
      { ...codex, store: true, service_tier: "priority", n: 4, metadata: { a: 1 } },
      "openai",
      32_000,
    );
    expect(r).toEqual({ ok: true, body: { ...codex, max_output_tokens: 32_000, store: false } });
  });

  it("only tools the CLI runs itself, per provider; hosted and unknown tool types are refused", () => {
    for (const type of [
      "web_search",
      "web_search_preview",
      "file_search",
      "code_interpreter",
      "image_generation",
      "mcp",
      "computer_use_preview",
      "brand_new_hosted_tool",
      "",
    ])
      expect(sanitizeResponses({ ...codex, tools: [{ type }] }, "openai", 1), type).toEqual({
        ok: false,
        error: "tool_not_allowed",
      });
    expect(sanitizeResponses({ ...codex, tools: [{ type: "local_shell" }] }, "openai", 1).ok).toBe(true);
    expect(sanitizeResponses({ ...codex, tools: [{ type: "local_shell" }] }, "xai", 1).ok).toBe(false);
    expect(sanitizeResponses({ ...codex, tools: "web_search" }, "openai", 1).ok).toBe(false);
  });

  it("stored state and background work are refused", () => {
    for (const extra of [
      { previous_response_id: "r" },
      { conversation: "c" },
      { background: true },
      { prompt: { id: "p" } },
    ])
      expect(sanitizeResponses({ ...codex, ...extra }, "openai", 1)).toEqual({
        ok: false,
        error: "stored_state_not_allowed",
      });
  });
});

describe("Gemini bodies are rebuilt from an allowlist, both spellings", () => {
  const base = { contents: [{ role: "user", parts: [{ text: "hola" }] }] };

  it("only function declarations as tools, camelCase or snake_case; grounding, code execution and unknown tools refused", () => {
    for (const tool of [
      { googleSearch: {} },
      { google_search: {} },
      { codeExecution: {} },
      { code_execution: {} },
      { url_context: {} },
      { googleSearchRetrieval: {} },
      { function_declarations: [], google_search: {} },
      { newHostedThing: {} },
    ])
      expect(sanitizeGemini({ ...base, tools: [tool] }, "generateContent", 1), JSON.stringify(tool)).toEqual({
        ok: false,
        error: "tool_not_allowed",
      });
    expect(
      sanitizeGemini(
        { ...base, tools: [{ function_declarations: [] }, { functionDeclarations: [] }] },
        "generateContent",
        1,
      ).ok,
    ).toBe(true);
  });

  it("cached content is refused in either spelling", () => {
    for (const k of ["cachedContent", "cached_content"])
      expect(sanitizeGemini({ ...base, [k]: "cachedContents/x" }, "streamGenerateContent", 1)).toEqual({
        ok: false,
        error: "stored_state_not_allowed",
      });
  });

  it("the output limit is clamped in either spelling, one candidate, unknown fields dropped", () => {
    const r = sanitizeGemini(
      {
        ...base,
        generation_config: { max_output_tokens: 9_999_999, candidate_count: 8, temperature: 0.2 },
        labels: { x: "y" },
      },
      "generateContent",
      32_000,
    );
    expect(r).toEqual({
      ok: true,
      body: { ...base, generationConfig: { temperature: 0.2, candidateCount: 1, maxOutputTokens: 32_000 } },
    });
  });

  it("countTokens keeps only what it counts", () => {
    expect(sanitizeGemini({ ...base, tools: [{ google_search: {} }], cached_content: "x" }, "countTokens", 1)).toEqual({
      ok: true,
      body: base,
    });
  });
});
