import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { AVATAR_EMOTIONS, imageCostMicros } from "@chalito/billing";
import { loadModels, loadPrices } from "@chalito/config";
import { HubUsageEvent } from "@chalito/protocol";
import { processCreation, ATTEMPTS } from "../src/creation.js";
import { MemoryCreationStore, STALE_CLAIM_MS } from "../src/creations.js";
import { geminiImageModel, type ImageModel, type ImageResult, type Part } from "../src/gemini.js";
import type { CardManifest } from "../src/process.js";
import { MemoryBlobStore, uploadPath } from "../src/storage.js";
import { EMOTIONS, NO_PERSON, STYLE, photoPrompt } from "../src/style.js";

const prices = loadPrices();
const modelRef = loadModels().images.avatar;
const NOW = 1_790_000_000_000;
const RID = "11111111-1111-4111-8111-111111111111";
const OWNER = "hub-user-1";
const ASSET = "0123456789abcdef0123456789abcdef";
const PATH = uploadPath(OWNER, ASSET);
const PREFIX = `avatars/${OWNER}/${ASSET}/`;
const perImage = (n: number) => imageCostMicros(prices, modelRef.provider, modelRef.model, n);

/** A chibi-ish drawing on flat magenta, like the model returns. */
const drawing = (fill: string) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#ff00ff"/><circle cx="256" cy="200" r="110" fill="${fill}"/><rect x="186" y="290" width="140" height="180" rx="40" fill="${fill}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

/** A "photo": a JPEG with EXIF that must never reach the model. */
const photo = async () =>
  sharp({ create: { width: 800, height: 1000, channels: 3, background: "#7a8fa6" } })
    .withMetadata({ exif: { IFD0: { Artist: "secret-artist", Copyright: "gps-ish" } } })
    .jpeg()
    .toBuffer();

/** The model, scripted per call (default: a drawing). */
class FakeModel implements ImageModel {
  readonly calls: Part[][] = [];
  constructor(private readonly script: (n: number) => ImageResult | Promise<ImageResult> | null = () => null) {}
  async generate(parts: Part[]): Promise<ImageResult> {
    this.calls.push(parts);
    const scripted = await this.script(this.calls.length);
    return scripted ?? { ok: true, bytes: await drawing("#e8a04c"), mime: "image/png" };
  }
}

const setup = async (o: { free?: boolean; model?: FakeModel; upload?: Buffer | null; contentType?: string } = {}) => {
  const store = new MemoryBlobStore();
  if (o.upload !== null)
    store.objects.set(PATH, { bytes: o.upload ?? (await photo()), contentType: o.contentType ?? "image/jpeg" });
  const creations = new MemoryCreationStore();
  const free = o.free ?? false;
  creations.add(
    { creationId: "cr_0123456789abcdef", owner: OWNER, assetId: ASSET, free, reservationId: free ? undefined : RID },
    NOW,
  );
  const model = o.model ?? new FakeModel();
  const deps = { store, creations, model, modelRef, prices, now: () => NOW };
  return { store, creations, model, deps, run: () => processCreation(deps, PATH) };
};

const outputs = (store: MemoryBlobStore) => [...store.objects.keys()].filter((k) => k.startsWith(PREFIX)).sort();

describe("the style is the roster's", () => {
  it("the same four emotions as the roster (and the billing's image count)", () => {
    expect(Object.keys(EMOTIONS).sort()).toEqual([...AVATAR_EMOTIONS].sort());
  });

  it("the photo prompt asks for a stylized chibi in the roster STYLE, never photorealistic, and allows a refusal", () => {
    const p = photoPrompt();
    expect(p).toContain(STYLE);
    expect(p).toMatch(/never photorealistic/);
    expect(p).toMatch(/chibi/);
    expect(p).toContain(NO_PERSON);
  });
});

describe("processCreation (model and bucket mocked)", () => {
  it("a paid success: five drawings → a swap card, the real cost billed once, the photo deleted", async () => {
    const { run, store, creations, model } = await setup();
    const r = await run();
    expect(r).toMatchObject({ status: "succeeded", images: 5, costMicros: perImage(5) });
    expect(model.calls).toHaveLength(5);
    expect(store.objects.has(PATH)).toBe(false);
    expect(outputs(store)).toEqual(
      [
        "card.json",
        "layer-happy.webp",
        "layer-neutral.webp",
        "layer-sad.webp",
        "layer-surprised.webp",
        "layer-tired.webp",
        "thumb-128.webp",
        "thumb-256.webp",
      ].map((f) => PREFIX + f),
    );
    const card = JSON.parse(store.objects.get(`${PREFIX}card.json`)!.bytes.toString()) as CardManifest;
    expect(card.emotions.mode).toBe("swap");
    expect(Object.keys(card.emotions.src).sort()).toEqual(["happy", "neutral", "sad", "surprised", "tired"]);
    // The magenta background is keyed out: the layer's corner is transparent.
    const { data } = await sharp(store.objects.get(`${PREFIX}layer-neutral.webp`)!.bytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(creations.rows.get("cr_0123456789abcdef")).toMatchObject({ status: "succeeded", images: 5 });
    expect(creations.outbox).toHaveLength(1);
    expect(HubUsageEvent.parse(creations.outbox[0])).toMatchObject({
      source_id: "avatar:cr_0123456789abcdef",
      kind: "image.generations",
      external_user_id: OWNER,
      amount: 5,
      cost_usd_micros: perImage(5),
      reservation_id: RID,
    });
  });

  it("sends a re-encoded photo (no EXIF) with the style prompt, then edits of the neutral drawing", async () => {
    const { run, model } = await setup();
    await run();
    const [first, ...edits] = model.calls;
    expect((first![0] as { text: string }).text).toBe(photoPrompt());
    const sent = Buffer.from((first![1] as { inlineData: { data: string } }).inlineData.data, "base64");
    expect(sent.includes("secret-artist")).toBe(false);
    expect((await sharp(sent).metadata()).exif).toBeUndefined();
    const neutral = (await drawing("#e8a04c")).toString("base64");
    for (const e of edits) {
      expect((e[0] as { text: string }).text).toMatch(/This exact same character/);
      expect((e[1] as { inlineData: { data: string } }).inlineData.data).toBe(neutral);
    }
  });

  it("a free success records the cost internally but bills nothing", async () => {
    const { run, creations } = await setup({ free: true });
    expect(await run()).toMatchObject({ status: "succeeded", images: 5 });
    expect(creations.rows.get("cr_0123456789abcdef")).toMatchObject({ costMicros: perImage(5) });
    expect(creations.outbox).toHaveLength(0);
  });

  it("a refusal of the photo: failed, nothing billed or written, the photo deleted", async () => {
    const model = new FakeModel(() => ({
      ok: false,
      kind: "refused",
      retryable: false,
      detail: "finish: IMAGE_SAFETY",
    }));
    const { run, store, creations } = await setup({ model });
    expect(await run()).toEqual({ status: "failed", failure: "refused", images: 0, costMicros: 0 });
    expect(model.calls).toHaveLength(1);
    expect(store.objects.size).toBe(0);
    expect(creations.outbox).toHaveLength(0);
    expect(creations.rows.get("cr_0123456789abcdef")).toMatchObject({ status: "failed", failure: "refused" });
  });

  it("a refusal midway: the images made are recorded as cost, never billed", async () => {
    const model = new FakeModel((n) =>
      n === 4 ? { ok: false, kind: "refused", retryable: false, detail: "x" } : null,
    );
    const { run, store, creations } = await setup({ model });
    expect(await run()).toEqual({ status: "failed", failure: "refused", images: 3, costMicros: perImage(3) });
    expect(outputs(store)).toEqual([]);
    expect(creations.outbox).toHaveLength(0);
  });

  it("provider errors are retried; one that keeps failing fails the creation (not billed)", async () => {
    const flaky = new FakeModel((n) =>
      n === 1 ? { ok: false, kind: "provider", retryable: true, detail: "http 503" } : null,
    );
    expect(await (await setup({ model: flaky })).run()).toMatchObject({ status: "succeeded", images: 5 });
    expect(flaky.calls).toHaveLength(6);

    const down = new FakeModel(() => ({ ok: false, kind: "provider", retryable: true, detail: "http 503" }));
    const s = await setup({ model: down });
    expect(await s.run()).toMatchObject({ status: "failed", failure: "provider", images: 0 });
    expect(down.calls).toHaveLength(ATTEMPTS);
    expect(s.store.objects.has(PATH)).toBe(false);
    expect(s.creations.outbox).toHaveLength(0);
  });

  it("only photos: a non-image is rejected before any model call, and deleted", async () => {
    const model = new FakeModel();
    const { run, store } = await setup({
      model,
      upload: Buffer.from("MZ\x90\x00 not a photo"),
      contentType: "image/png",
    });
    expect(await run()).toMatchObject({ status: "failed", failure: "rejected" });
    expect(model.calls).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });

  it("an upload with no creation waiting for it is deleted, untouched", async () => {
    const { deps, store, model } = await setup();
    deps.creations.rows.clear();
    expect(await processCreation(deps, PATH)).toEqual({ status: "skipped", reason: "no_creation" });
    expect(store.objects.has(PATH)).toBe(false);
    expect(model.calls).toHaveLength(0);
  });

  it("a creation another execution is generating is left alone (its photo too); a stale claim is taken over", async () => {
    const { deps, store, creations } = await setup();
    Object.assign(creations.rows.get("cr_0123456789abcdef")!, { status: "generating", claimedAt: NOW - 60_000 });
    expect(await processCreation(deps, PATH)).toEqual({ status: "skipped", reason: "busy" });
    expect(store.objects.has(PATH)).toBe(true);
    creations.rows.get("cr_0123456789abcdef")!.claimedAt = NOW - STALE_CLAIM_MS - 1;
    expect(await processCreation(deps, PATH)).toMatchObject({ status: "succeeded" });
  });

  it("a creation that timed out meanwhile is not billed and leaves no card", async () => {
    const { deps, store, creations } = await setup();
    const model = new FakeModel((n) => {
      if (n === 5) creations.rows.get("cr_0123456789abcdef")!.status = "failed";
      return null;
    });
    expect(await processCreation({ ...deps, model }, PATH)).toEqual({ status: "skipped", reason: "lost" });
    expect(outputs(store)).toEqual([]);
    expect(store.objects.has(PATH)).toBe(false);
    expect(creations.outbox).toHaveLength(0);
  });

  it("an unexpected error still deletes the photo and records a failure", async () => {
    const { deps, store, creations } = await setup();
    const broken = {
      ...deps.store,
      write: async () => Promise.reject(new Error("bucket down")),
    } as unknown as MemoryBlobStore;
    Object.setPrototypeOf(broken, MemoryBlobStore.prototype);
    broken.objects.set(PATH, store.objects.get(PATH)!);
    await expect(processCreation({ ...deps, store: broken }, PATH)).rejects.toThrow(/bucket down/);
    expect(broken.objects.has(PATH)).toBe(false);
    expect(creations.rows.get("cr_0123456789abcdef")).toMatchObject({ status: "failed", failure: "provider" });
    expect(creations.outbox).toHaveLength(0);
  });
});

describe("geminiImageModel (fetch mocked)", () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const gen = (f: typeof fetch) =>
    geminiImageModel({ apiKey: "k", model: modelRef.model, fetch: f }).generate([{ text: "x" }]);

  it("returns the image part", async () => {
    const data = (await drawing("#123456")).toString("base64");
    const r = await gen(
      respond(200, { candidates: [{ content: { parts: [{ inlineData: { data, mimeType: "image/png" } }] } }] }),
    );
    expect(r).toMatchObject({ ok: true, mime: "image/png" });
  });

  it("safety blocks and a words-only answer are refusals (not retried)", async () => {
    expect(await gen(respond(200, { promptFeedback: { blockReason: "SAFETY" } }))).toMatchObject({
      ok: false,
      kind: "refused",
    });
    expect(await gen(respond(200, { candidates: [{ finishReason: "IMAGE_SAFETY" }] }))).toMatchObject({
      ok: false,
      kind: "refused",
    });
    expect(
      await gen(respond(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: NO_PERSON }] } }] })),
    ).toMatchObject({ ok: false, kind: "refused", retryable: false });
  });

  it("429/5xx and network errors are retryable; other HTTP errors aren't", async () => {
    expect(await gen(respond(429, {}))).toMatchObject({ ok: false, kind: "provider", retryable: true });
    expect(await gen(respond(500, {}))).toMatchObject({ ok: false, kind: "provider", retryable: true });
    expect(await gen(respond(400, {}))).toMatchObject({ ok: false, kind: "provider", retryable: false });
    const offline = (async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(await gen(offline)).toMatchObject({ ok: false, kind: "provider", retryable: true });
  });

  it("sends the key as a header (never in the URL) and asks for an image", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await geminiImageModel({ apiKey: "secret-key-123", model: modelRef.model, fetch: spy }).generate([{ text: "x" }]);
    expect(seen!.url).not.toContain("secret-key-123");
    expect((seen!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key-123");
    expect(JSON.parse(seen!.init.body as string).generationConfig.responseModalities).toContain("IMAGE");
  });
});
