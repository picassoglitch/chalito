import { describe, expect, it } from "vitest";
import {
  CustomCardSource,
  RoomScene,
  cardFilesFrom,
  loadCardAssets,
  SignedCardsSource,
  parseRoomCards,
  parseSignedCard,
  signedThumb,
  type CardFiles,
  type SignedCard,
} from "../src/index.js";
import { CARD, fakeTexture, sceneOpts } from "./fakes.js";

const ASSET = "0123456789abcdef0123456789abcdef";
const T0 = 1_760_000_000_000;
const SIGNED = (f: string, v = 1) => `https://storage.googleapis.com/b/avatars/o/${ASSET}/${f}?v=${v}`;
const MANIFEST = {
  ...CARD,
  emotions: { mode: "swap", src: CARD.emotions.src },
  thumbs: { "128": "thumb-128.webp", "256": "thumb-256.webp" },
  anchors: { head: { x: 0.5, y: 0.1, z: 1 }, face: { x: 0.5, y: 0.32, z: 2 } },
};
const FILES = [...Object.values(MANIFEST.emotions.src), ...Object.values(MANIFEST.thumbs)];
const body = (v = 1, expiresAt: number | null = T0 + 3_600_000) => ({
  assetId: ASSET,
  card: {
    manifest: MANIFEST,
    urls: Object.fromEntries(FILES.map((f) => [f, SIGNED(f, v)])),
    ...(expiresAt === null ? {} : { expiresAt }),
  },
});

describe("loadCardAssets with a card's own files", () => {
  it("loads each drawing from its own URL, with the given card.json, and cosmetics from the roster", async () => {
    const urls: string[] = [];
    const json: string[] = [];
    const files = cardFilesFrom(`custom:${ASSET}`, body().card.urls, MANIFEST);
    const assets = await loadCardAssets(
      "/roster/",
      files,
      [{ slot: "head", art: "cosmetics/flower_crown.webp", card: { width: 0.44, pivot: [0.5, 0.62] } }],
      { fetchJson: async (u) => (json.push(u), CARD), loadTexture: async (u) => (urls.push(u), fakeTexture(u)) },
    );
    expect(json).toEqual([]); // the manifest came with the card
    expect(urls).toContain(SIGNED("h.webp"));
    expect(urls).toContain("/roster/cosmetics/flower_crown.webp");
    expect(Object.keys(assets.drawings)).toEqual(["neutral", "happy", "sad", "surprised", "tired"]);
    // Placed by the card's own anchors.
    expect(assets.items).toHaveLength(1);
    expect(assets.spec.width).toBe(CARD.width);
  });

  it("fetches card.json from its URL when it isn't given", async () => {
    const json: string[] = [];
    await loadCardAssets(
      "/roster/",
      cardFilesFrom("k", { ...body().card.urls, "card.json": "https://x/card.json" }),
      [],
      {
        fetchJson: async (u) => (json.push(u), CARD),
        loadTexture: async (u) => fakeTexture(u),
      },
    );
    expect(json).toEqual(["https://x/card.json"]);
  });

  it("a failed file refreshes the URLs once (shared) and retries with the fresh ones", async () => {
    let v = 1;
    let refreshes = 0;
    const files: CardFiles = {
      key: "k",
      manifest: MANIFEST,
      url: (f) => SIGNED(f, v),
      refresh: async () => {
        refreshes++;
        v = 2;
      },
    };
    const urls: string[] = [];
    const assets = await loadCardAssets("/roster/", files, [], {
      loadTexture: async (u) => {
        urls.push(u);
        if (u.endsWith("v=1")) throw new Error("403 expired");
        return fakeTexture(u);
      },
    });
    expect(refreshes).toBe(1);
    expect(assets.drawings.happy!.name).toBe(SIGNED("h.webp", 2));
  });

  it("a file that still fails after the refresh fails the load; roster ids still validate", async () => {
    const files: CardFiles = { key: "k", manifest: MANIFEST, url: (f) => SIGNED(f), refresh: async () => undefined };
    await expect(
      loadCardAssets("/roster/", files, [], {
        loadTexture: async () => {
          throw new Error("gone");
        },
      }),
    ).rejects.toThrow("gone");
    await expect(loadCardAssets("/roster/", cardFilesFrom("k", {}, MANIFEST))).rejects.toThrow("card file missing");
    await expect(loadCardAssets("/roster/", "../etc")).rejects.toThrow("bad avatar id");
  });
});

describe("RoomScene with the viewer's custom card", () => {
  const A = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
  it("draws the member's own files, keyed by the card (a URL refresh doesn't reload it)", async () => {
    const urls: string[] = [];
    const scene = new RoomScene(sceneOpts({ loadTexture: async (u) => (urls.push(u), fakeTexture(u)) }));
    let v = 1;
    const files: CardFiles = { key: `custom:${ASSET}`, manifest: MANIFEST, url: (f) => SIGNED(f, v) };
    scene.setMembers([{ companionId: A, avatar: "luna", card: files }]);
    await scene.ready();
    expect(urls.filter((u) => u.startsWith("https://storage"))).toHaveLength(5);
    expect(urls.some((u) => u.includes("/roster/assets/luna/"))).toBe(false);
    v = 2;
    scene.setMembers([{ companionId: A, avatar: "luna", card: { ...files } }]);
    await scene.ready();
    expect(urls).toHaveLength(5);
    // Back to the roster avatar: reloaded from the roster.
    scene.setMembers([{ companionId: A, avatar: "luna" }]);
    await scene.ready();
    expect(urls).toContain("/roster/assets/luna/n.webp");
  });

  it("falls back to the roster avatar when the custom card won't load", async () => {
    const urls: string[] = [];
    const scene = new RoomScene(
      sceneOpts({
        loadTexture: async (u) => {
          urls.push(u);
          if (u.startsWith("https://")) throw new Error("blocked");
          return fakeTexture(u);
        },
      }),
    );
    scene.setMembers([{ companionId: A, avatar: "luna", card: cardFilesFrom("k", body().card.urls, MANIFEST) }]);
    await scene.ready();
    expect(urls).toContain("/roster/assets/luna/n.webp");
  });
});

describe("parseSignedCard", () => {
  it("accepts the api's card, null for no custom card, and rejects anything off", () => {
    const c = parseSignedCard(body(), { now: T0 }) as SignedCard;
    expect(c.assetId).toBe(ASSET);
    expect(c.expiresAt).toBe(T0 + 3_600_000);
    expect(c.manifest.anchors?.head).toEqual({ x: 0.5, y: 0.1, z: 1 });
    expect(signedThumb(c, 128)).toBe(SIGNED("thumb-128.webp"));
    expect(signedThumb(c, 200)).toBe(SIGNED("thumb-256.webp"));
    expect(parseSignedCard({ assetId: null }, { now: T0 })).toBeNull();
    // An older api without expiresAt: assume less than it signs.
    expect((parseSignedCard(body(1, null), { now: T0 }) as SignedCard).expiresAt).toBe(T0 + 30 * 60_000);
    const bad = (b: unknown, isUrl?: (u: string) => boolean) => parseSignedCard(b, { now: T0, isUrl });
    expect(bad(null)).toBe("invalid");
    expect(bad({ ...body(), assetId: "../x" })).toBe("invalid");
    expect(bad(body(), (u) => u.startsWith("https://evil"))).toBe("invalid");
    const missing = body();
    delete (missing.card.urls as Record<string, string>)["h.webp"];
    expect(bad(missing)).toBe("invalid");
    expect(bad({ ...body(), card: { ...body().card, manifest: { ...MANIFEST, width: "x" } } })).toBe("invalid");
  });
});

describe("CustomCardSource", () => {
  const timers = () => {
    const pending: { fn: () => void; ms: number; id: number }[] = [];
    let id = 0;
    return {
      pending,
      timers: {
        set: (fn: () => void, ms: number) => (pending.push({ fn, ms, id: ++id }), id),
        clear: (h: unknown) => {
          const i = pending.findIndex((p) => p.id === h);
          if (i >= 0) pending.splice(i, 1);
        },
      },
      fire: () => pending.shift()!.fn(),
    };
  };

  it("fetches on first subscribe, refreshes a margin before expiry, keeps the files stable", async () => {
    let v = 0;
    const t = timers();
    const src = new CustomCardSource({
      fetch: async () => parseSignedCard(body(++v), { now: T0 }) as SignedCard,
      now: () => T0,
      timers: t.timers,
    });
    expect(src.getSnapshot()).toBeUndefined();
    let changes = 0;
    src.subscribe(() => changes++);
    await src.ready();
    expect(src.getSnapshot()?.assetId).toBe(ASSET);
    expect(t.pending.map((p) => p.ms)).toEqual([3_600_000 - 5 * 60_000]);
    const files = src.files()!;
    expect(files.key).toBe(`custom:${ASSET}`);
    expect(files.url("h.webp")).toBe(SIGNED("h.webp", 1));
    t.fire();
    await src.ready();
    expect(src.files()).toBe(files); // same card: hosts don't reload it
    expect(files.url("h.webp")).toBe(SIGNED("h.webp", 2)); // but the URLs are fresh
    expect(changes).toBe(2);
    expect(t.pending).toHaveLength(1);
    src.dispose();
    expect(t.pending).toHaveLength(0);
  });

  it("shares concurrent refreshes; a failure keeps the card and retries; null means the roster avatar", async () => {
    const t = timers();
    let calls = 0;
    let mode: "ok" | "down" | "none" = "ok";
    const src = new CustomCardSource({
      fetch: async () => {
        calls++;
        if (mode === "down") throw new Error("503");
        return mode === "none" ? null : (parseSignedCard(body(), { now: T0 }) as SignedCard);
      },
      now: () => T0,
      timers: t.timers,
    });
    await Promise.all([src.refresh(), src.refresh()]);
    expect(calls).toBe(1);
    mode = "down";
    await src.refresh();
    expect(src.getSnapshot()?.assetId).toBe(ASSET);
    expect(t.pending.map((p) => p.ms)).toEqual([60_000]);
    mode = "none";
    t.fire();
    await src.ready();
    expect(src.getSnapshot()).toBeNull();
    expect(src.files()).toBeNull();
    expect(t.pending).toHaveLength(0);
  });

  it("never schedules past what a timer can hold (a far expiry would otherwise fire at once)", async () => {
    const t = timers();
    const far = { ...(parseSignedCard(body(), { now: T0 }) as SignedCard), expiresAt: T0 + 400 * 86_400_000 };
    const src = new CustomCardSource({ fetch: async () => far, now: () => T0, timers: t.timers });
    await src.refresh();
    expect(t.pending.map((p) => p.ms)).toEqual([2 ** 31 - 1]);
    src.dispose();
  });

  it("a first fetch that fails answers null (draw the roster avatar) and retries", async () => {
    const t = timers();
    const src = new CustomCardSource({
      fetch: async () => {
        throw new Error("offline");
      },
      timers: t.timers,
    });
    expect(await src.ready()).toBeNull();
    expect(t.pending).toHaveLength(1);
  });
});

describe("room members' cards (SignedCardsSource)", () => {
  it("parses the room's cards, leaving out unusable entries", () => {
    const one = body();
    const cards = parseRoomCards(
      {
        cards: [
          { companionId: "chl_mom", ...one },
          { companionId: "chl_bad", assetId: ASSET, card: { ...one.card, urls: {} } },
          { companionId: "../x", ...one },
        ],
      },
      { now: T0 },
    ) as Map<string, SignedCard>;
    expect([...cards.keys()]).toEqual(["chl_mom"]);
    expect(parseRoomCards({ nope: 1 }, { now: T0 })).toBe("invalid");
  });

  it("gives each member stable late-bound files and refreshes before the soonest expiry", async () => {
    let v = 0;
    const pending: number[] = [];
    const card = (exp: number) => ({ ...(parseSignedCard(body(v), { now: T0 }) as SignedCard), expiresAt: exp });
    const src = new SignedCardsSource({
      fetch: async () => (
        v++,
        new Map([
          ["chl_mom", card(T0 + 900_000)],
          ["chl_kid", card(T0 + 3_600_000)],
        ])
      ),
      now: () => T0,
      timers: { set: (_fn, ms) => (pending.push(ms), 1), clear: () => undefined },
    });
    await src.ready();
    const mom = src.files("chl_mom")!;
    expect(mom.key).toBe(`custom:${ASSET}`);
    expect(src.files("chl_dad")).toBeNull();
    expect(pending).toEqual([900_000 - 5 * 60_000]);
    await src.refresh();
    expect(src.files("chl_mom")).toBe(mom);
    expect(mom.url("h.webp")).toBe(SIGNED("h.webp", 2)); // fresh URLs, same files
    src.dispose();
  });
});
