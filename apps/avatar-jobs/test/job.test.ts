import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { processUpload } from "../src/job.js";
import { LIMITS, UploadRejected, validateImage, type CardManifest } from "../src/process.js";
import { MemoryBlobStore, uploadPath } from "../src/storage.js";

/** A 512² drawing: a filled circle on transparency. */
const drawing = (format: "png" | "jpeg" | "webp" = "png", side = 512) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}"><circle cx="${side / 2}" cy="${side / 2}" r="${side / 3}" fill="#e8a04c"/></svg>`,
    ),
  )
    .toFormat(format)
    .toBuffer();

const rejects = async (bytes: Uint8Array, reason: RegExp, declared?: string) => {
  const err = await validateImage(bytes, declared).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(UploadRejected);
  expect((err as UploadRejected).reason).toMatch(reason);
};

describe("validateImage", () => {
  it("accepts PNG, JPEG and WebP by their bytes", async () => {
    for (const f of ["png", "jpeg", "webp"] as const)
      expect((await validateImage(await drawing(f), `image/${f}`)).type).toBe(f);
  });

  it("rejects empty, oversized, tiny and huge images", async () => {
    await rejects(new Uint8Array(), /empty/);
    await rejects(new Uint8Array(LIMITS.maxBytes + 1).fill(0x89), /too large/);
    await rejects(await drawing("png", 64), /small|dimension/);
    const huge = await sharp({ create: { width: 5000, height: 300, channels: 3, background: "#fff" } })
      .png()
      .toBuffer();
    await rejects(huge, /large|dimension/);
  });

  it("rejects executables, archives, scripts and markup, whatever they claim to be", async () => {
    await rejects(Buffer.from("MZ\x90\x00 this program cannot be run in DOS mode"), /not an image/, "image/png");
    await rejects(Buffer.from("\x7fELF\x02\x01\x01"), /not an image/);
    await rejects(Buffer.from("PK\x03\x04zip"), /not an image/);
    await rejects(Buffer.from("#!/bin/sh\nrm -rf /"), /not an image/);
    await rejects(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      /not an image/,
    );
    await rejects(Buffer.from("  <!DOCTYPE html><html>"), /not an image/);
    await rejects(Buffer.from("GIF89a......"), /unsupported/);
  });

  it("rejects a declared type that doesn't match the bytes, and truncated files", async () => {
    await rejects(await drawing("jpeg"), /mismatch|declared/, "image/png");
    const png = await drawing("png");
    await rejects(png.subarray(0, 200), /./);
  });
});

describe("processUpload (Cloud Run job, bucket mocked)", () => {
  it("turns an upload into a card: webp layer, thumbnails and card.json with anchors, owner-scoped", async () => {
    const store = new MemoryBlobStore();
    const path = uploadPath("hub-user-1", "asset_0001");
    // EXIF + an ICC profile + a trailing payload: none of it may survive.
    const tagged = Buffer.concat([
      await sharp(await drawing("jpeg"))
        .withMetadata({ exif: { IFD0: { Artist: "secret-artist", Copyright: "gps-ish" } } })
        .jpeg()
        .toBuffer(),
      Buffer.from("TRAILING-PAYLOAD"),
    ]);
    store.objects.set(path, { bytes: tagged, contentType: "image/jpeg" });
    const r = await processUpload(store, path);
    expect(r.status).toBe("ok");
    const keys = [...store.objects.keys()].filter((k) => k !== path).sort();
    expect(keys).toEqual(
      ["card.json", "layer-neutral.webp", "thumb-128.webp", "thumb-256.webp"].map(
        (f) => `avatars/hub-user-1/asset_0001/${f}`,
      ),
    );
    const card = JSON.parse(
      store.objects.get("avatars/hub-user-1/asset_0001/card.json")!.bytes.toString(),
    ) as CardManifest;
    expect(card).toMatchObject({ v: 1, kind: "card", emotions: { mode: "overlay" } });
    for (const slot of ["head", "face", "neck", "body", "back", "aura", "portal_fx"] as const) {
      const a = card.anchors[slot];
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.x).toBeLessThanOrEqual(1);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeLessThanOrEqual(1);
    }
    // An upload gets a neck too (derived: under the face, above the body, a typical width), drawn in front.
    expect(card.anchors.neck).toMatchObject({ z: 2, w: 0.3 });
    expect(card.anchors.neck.y).toBeGreaterThan(card.anchors.face.y);
    expect(card.anchors.neck.y).toBeLessThan(card.anchors.body.y);
    for (const k of keys.filter((k) => k.endsWith(".webp"))) {
      const bytes = store.objects.get(k)!.bytes;
      const meta = await sharp(bytes).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(bytes.includes("secret-artist")).toBe(false);
      expect(bytes.includes("TRAILING-PAYLOAD")).toBe(false);
    }
  });

  it("a rejected upload writes only rejected.json, under the same owner's prefix", async () => {
    const store = new MemoryBlobStore();
    const path = uploadPath("hub-user-2", "asset_0002");
    store.objects.set(path, { bytes: Buffer.from("MZ\x90\x00"), contentType: "image/png" });
    const r = await processUpload(store, path);
    expect(r).toMatchObject({ status: "rejected", prefix: "avatars/hub-user-2/asset_0002/" });
    expect([...store.objects.keys()].sort()).toEqual([path, "avatars/hub-user-2/asset_0002/rejected.json"].sort());
  });

  it("refuses paths outside uploads/<owner>/<asset>/original (no traversal into another owner)", async () => {
    const store = new MemoryBlobStore();
    for (const p of [
      "uploads/../avatars/x/asset_0001/original",
      "uploads/a/b/../../c/original",
      "avatars/hub-user-1/asset_0001/original",
      "uploads/hub-user-1/asset_0001/card.json",
    ])
      await expect(processUpload(store, p)).rejects.toThrow(/not an upload path/);
    expect(() => uploadPath("../x", "asset_0001")).toThrow();
  });
});
