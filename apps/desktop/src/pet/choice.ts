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

/** Unknown account state is never permission to substitute a roster character. */
export const petCard = (o: {
  avatar: string;
  /** undefined until the account answers; null only after an authoritative no-custom response. */
  card: CardFiles | null | undefined;
}): PetCard => {
  if (o.card) return { kind: "custom", files: o.card };
  return o.card === null ? { kind: "roster", avatar: o.avatar } : { kind: "wait" };
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
