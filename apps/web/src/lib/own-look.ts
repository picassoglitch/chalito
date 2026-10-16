/**
 * What a screen draws for the person's own companion while it isn't known yet whether it wears
 * their custom character: the neutral stand-in, never the roster art first and the custom card
 * after. This browser keeps the last look per account (a per-device convenience, never
 * authoritative) so a returning person whose companion wears a roster avatar sees it at once.
 */
export type OwnLook = "pending" | "roster" | "custom";
export type CardAnswer = "unknown" | "none" | "custom";
export type LastLook = { owner: string; kind: "roster" | "custom" };

/** How long the stand-in waits for the custom card's answer before drawing the roster avatar. */
export const CARD_WAIT_MS = 5000;

export const ownLook = (card: CardAnswer, last: LastLook | null): OwnLook =>
  card === "custom" ? "custom" : card === "none" || last?.kind === "roster" ? "roster" : "pending";

const KEY = "chalito.companion.last";

export const loadLastLook = (
  owner: string | undefined,
  storage: () => Pick<Storage, "getItem"> = () => window.localStorage,
): LastLook | null => {
  if (!owner) return null;
  try {
    const v = JSON.parse(storage().getItem(KEY) ?? "null") as Partial<{ owner: unknown; kind: unknown }> | null;
    // Another account's look on a shared browser is never used.
    return v?.owner === owner && (v.kind === "roster" || v.kind === "custom") ? { owner, kind: v.kind } : null;
  } catch {
    return null;
  }
};

export const saveLastLook = (
  v: LastLook,
  storage: () => Pick<Storage, "setItem"> = () => window.localStorage,
): void => {
  try {
    storage().setItem(KEY, JSON.stringify(v));
  } catch {
    // Blocked or full: next time it waits for the answer instead.
  }
};
