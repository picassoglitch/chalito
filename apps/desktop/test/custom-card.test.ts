import { describe, expect, it } from "vitest";
import { cardFilesFrom, type SignedCard } from "@chalito/scene/custom-card";
import { companionCardFetcher, companionCardSource, roomCardsFetcher } from "../src/lib/custom-card.js";
import { sceneMembersFor } from "../src/room/scene-members.js";

const ASSET = "0123456789abcdef0123456789abcdef";
const GCS = `https://storage.googleapis.com/chalito-avatars/avatars/o/${ASSET}`;
const body = (host = GCS) => ({
  assetId: ASSET,
  card: {
    manifest: {
      width: 600,
      height: 800,
      emotions: { mode: "swap", src: { neutral: "layer-neutral.webp" } },
      thumbs: { "128": "thumb-128.webp" },
      anchors: { head: { x: 0.5, y: 0.1, z: 1 } },
    },
    urls: { "layer-neutral.webp": `${host}/layer-neutral.webp?s`, "thumb-128.webp": `${host}/thumb-128.webp?s` },
    expiresAt: 1_800_000_000_000,
  },
});

describe("the desktop's own custom companion card", () => {
  it("reads GET /v1/avatar/companion through the borrowed session; null before sign-in or without one", async () => {
    const card = (await companionCardFetcher(async () => ({ companionCard: async () => body() }))()) as SignedCard;
    expect(card.assetId).toBe(ASSET);
    expect(card.expiresAt).toBe(1_800_000_000_000);
    expect(await companionCardFetcher(async () => null)()).toBeNull();
    expect(await companionCardFetcher(async () => ({ companionCard: async () => ({ assetId: null }) }))()).toBeNull();
    // Only the bucket's signed URLs (the webview's img-src allows that host only).
    await expect(
      companionCardFetcher(async () => ({ companionCard: async () => body("https://evil.example") }))(),
    ).rejects.toThrow("unusable");
  });

  it("the source hands the pet late-bound files for the card", async () => {
    const src = companionCardSource(async () => ({ companionCard: async () => body() }));
    await src.ready();
    const files = src.files()!;
    expect(files.key).toBe(`custom:${ASSET}`);
    expect(files.url("layer-neutral.webp")).toBe(`${GCS}/layer-neutral.webp?s`);
    expect((files.manifest as { anchors: unknown }).anchors).toEqual({ head: { x: 0.5, y: 0.1, z: 1 } });
    src.dispose();
  });

  it("in a room, only this device's own companion wears it; co-members keep their roster card", async () => {
    const db = {
      from: () => ({
        select: () => ({
          eq: async (_c: string, id: string) => ({
            data: [{ companion_id: id, avatar_thumb: id === "chl_me" ? "chalito" : "luna", equipped: [] }],
            error: null,
          }),
        }),
      }),
    };
    const own = cardFilesFrom(`custom:${ASSET}`, body().card.urls, body().card.manifest);
    const out = await sceneMembersFor(
      db,
      [
        { companionId: "chl_me", role: "member", me: true },
        { companionId: "chl_mom", role: "owner", me: false },
      ],
      undefined,
      (m) => (m.me ? own : null),
    );
    expect(out[0]).toMatchObject({ companionId: "chl_me", avatar: "chalito", card: own });
    expect(out[1]).toEqual({ companionId: "chl_mom", avatar: "luna", presence: "online" });
  });

  it("reads a room's co-member cards by companion id (the api signs them for members only)", async () => {
    const asked: string[] = [];
    const cards = await roomCardsFetcher(async (roomId) => {
      asked.push(roomId);
      return {
        cards: [
          { companionId: "chl_mom", ...body() },
          { companionId: "chl_x", ...body("https://evil.example") },
        ],
      };
    }, "room_fam")();
    expect(asked).toEqual(["room_fam"]);
    expect([...cards.keys()]).toEqual(["chl_mom"]);
    await expect(roomCardsFetcher(async () => ({ error: "x" }), "room_fam")()).rejects.toThrow("unusable");
  });
});
