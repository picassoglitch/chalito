import type { ApprovalView, SessionView, Snapshot } from "@chalito/client";
import { approvalSummary, approveBlock, type ApproveBlock } from "../approval-rules.js";
import type { VoiceCommand } from "./intent.js";

export type { ApproveBlock };

export interface PendingItem {
  aid: string;
  summary: string;
  risk: ApprovalView["risk"];
  /** Other approvals also waiting. */
  more: number;
}

export interface SessionTarget {
  sid: string;
  label: string;
}

/** A command bound to what it acts on when the card was drawn, so a click never hits a different item. */
export type CardOption =
  | { kind: "approve"; item: PendingItem | null; block: ApproveBlock | null }
  | { kind: "deny"; item: PendingItem | null }
  | { kind: "open"; session: SessionTarget | null }
  | { kind: "newSession"; prompt: string }
  | { kind: "pause"; minutes: number }
  | { kind: "dnd"; on: boolean };

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const labelOf = (s: SessionView): string => s.label ?? s.card?.label ?? s.adapter ?? s.sid.slice(0, 8);
/** What a spoken name can match, word by word: the label, its folder and its goal. */
const words = (s: SessionView): Set<string> =>
  new Set(fold(`${labelOf(s)} ${s.card?.workspaceLabel ?? ""} ${s.card?.goal ?? ""}`).split(/[^\p{L}\p{N}]+/u));

/** Named: every spoken word in its name. Unnamed: the first session waiting on the person, else the latest. */
export const pickSession = (
  snap: Pick<Snapshot, "sessions" | "approvals">,
  target: string | null,
): SessionTarget | null => {
  const sessions = [...snap.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const said = target
    ? fold(target)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean)
    : [];
  const waiting = new Set(snap.approvals.filter((a) => a.status === "pending").map((a) => a.sid));
  const s = said.length
    ? sessions.find((x) => said.every((w) => words(x).has(w)))
    : (sessions.find((x) => waiting.has(x.sid)) ?? sessions[0]);
  return s ? { sid: s.sid, label: labelOf(s) } : null;
};

export const pendingItem = (snap: Pick<Snapshot, "approvals">): { view: ApprovalView; item: PendingItem } | null => {
  const pending = snap.approvals.filter((a) => a.status === "pending");
  const a = pending[0];
  return a
    ? { view: a, item: { aid: a.aid, summary: approvalSummary(a), risk: a.risk, more: pending.length - 1 } }
    : null;
};

export const cardOptions = (
  commands: readonly VoiceCommand[],
  snap: Pick<Snapshot, "approvals" | "sessions">,
  canStepUp: boolean,
): CardOption[] => {
  const p = pendingItem(snap);
  return commands.map((c): CardOption => {
    switch (c.kind) {
      case "approve":
        return { kind: "approve", item: p?.item ?? null, block: approveBlock(p?.view, canStepUp) };
      case "deny":
        return { kind: "deny", item: p?.item ?? null };
      case "open":
        return { kind: "open", session: pickSession(snap, c.target) };
      default:
        return c;
    }
  });
};

/** Whether a click can run it now. */
export const runnable = (o: CardOption): boolean =>
  o.kind === "approve"
    ? o.block === null
    : o.kind === "deny"
      ? o.item !== null
      : o.kind === "open"
        ? o.session !== null
        : true;

/** "Todo" runs these; an approval always needs its own click. */
export const inAll = (o: CardOption): boolean => o.kind !== "approve" && runnable(o);
