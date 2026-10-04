import type { ParticipantOutput } from "@chalito/protocol";
import { MesaCard, estimateTokens, CARD_MAX_TOKENS } from "@chalito/protocol";

/**
 * Card merge: proposals and objections become open points (newest kept, ≤6, ≤160 chars), a
 * decision question too; the card is trimmed oldest-first until it fits ≤300 tokens.
 */
const clip = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);

export const mergeCard = (
  card: MesaCard | null,
  mid: string,
  goal: string,
  outputs: { pid: string; name: string; output: ParticipantOutput }[],
): MesaCard => {
  const base: MesaCard = card ?? { v: 1, mid, goal: goal.slice(0, 240), agreed: [], open: [], nextSpeaker: [] };
  const open = [...base.open];
  for (const { name, output } of outputs) {
    for (const p of output.proposals) open.push(clip(`${name}: ${p}`));
    for (const o of output.objections) open.push(clip(`${name} ✗ ${o}`));
    if (output.decision_needed) open.push(clip(`¿${output.decision_needed.question}`));
  }
  const dedup = [...new Set(open)].slice(-6);
  let next: MesaCard = { ...base, open: dedup, nextSpeaker: [] };
  while (estimateTokens(next) > CARD_MAX_TOKENS && next.open.length > 0) next = { ...next, open: next.open.slice(1) };
  while (estimateTokens(next) > CARD_MAX_TOKENS && next.agreed.length > 0)
    next = { ...next, agreed: next.agreed.slice(1) };
  return MesaCard.parse(next);
};
