import type { ApprovalView, SessionView, Snapshot } from "@chalito/client";
import { needsStepUp } from "../stepup.js";
import type { VoiceCommand } from "./intent.js";

/** Why the card can't approve from here; the Inbox row says the same and offers the same way out. */
export type ApproveBlock = "nothing" | "unverified" | "phoneOnly" | "openFull";

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

const summary = (a: ApprovalView): string =>
  typeof a.details?.summary === "string"
    ? a.details.summary
    : typeof a.details?.tool === "string"
      ? a.details.tool
      : a.origin;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const labelOf = (s: SessionView): string => s.label ?? s.card?.label ?? s.adapter ?? s.sid.slice(0, 8);
/** What a spoken name can match: the label, its folder and its goal. */
const words = (s: SessionView): string => fold(`${labelOf(s)} ${s.card?.workspaceLabel ?? ""} ${s.card?.goal ?? ""}`);

/** Named: every spoken word in its name. Unnamed: the first session waiting on the person, else the latest. */
export const pickSession = (
  snap: Pick<Snapshot, "sessions" | "approvals">,
  target: string | null,
): SessionTarget | null => {
  const sessions = [...snap.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const said = target ? fold(target).split(/\s+/).filter(Boolean) : [];
  const waiting = new Set(snap.approvals.filter((a) => a.status === "pending").map((a) => a.sid));
  const s = said.length
    ? sessions.find((x) => said.every((w) => words(x).includes(w)))
    : (sessions.find((x) => waiting.has(x.sid)) ?? sessions[0]);
  return s ? { sid: s.sid, label: labelOf(s) } : null;
};

export const pendingItem = (snap: Pick<Snapshot, "approvals">): { view: ApprovalView; item: PendingItem } | null => {
  const pending = snap.approvals.filter((a) => a.status === "pending");
  const a = pending[0];
  return a ? { view: a, item: { aid: a.aid, summary: summary(a), risk: a.risk, more: pending.length - 1 } } : null;
};

export const approveBlock = (a: ApprovalView | undefined, canStepUp: boolean): ApproveBlock | null =>
  !a
    ? "nothing"
    : !a.verified
      ? "unverified"
      : needsStepUp(a) && !canStepUp
        ? "phoneOnly"
        : a.details?.summaryTruncated === true
          ? "openFull"
          : null;

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
