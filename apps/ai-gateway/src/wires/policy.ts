import type { CodingProvider } from "@chalito/billing";

/** What may go out on our key (ADR 0030): bodies are rebuilt from allowlists, so anything the provider would charge
 *  outside the token usage we meter (hosted tools, stored state, priority tiers, extra candidates) never leaves. */
export type Sanitized = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const pick = (b: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => b[k] !== undefined).map((k) => [k, b[k]]));

// Codex and Grok Build send these (codex-api common.rs); everything else is dropped.
const RESPONSES_FIELDS = [
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
  "client_metadata",
  "max_output_tokens",
  "temperature",
  "top_p",
  "truncation",
] as const;
/** Tools the CLI runs itself, per provider. Hosted tools (web search, code interpreter, MCP…) are billed per call. */
const CLIENT_TOOLS: Record<"openai" | "xai", ReadonlySet<string>> = {
  openai: new Set(["function", "custom", "local_shell"]),
  xai: new Set(["function", "custom"]),
};
/** Fields that point at state or work the provider keeps and bills outside this request: refused, not dropped. */
const RESPONSES_REFUSED = ["previous_response_id", "conversation", "background", "prompt"] as const;

export const sanitizeResponses = (
  b: Record<string, unknown>,
  provider: CodingProvider,
  maxOutput: number,
): Sanitized => {
  if (provider !== "openai" && provider !== "xai") return { ok: false, error: "not_managed" };
  if (typeof b.model !== "string") return { ok: false, error: "bad_request" };
  if (RESPONSES_REFUSED.some((k) => b[k] !== undefined && b[k] !== null && b[k] !== false))
    return { ok: false, error: "stored_state_not_allowed" };
  const tools = b.tools === undefined ? [] : b.tools;
  if (!Array.isArray(tools) || !tools.every((t) => obj(t) && CLIENT_TOOLS[provider].has(String(t.type))))
    return { ok: false, error: "tool_not_allowed" };
  const out = pick(b, RESPONSES_FIELDS);
  const asked = typeof b.max_output_tokens === "number" && b.max_output_tokens > 0 ? b.max_output_tokens : Infinity;
  out.max_output_tokens = Math.min(asked, maxOutput);
  out.store = false;
  return { ok: true, body: out };
};

// Gemini's JSON accepts camelCase and snake_case for every field: both spellings are listed, and normalized.
const GEMINI_FIELDS: Record<string, string> = {
  contents: "contents",
  systemInstruction: "systemInstruction",
  system_instruction: "systemInstruction",
  tools: "tools",
  toolConfig: "toolConfig",
  tool_config: "toolConfig",
  generationConfig: "generationConfig",
  generation_config: "generationConfig",
  safetySettings: "safetySettings",
  safety_settings: "safetySettings",
};
const GEMINI_REFUSED = ["cachedContent", "cached_content"];
const GEMINI_TOOL_KEYS = new Set(["functionDeclarations", "function_declarations"]);

const geminiGeneration = (raw: unknown, maxOutput: number): Record<string, unknown> => {
  const g = obj(raw) ? { ...raw } : {};
  const asked = [g.maxOutputTokens, g.max_output_tokens].find((v) => typeof v === "number" && v > 0) as
    number | undefined;
  delete g.max_output_tokens;
  delete g.candidate_count;
  // One candidate: the hold prices one answer.
  return { ...g, candidateCount: 1, maxOutputTokens: Math.min(asked ?? Infinity, maxOutput) };
};

export const sanitizeGemini = (
  b: Record<string, unknown>,
  method: "generateContent" | "streamGenerateContent" | "countTokens",
  maxOutput: number,
): Sanitized => {
  if (method === "countTokens") {
    // Free at Google and nothing is generated: only what it counts.
    const out = pick(b, ["contents", "generateContentRequest"]);
    return { ok: true, body: out };
  }
  if (GEMINI_REFUSED.some((k) => b[k] !== undefined)) return { ok: false, error: "stored_state_not_allowed" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    const to = GEMINI_FIELDS[k];
    if (to && v !== undefined) out[to] = v;
  }
  const tools = out.tools === undefined ? [] : out.tools;
  if (!Array.isArray(tools) || !tools.every((t) => obj(t) && Object.keys(t).every((k) => GEMINI_TOOL_KEYS.has(k))))
    return { ok: false, error: "tool_not_allowed" };
  out.generationConfig = geminiGeneration(out.generationConfig, maxOutput);
  return { ok: true, body: out };
};
