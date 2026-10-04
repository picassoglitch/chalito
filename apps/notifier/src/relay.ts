import { randomUUID } from "node:crypto";
import { fromB64url, randomNonce, sealJson } from "@chalito/crypto";
import { RelayedCommand } from "@chalito/protocol";
import type { NotifierStore } from "./store.js";

/**
 * A spoken answer on a call becomes a text prompt to one session, relayed with origin
 * `call:<CallSid>` (ADR 0011). That is the only thing speech can produce: a RelayedCommand,
 * which the protocol restricts to session.prompt / session.answer from mcp:/call: origins, and
 * which the agent never lets auto-approve anything. There is no code path to a Decision.
 */
export const relaySpokenAnswer = async (
  store: NotifierStore,
  p: { uid: string; callSid: string; targetDeviceId: string; sid: string; text: string; now: number },
): Promise<RelayedCommand> => {
  const pubBox = await store.agentPubBox(p.uid, p.targetDeviceId);
  if (!pubBox) throw new Error("unknown agent");
  const cid = `c${randomUUID().replace(/-/g, "")}`;
  const expiresAt = p.now + 5 * 60_000;
  const env = RelayedCommand.parse({
    relayedBy: "notifier",
    body: {
      v: 1,
      cid,
      uid: p.uid,
      targetDeviceId: p.targetDeviceId,
      origin: `call:${p.callSid}`,
      nonce: await randomNonce(),
      issuedAt: p.now,
      expiresAt,
      payload: {
        type: "session.prompt",
        sid: p.sid,
        promptCt: await sealJson(p.text, { [p.targetDeviceId]: await fromB64url(pubBox) }, `command:${cid}`),
      },
    },
  });
  await store.insertRelayedCommand(p.uid, p.targetDeviceId, cid, env, expiresAt);
  return env;
};
