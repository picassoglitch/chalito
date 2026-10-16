import type { CardFiles } from "@chalito/scene/custom-card";

/**
 * Which card the pet draws, decided once per change and never "on the way": the neutral
 * placeholder until the companion's look is known, then that look. Before this, the pet drew the
 * roster avatar straight away and swapped to the person's custom character when the api answered,
 * so someone wearing their own character saw another one first.
 */
export type PetCard = { kind: "wait" } | { kind: "roster"; avatar: string } | { kind: "custom"; files: CardFiles };

/** What the pet drew last time on this device (a per-device convenience, never authoritative). */
export type LastDrawn = { kind: "roster"; avatar: string } | { kind: "custom" };

/** How long the placeholder waits for the custom card's answer before drawing the roster avatar. */
export const CARD_WAIT_MS = 5000;

export const petCard = (o: {
  /** The roster avatar from the local settings. */
  avatar: string;
  /** The custom card: undefined until the api answered, null when there is none (or no source). */
  card: CardFiles | null | undefined;
  /** CARD_WAIT_MS passed without an answer. */
  gaveUp: boolean;
  last: LastDrawn | null;
}): PetCard => {
  if (o.card) return { kind: "custom", files: o.card };
  if (o.card === null || o.gaveUp) return { kind: "roster", avatar: o.avatar };
  // Not known yet: last time's roster avatar shows at once (a returning pet); anything else waits.
  return o.last?.kind === "roster" && o.last.avatar === o.avatar
    ? { kind: "roster", avatar: o.avatar }
    : { kind: "wait" };
};

const LAST_KEY = "chalito-desktop-pet-last";

export const loadLastDrawn = (storage: () => Pick<Storage, "getItem"> = () => localStorage): LastDrawn | null => {
  try {
    const v = JSON.parse(storage().getItem(LAST_KEY) ?? "null") as Partial<{ kind: unknown; avatar: unknown }> | null;
    if (v?.kind === "custom") return { kind: "custom" };
    if (v?.kind === "roster" && typeof v.avatar === "string") return { kind: "roster", avatar: v.avatar };
    return null;
  } catch {
    return null;
  }
};

export const saveLastDrawn = (v: LastDrawn, storage: () => Pick<Storage, "setItem"> = () => localStorage): void => {
  try {
    storage().setItem(LAST_KEY, JSON.stringify(v));
  } catch {
    // Blocked or full: the next launch waits for the answer instead.
  }
};
