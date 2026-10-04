import { EmotionTag, ParticipantOutput } from "@chalito/protocol";

/**
 * The one tool every brain must answer with (all providers): `respond`, shaped like
 * ParticipantOutput. It is the ONLY tool offered, so no model can call anything else and nothing
 * it returns can decide an approval (decision_needed only *asks* the person).
 */
export const RESPOND_NAME = "respond";
export const RESPOND_DESCRIPTION = "Your turn at the Mesa.";
export const RESPOND_SCHEMA = {
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
} as const;

/** Validates a `respond` call; anything invalid becomes bounded text with a neutral emotion. */
export const parseRespond = (input: unknown, fallbackText = ""): { output: ParticipantOutput; repaired: boolean } => {
  const parsed = ParticipantOutput.safeParse(input);
  if (parsed.success) return { output: parsed.data, repaired: false };
  const say = (
    typeof (input as { say?: unknown } | null)?.say === "string" ? (input as { say: string }).say : fallbackText
  ).slice(0, 2000);
  return {
    output: ParticipantOutput.parse({ say: say || "…", emotion: { tag: "neutral", intensity: 0.3 } }),
    repaired: true,
  };
};

/** JSON.parse that never throws (function-call arguments arrive as strings on Responses APIs). */
export const safeJson = (s: string | undefined): unknown => {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};
