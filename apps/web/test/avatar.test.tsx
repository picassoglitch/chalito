import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import en from "@chalito/ui/messages/en.json";
import { checkPhoto, httpAvatar, newCreationId, parseCreation, type AvatarApi, type Creation } from "@/lib/avatar";
import { myCardSource } from "@/lib/my-card";
import type { CustomCardSource, SignedCard } from "@chalito/scene/custom-card";

const GCS = "https://storage.googleapis.com/b/avatars/o/a";
const CARD = {
  manifest: {
    emotions: {
      mode: "swap",
      src: {
        neutral: "layer-neutral.webp",
        happy: "layer-happy.webp",
        sad: "layer-sad.webp",
        surprised: "layer-surprised.webp",
        tired: "layer-tired.webp",
      },
    },
    thumbs: { "128": "thumb-128.webp" },
  },
  urls: Object.fromEntries(
    ["layer-neutral", "layer-happy", "layer-sad", "layer-surprised", "layer-tired", "thumb-128"].map((f) => [
      `${f}.webp`,
      `${GCS}/${f}.webp?X-Goog-Signature=x`,
    ]),
  ),
};
const DONE = { creationId: "cr_0123456789abcdef", status: "succeeded", free: true, priceTokens: 0, card: CARD };

describe("custom companion client (/v1/avatar)", () => {
  it("checks the photo before uploading: PNG/JPEG/WebP up to 10 MB", () => {
    expect(checkPhoto({ type: "image/jpeg", size: 2_000_000 })).toBe("ok");
    expect(checkPhoto({ type: "image/gif", size: 10 })).toBe("type");
    expect(checkPhoto({ type: "image/svg+xml", size: 10 })).toBe("type");
    expect(checkPhoto({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe("size");
    expect(newCreationId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });

  it("parses a finished card strictly: signed bucket URLs only, every drawing present", () => {
    expect(parseCreation(DONE)?.card?.emotions.happy).toBe("layer-happy.webp");
    expect(
      parseCreation({
        ...DONE,
        card: { ...CARD, urls: { ...CARD.urls, "layer-happy.webp": "https://evil.example/x" } },
      }),
    ).toBeNull();
    const { "layer-sad.webp": _gone, ...missing } = CARD.urls;
    expect(parseCreation({ ...DONE, card: { ...CARD, urls: missing } })).toBeNull();
    expect(parseCreation({ ...DONE, status: "dancing" })).toBeNull();
    expect(
      parseCreation({ creationId: "x", status: "failed", free: false, priceTokens: 5, failure: "refused" }),
    ).toEqual({
      creationId: "x",
      status: "failed",
      free: false,
      priceTokens: 5,
      failure: "refused",
    });
  });

  it("start: the signed PUT on success; no_tokens with its chip; busy; daily limit; retry on 5xx", async () => {
    const answer = (status: number, body: unknown) =>
      httpAvatar(
        "https://api.test",
        async () => "tok",
        (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
      );
    const ok = await answer(201, {
      creationId: "cr_0123456789abcdef",
      status: "awaiting_upload",
      free: true,
      priceTokens: 0,
      upload: {
        url: `${GCS}?X-Goog-Signature=put`,
        headers: { "content-type": "image/jpeg", "x-goog-content-length-range": "0,10485760" },
      },
    }).start("cr_0123456789abcdef", "image/jpeg");
    expect(ok).toMatchObject({
      ok: true,
      upload: { url: expect.stringMatching(/^https:\/\/storage\.googleapis\.com\//) },
    });
    expect(await answer(402, { error: "no_tokens", chips: [{ href: "/creditos" }] }).start("x", "image/png")).toEqual({
      ok: false,
      reason: "no_tokens",
      chipHref: "/creditos",
    });
    expect(await answer(409, { error: "busy" }).start("x", "image/png")).toEqual({ ok: false, reason: "busy" });
    expect(await answer(429, { error: "daily_limit" }).start("x", "image/png")).toEqual({
      ok: false,
      reason: "daily_limit",
    });
    expect(await answer(503, {}).start("x", "image/png")).toEqual({ ok: false, reason: "retry" });
    // An upload target off the bucket is refused.
    expect(
      await answer(201, {
        ...DONE,
        status: "awaiting_upload",
        card: undefined,
        upload: { url: "https://evil.example/u", headers: {} },
      }).start("x", "image/png"),
    ).toEqual({ ok: false, reason: "failed" });
  });

  it("uploads the photo with exactly the signed headers", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const api = httpAvatar("https://api.test", async () => "tok", (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch);
    const headers = { "content-type": "image/jpeg", "x-goog-content-length-range": "0,10485760" };
    expect(await api.upload({ url: `${GCS}?sig`, headers }, new Blob(["x"], { type: "image/jpeg" }))).toBe(true);
    expect(seen[0]).toMatchObject({ url: `${GCS}?sig`, init: { method: "PUT", headers } });
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("reads the companion's custom card with its expiry; only bucket URLs; null without one", async () => {
    const ASSET = "0123456789abcdef0123456789abcdef";
    const manifest = { ...CARD.manifest, width: 600, height: 800, anchors: { head: { x: 0.5, y: 0.1, z: 1 } } };
    const answer = (status: number, body: unknown) =>
      httpAvatar("https://api.test", async () => "tok", (async (url: string) => {
        expect(url).toBe("https://api.test/v1/avatar/companion");
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch);
    const card = (await answer(200, {
      assetId: ASSET,
      card: { manifest, urls: CARD.urls, expiresAt: 1_800_000_000_000 },
    }).companion()) as SignedCard;
    expect(card.assetId).toBe(ASSET);
    expect(card.expiresAt).toBe(1_800_000_000_000);
    expect(card.manifest.anchors?.head?.y).toBe(0.1);
    expect(await answer(200, { assetId: null }).companion()).toBeNull();
    expect(await answer(503, { error: "x" }).companion()).toBe("error");
    expect(
      await answer(200, {
        assetId: ASSET,
        card: { manifest, urls: { ...CARD.urls, "layer-happy.webp": "https://evil.example/x" } },
      }).companion(),
    ).toBe("error");
  });

  it("reads a room's co-member cards (members only on the server); bucket URLs only", async () => {
    const ASSET = "0123456789abcdef0123456789abcdef";
    const manifest = { ...CARD.manifest, width: 600, height: 800 };
    const seen: string[] = [];
    const api = (body: unknown, status = 200) =>
      httpAvatar("https://api.test", async () => "tok", (async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch);
    const cards = await api({
      cards: [
        { companionId: "chl_mom", assetId: ASSET, card: { manifest, urls: CARD.urls, expiresAt: 1 } },
        {
          companionId: "chl_evil",
          assetId: ASSET,
          card: { manifest, urls: { ...CARD.urls, "layer-sad.webp": "https://evil.example/x" } },
        },
      ],
    }).roomCards("room_fam");
    expect(seen).toEqual(["https://api.test/v1/avatar/rooms/room_fam/cards"]);
    expect([...(cards as Map<string, SignedCard>).keys()]).toEqual(["chl_mom"]);
    expect(await api({ error: "x" }, 500).roomCards("room_fam")).toBe("error");
  });

  it("es and en carry the same createCharacter strings", () => {
    const keys = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`)) : [p];
    expect(keys(en.createCharacter).sort()).toEqual(keys(es.createCharacter).sort());
  });
});

// ---- the component ------------------------------------------------------------------------------
const ctx: { avatar: AvatarApi | null; myCard: CustomCardSource | null } = { avatar: null, myCard: null };
vi.mock("@/components/ChalitoProvider", () => ({ useChalito: () => ctx }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
const { CreateCharacter } = await import("@/components/CreateCharacter");

const MINE: SignedCard = {
  assetId: "0123456789abcdef0123456789abcdef",
  manifest: { width: 600, height: 800, emotions: { src: CARD.manifest.emotions.src }, thumbs: CARD.manifest.thumbs },
  urls: CARD.urls,
  expiresAt: Date.now() + 3_600_000,
};
const fakeApi = (o: { free: boolean; startReason?: "no_tokens" }) => {
  const calls: string[] = [];
  let polls = 0;
  let wearing = false;
  const api: AvatarApi = {
    quote: async () => ({ free: o.free, priceTokens: 217_750, dailyLeft: 5, active: null }),
    start: async (id) => {
      calls.push(`start:${id}`);
      if (o.startReason) return { ok: false, reason: o.startReason, chipHref: "/creditos" };
      return {
        ok: true,
        creation: { creationId: id, status: "awaiting_upload", free: o.free, priceTokens: o.free ? 0 : 217_750 },
        upload: { url: `${GCS}?sig`, headers: {} },
      };
    },
    upload: async () => (calls.push("upload"), true),
    uploaded: async (id) => (
      calls.push("uploaded"),
      { creationId: id, status: "queued", free: o.free, priceTokens: 0 }
    ),
    status: async (id) => {
      calls.push("status");
      return ++polls < 2
        ? { creationId: id, status: "generating", free: o.free, priceTokens: 0 }
        : (parseCreation({ ...DONE, creationId: id }) as Creation);
    },
    use: async (id) => (calls.push(`use:${id}`), (wearing = id !== null), "ok"),
    companion: async () => (calls.push("companion"), wearing ? MINE : null),
    roomCards: async () => new Map(),
  };
  return { api, calls };
};

const renderIt = () =>
  render(
    <NextIntlClientProvider locale="es" messages={es}>
      <CreateCharacter />
    </NextIntlClientProvider>,
  );

describe("Crea tu personaje", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows 'Gratis la primera vez', then the price in tokens", async () => {
    ctx.avatar = fakeApi({ free: true }).api;
    renderIt();
    expect(await screen.findByText("Gratis la primera vez")).toBeTruthy();
    cleanup();
    ctx.avatar = fakeApi({ free: false }).api;
    renderIt();
    expect((await screen.findByTestId("create-character-price")).textContent).toMatch(/217.750 tokens/);
  });

  it("refuses a non-photo before uploading anything", async () => {
    const { api, calls } = fakeApi({ free: true });
    ctx.avatar = api;
    renderIt();
    const input = await screen.findByTestId("create-character-file");
    fireEvent.change(input, { target: { files: [new File(["<svg/>"], "x.svg", { type: "image/svg+xml" })] } });
    expect(screen.getByTestId("create-character-note").textContent).toContain("PNG, JPEG o WebP");
    expect((screen.getByTestId("create-character-go") as HTMLButtonElement).disabled).toBe(true);
    expect(calls).toEqual([]);
  });

  it("photo → preview → upload → progress → the five drawings → set as companion", async () => {
    const { api, calls } = fakeApi({ free: true });
    ctx.avatar = api;
    ctx.myCard = myCardSource(api);
    renderIt();
    const input = await screen.findByTestId("create-character-file");
    fireEvent.change(input, { target: { files: [new File(["jpeg"], "me.jpg", { type: "image/jpeg" })] } });
    expect((await screen.findByTestId("create-character-preview")).getAttribute("src")).toBe("blob:preview");
    expect(screen.queryByTestId("create-character-current")).toBeNull();
    fireEvent.click(screen.getByTestId("create-character-go"));
    expect((await screen.findByTestId("create-character-status")).textContent).toMatch(/fila|Dibujando/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    const result = await screen.findByTestId("create-character-result");
    expect(result.querySelectorAll("img")).toHaveLength(5);
    fireEvent.click(screen.getByTestId("create-character-use"));
    await waitFor(() => expect(screen.getByTestId("create-character-used")).toBeTruthy());
    const id = calls.find((c) => c.startsWith("start:"))!.slice("start:".length);
    expect(calls.filter((c) => !c.startsWith("status") && c !== "companion")).toEqual([
      `start:${id}`,
      "upload",
      "uploaded",
      `use:${id}`,
    ]);
    // "Use" re-reads the companion: it now wears the new card (what the room, store and pet draw).
    const current = await screen.findByTestId("create-character-current");
    expect(current.querySelector("img")!.getAttribute("src")).toBe(CARD.urls["thumb-128.webp"]);
    ctx.myCard.dispose();
    ctx.myCard = null;
  });

  it("not enough tokens: an inline chip to /creditos, nothing uploaded", async () => {
    const { api, calls } = fakeApi({ free: false, startReason: "no_tokens" });
    ctx.avatar = api;
    renderIt();
    fireEvent.change(await screen.findByTestId("create-character-file"), {
      target: { files: [new File(["jpeg"], "me.jpg", { type: "image/jpeg" })] },
    });
    fireEvent.click(screen.getByTestId("create-character-go"));
    const note = await screen.findByTestId("create-character-note");
    expect(note.textContent).toContain("No te alcanzan los tokens");
    expect(note.querySelector("a")?.getAttribute("href")).toBe("/creditos");
    expect(calls).not.toContain("upload");
  });
});
