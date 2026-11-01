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
  it("stops waiting for a session that stays unusable past the grace at startup: no session, no companion, 401/403 (#129)", async () => {
    let t = 0;
    let status: number | null = null;
    const ready = { companionCard: async () => (status ? Promise.reject(new Error(`/x: ${status}`)) : body()) };
    const gone = companionCardFetcher(
      async () => null,
      () => t,
      () => true,
      60_000,
    );
    await expect(gone()).rejects.toThrow("not ready");
    t = 59_999;
    await expect(gone()).rejects.toThrow("not ready");
    t = 60_000;
    expect(await gone()).toBeNull();

    t = 0;
    status = 401;
    const refused = companionCardFetcher(
      async () => ready,
      () => t,
      () => true,
      60_000,
    );
    await expect(refused()).rejects.toThrow("refused");
    t = 60_000;
    expect(await refused()).toBeNull();
    // Back: the custom card returns.
    status = null;
    expect(((await refused()) as SignedCard).assetId).toBe(ASSET);
  });

  it("starts the grace over after a failed lookup, so one late 401 doesn't give up at once", async () => {
    let t = 0;
    let mode: "none" | "offline" | "401" = "none";
    const fetch = companionCardFetcher(
      async () => {
        if (mode === "offline") throw new Error("companion lookup failed");
        return mode === "none" ? null : { companionCard: async () => Promise.reject(new Error("/x: 401")) };
      },
      () => t,
      () => true,
      60_000,
    );
    await expect(fetch()).rejects.toThrow("not ready");
    mode = "offline";
    t = 300_000;
    await expect(fetch()).rejects.toThrow("lookup failed");
    mode = "401";
    await expect(fetch()).rejects.toThrow("refused");
    t = 360_000;
    expect(await fetch()).toBeNull();
  });

  it("keeps waiting on network errors and 5xx, and never gives up once a card has answered (#129)", async () => {
    let t = 0;
    let status: number | null = 503;
    let up = true;
    const fetch = companionCardFetcher(
      async () =>
        up ? { companionCard: async () => (status ? Promise.reject(new Error(`/x: ${status}`)) : body()) } : null,
      () => t,
      () => true,
      60_000,
    );
    await expect(fetch()).rejects.toThrow("503");
    t = 600_000;
    await expect(fetch()).rejects.toThrow("503");
    status = null;
    expect(((await fetch()) as SignedCard).assetId).toBe(ASSET);
    // Mid-session: a late token refresh (401) or a lost session never turns the pet into the roster.
    status = 401;
    t = 700_000;
    await expect(fetch()).rejects.toThrow("refused");
    t = 900_000;
    await expect(fetch()).rejects.toThrow("refused");
    up = false;
    await expect(fetch()).rejects.toThrow("not ready");
  });

  it("reads GET /v1/avatar/companion; distinguishes a restoring account from confirmed sign-out", async () => {
    const card = (await companionCardFetcher(async () => ({ companionCard: async () => body() }))()) as SignedCard;
    expect(card.assetId).toBe(ASSET);
    expect(card.expiresAt).toBe(1_800_000_000_000);
    await expect(companionCardFetcher(async () => null)()).rejects.toThrow("not ready");
    expect(
      await companionCardFetcher(
        async () => null,
        Date.now,
        () => false,
      )(),
    ).toBeNull();
    expect(await companionCardFetcher(async () => ({ companionCard: async () => ({ assetId: null }) }))()).toBeNull();
    // Only the bucket's signed URLs (the webview's img-src allows that host only).
    await expect(
      companionCardFetcher(async () => ({ companionCard: async () => body("https://evil.example") }))(),
    ).rejects.toThrow("unusable");
  });

  it("keeps a custom pet through a temporary loss of the borrowed session and recovers", async () => {
    let available = false;
    let signedIn = true;
    const src = companionCardSource(
      async () => (available ? { companionCard: async () => body() } : null),
      () => signedIn,
    );
    try {
      await src.ready();
      expect(src.getSnapshot()).toBeUndefined();
      available = true;
      await src.refresh();
      const files = src.files();
      expect(files?.key).toBe(`custom:${ASSET}`);
      available = false;
      await src.refresh();
      expect(src.files()).toBe(files);
      expect(src.getSnapshot()?.assetId).toBe(ASSET);
      signedIn = false;
      await src.refresh();
      expect(src.getSnapshot()).toBeNull();
      expect(src.files()).toBeNull();
    } finally {
      src.dispose();
    }
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
