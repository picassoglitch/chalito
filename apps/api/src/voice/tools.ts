import type { RealtimeTool } from "@chalito/adapters/voice";

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): RealtimeTool => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false },
});

/**
 * Desktop push-to-talk tools (ADR 0005). The desktop app executes them; each one turns into a
 * short text command or opens a screen. open_approval only opens the approval in the app, where
 * the user signs it; nothing here approves, denies or decides.
 */
export const DESKTOP_TOOLS: RealtimeTool[] = [
  fn(
    "route_to",
    "Send a short text instruction to one of the user's agent sessions.",
    {
      session_ref: { type: "string" },
      text: { type: "string" },
    },
    ["session_ref", "text"],
  ),
  fn(
    "open_approval",
    "Open a pending approval in the app so the user can review and sign it there.",
    { aid: { type: "string" } },
    ["aid"],
  ),
  fn("mesa_say", "Say something in the current Mesa (meeting) on the user's behalf.", { text: { type: "string" } }, [
    "text",
  ]),
  fn("snooze", "Snooze notifications for some minutes.", { minutes: { type: "integer", minimum: 1, maximum: 240 } }, [
    "minutes",
  ]),
  fn(
    "room_say",
    "Send a short message to one of the user's rooms.",
    { room_ref: { type: "string" }, text: { type: "string" } },
    ["room_ref", "text"],
  ),
];
