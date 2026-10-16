import { sha256 } from "./webauthn.js";

/**
 * The session id of an outside hand-off task (MCP `create_task`, A2A `SendMessage`; ADR 0022 §4,
 * M16 F): made on the device from who asked and the task's command id, never chosen by the cloud
 * or the caller. The gateway computes the same id to follow the task (`get_task`, A2A GetTask).
 */
export const outsideTaskSid = async (owner: string, origin: string, cid: string): Promise<string> => {
  const digest = await sha256(new TextEncoder().encode(`chalito.outside-task.v1\n${owner}\n${origin}\n${cid}`));
  return `lnk_${[...digest.slice(0, 24)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
};
