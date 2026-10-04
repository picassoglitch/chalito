import { describe, expect, it, vi } from "vitest";
import type { SceneCosmetic } from "@chalito/scene";
import { cosmeticsKey, ownCosmetics, watchCosmetics } from "../src/pet/cosmetics.js";
import { catalogLoader } from "../src/room/scene-members.js";

const crown: SceneCosmetic = {
  slot: "head",
  art: "cosmetics/flower_crown.webp",
  card: { width: 0.44, pivot: [0.5, 0.62] },
};
const swirl: SceneCosmetic = {
  slot: "portal_fx",
  art: "cosmetics/portal_swirl.webp",
  card: { width: 1, pivot: [0.5, 0.5] },
};

const directory = (equipped: Record<string, string[]>) => ({
  from: (t: string) => ({
    select: () => ({
      eq: async (_c: string, id: string) => ({
        data:
          t === "companion_directory" && id in equipped
            ? [{ companion_id: id, avatar_thumb: "luna", equipped: equipped[id] }]
            : [],
        error: null,
      }),
    }),
  }),
});

describe("the pet wears what the companion has equipped", () => {
  it("reads its own directory row and places the items from the store catalog (unknown ids dropped)", async () => {
    const catalog = catalogLoader(async () => ({
      items: [{ id: "flower_crown", ...crown }],
    }));
    const db = directory({ chl_me: ["flower_crown", "not_in_catalog"], chl_other: ["flower_crown"] });
    expect(await ownCosmetics({ db: db as never, companionId: "chl_me", catalog })).toEqual([crown]);
    expect(await ownCosmetics({ db: directory({}) as never, companionId: "chl_me", catalog })).toEqual([]);
  });

  it("redraws only when what it wears changes; not signed in or a failed read keeps it as is", async () => {
    const answers: (SceneCosmetic[] | null | Error)[] = [
      [crown],
      [crown],
      null,
      new Error("offline"),
      [crown, swirl],
      [],
    ];
    const source = vi.fn(async () => {
      const a = answers.shift()!;
      if (a instanceof Error) throw a;
      return a;
    });
    const seen: string[] = [];
    let tick: () => void = () => undefined;
    const w = watchCosmetics(source, (c) => seen.push(cosmeticsKey(c)), {
      every: (fn) => ((tick = fn), () => undefined),
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    for (let i = 0; i < 5; i++) await w.refresh();
    expect(seen).toEqual([
      "head:cosmetics/flower_crown.webp",
      "head:cosmetics/flower_crown.webp,portal_fx:cosmetics/portal_swirl.webp",
      "",
    ]);
    expect(typeof tick).toBe("function");
    w.stop();
  });

  it("stops reporting once stopped", async () => {
    let resolve!: (c: SceneCosmetic[]) => void;
    const onChange = vi.fn();
    const w = watchCosmetics(() => new Promise((r) => (resolve = r)), onChange, { every: () => () => undefined });
    w.stop();
    resolve([crown]);
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
  });
});
