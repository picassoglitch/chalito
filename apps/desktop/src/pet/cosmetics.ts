import type { SceneCosmetic } from "@chalito/scene";
import type { RoomWindowDeps } from "../lib/room-window.js";
import { sceneMembersFor } from "../room/scene-members.js";

/** How often the pet re-reads what its companion wears (equipping happens in the store). */
export const PET_COSMETICS_REFRESH_MS = 5 * 60 * 1000;

/**
 * What the person's own companion wears, placed from the store catalog: the same directory row
 * and placement co-members see in a room (scene-members.ts).
 */
export const ownCosmetics = async (
  deps: Pick<RoomWindowDeps, "db" | "companionId" | "catalog">,
): Promise<SceneCosmetic[]> => {
  const [me] = await sceneMembersFor(
    deps.db,
    [{ companionId: deps.companionId, role: "owner", me: true }],
    deps.catalog,
  );
  return me?.cosmetics ? [...me.cosmetics] : [];
};

export const cosmeticsKey = (c: readonly SceneCosmetic[]): string => c.map((x) => `${x.slot}:${x.art}`).join(",");

/**
 * Reads the cosmetics now and every `everyMs`, and reports them only when they changed. `null`
 * from the source (not signed in yet) or a failed read keeps what the pet wears.
 */
export const watchCosmetics = (
  source: () => Promise<SceneCosmetic[] | null>,
  onChange: (c: SceneCosmetic[]) => void,
  opts: { everyMs?: number; every?: (fn: () => void, ms: number) => () => void } = {},
): { refresh: () => Promise<void>; stop: () => void } => {
  let shown = "";
  let stopped = false;
  const refresh = async () => {
    const c = await source().catch(() => null);
    if (stopped || !c) return;
    const key = cosmeticsKey(c);
    if (key === shown) return;
    shown = key;
    onChange(c);
  };
  const every =
    opts.every ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });
  const cancel = every(() => void refresh(), opts.everyMs ?? PET_COSMETICS_REFRESH_MS);
  void refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      cancel();
    },
  };
};
