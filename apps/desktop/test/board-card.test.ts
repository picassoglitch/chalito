// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CARD_FRAMES, convertCard, frameFiles, pyRound, toRgb565, type CardManifest } from "../src/lib/board/card.js";
import { alphaComposite, blank, fillEllipse, resizeLanczos, type Rgba } from "../src/lib/board/pillow.js";
import { customBoardCard } from "../src/lib/board/pet-card.js";
import { backdrop, dayPartAt } from "../src/lib/board/backdrop.js";

const ROOT = resolve(__dirname, "../../..");
const CHALITO = join(ROOT, "packages/roster/assets/chalito");
const MAKE_SPRITES = process.env.BOARD_MAKE_SPRITES ?? join(ROOT, "firmware/esp32-c6-lcd/tools/make_sprites.py");

// libvips and Pillow both decode with libwebp: the same RGBA, checked in the first test.
const decode = async (file: string): Promise<Rgba> => {
  const { data, info } = await sharp(join(CHALITO, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
};
const manifest = JSON.parse(readFileSync(join(CHALITO, "card.json"), "utf8")) as CardManifest;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** make_sprites.py's output for the roster chalito (Pillow 12.1.1, libwebp 1.5), 2026-10-30. */
const GOLDEN = {
  geometry: { x: 4, y: 13, w: 164, h: 295 },
  key: "62860f69e70b59a880e020fe620ee883f47e914f3baafb8ffa38d76974dcf39d",
  frames: {
    background: "ec828d96eeee8ab61cc8daf1272f2b159cf8e35afdb47fc162dfb1916f96e483",
    neutral: "3d9be3f43f6bc793a5613e26f247e1e91fa5b0485982bd98b84b0d3f9a06936f",
    blink: "ef3360e1d8a84b011fb194160dee51694905d0d4dcead0aa453702a038bb4b39",
    happy: "31ff8204fe2857b7f52c84d7fa390f6f94efe361394f8af15534de42333bdbed",
    surprised: "8182d1403115404542e5c93ad87c3bfba54307dc8596ddfc4f1d7c13f5266030",
    tired: "e2734fe42eecc62ea4e786263600c0861d0f7a8f76a653ebbd741cb45b01f8e7",
  },
};

const hasPillow = (() => {
  try {
    execFileSync("python3", ["-c", "import PIL"], { stdio: "ignore" });
    return existsSync(MAKE_SPRITES);
  } catch {
    return false;
  }
})();

describe("card → LCD frames", () => {
  it("matches make_sprites.py byte for byte on the roster chalito", async () => {
    const card = await convertCard(manifest, decode);
    expect({ x: card.x, y: card.y, w: card.w, h: card.h }).toEqual(GOLDEN.geometry);
    expect(Object.fromEntries(CARD_FRAMES.map((f) => [f, sha(card.frames[f])]))).toEqual(GOLDEN.frames);
    expect(card.key).toBe(GOLDEN.key);
  }, 30_000);

  it.runIf(hasPillow)(
    "matches a live run of make_sprites.py",
    async () => {
      const out = mkdtempSync(join(tmpdir(), "board-card-"));
      execFileSync("python3", [MAKE_SPRITES, CHALITO, "--out", out]);
      const card = await convertCard(manifest, decode);
      for (const f of CARD_FRAMES)
        expect(Buffer.from(card.frames[f]).equals(readFileSync(join(out, `${f}.bin`)))).toBe(true);
      const meta = JSON.parse(readFileSync(join(out, "card.json"), "utf8")) as Record<string, unknown>;
      expect(meta).toEqual({ key: card.key, x: card.x, y: card.y, w: card.w, h: card.h, frames: [...CARD_FRAMES] });
    },
    30_000,
  );

  it("falls back to neutral for missing emotions and blinks only with rig lids", () => {
    const files = frameFiles({ width: 10, height: 10, emotions: { src: { neutral: "n.webp", happy: "h.webp" } } });
    expect(files).toEqual({
      neutral: ["n.webp"],
      blink: ["n.webp"],
      happy: ["h.webp"],
      surprised: ["n.webp"],
      tired: ["n.webp"],
    });
    expect(frameFiles(manifest).blink).toEqual(["layer-neutral.webp", "rig-lids.webp"]);
  });

  it("keys transparent pixels and never lets a blended pixel collide with the key", () => {
    // (8, 4, 8) on full alpha is exactly 0x0821 in RGB565.
    const im: Rgba = { width: 3, height: 1, data: new Uint8Array([0, 0, 0, 19, 8, 4, 8, 255, 255, 255, 255, 255]) };
    expect([...toRgb565(im, true)]).toEqual([0x08, 0x21, 0x08, 0x22, 0xff, 0xff]);
  });

  it("rounds half to even like Python", () => {
    expect([0.5, 1.5, 2.5, 63.75, 3.5].map(pyRound)).toEqual([0, 2, 2, 64, 4]);
  });

  it("is deterministic on small synthetic images (resize, composite, ellipse)", () => {
    const im = blank(7, 5);
    for (let i = 0; i < im.data.length; i++) im.data[i] = (i * 37) % 256;
    const out = resizeLanczos(alphaComposite(blank(7, 5), im), 3, 2);
    expect(out.width * out.height).toBe(6);
    expect(resizeLanczos(alphaComposite(blank(7, 5), im), 3, 2).data).toEqual(out.data);
    const e = blank(9, 9);
    fillEllipse(e, [1.7, 1.2, 7.9, 7.4], [1, 2, 3, 4]);
    expect(e.data[(4 * 9 + 4) * 4 + 3]).toBe(4);
    expect(e.data[3]).toBe(0);
  });

  it("draws the hill scene behind the card and blends the edges onto it, not onto the cream", async () => {
    const dusk = await convertCard(manifest, decode, { backdrop: "sunset" });
    // Smaller and higher than the room card: a strip of ground stays under the feet.
    expect(dusk.y + dusk.h).toBe(320 - 36);
    expect(dusk.h).toBeLessThan(GOLDEN.geometry.h);
    expect(sha(dusk.frames.background)).not.toBe(GOLDEN.frames.background);
    // The sky's top-left pixel is dark, the cream is light.
    expect(dusk.frames.background[0]! >> 3).toBeLessThan(8);
    // Under a different sky the opaque pixels stay the same drawing; only the edges pick up the scene.
    const night = await convertCard(manifest, decode, { backdrop: "night" });
    const a = night.frames.neutral;
    const b = dusk.frames.neutral;
    let same = 0;
    let differ = 0;
    for (let i = 0; i < a.length; i += 2)
      if (a[i] === b[i] && a[i + 1] === b[i + 1]) same++;
      else differ++;
    expect(same).toBeGreaterThan(differ * 10);
    expect(differ).toBeGreaterThan(0);
    expect(sha((await convertCard(manifest, decode, { backdrop: "sunset" })).frames.background)).toBe(
      sha(dusk.frames.background),
    );
  });

  it("puts every frame through the skin effect, with room for its glow", async () => {
    const seen: number[] = [];
    const effect = (im: Rgba) => {
      seen.push(im.width);
      const out = { ...im, data: im.data.slice() };
      for (let i = 0; i < out.data.length; i += 4) out.data[i] = 255 - out.data[i]!;
      return out;
    };
    const plain = await convertCard(manifest, decode, { backdrop: "sunset" });
    const skinned = await convertCard(manifest, decode, { backdrop: "sunset", effect });
    expect(seen).toHaveLength(5);
    expect(skinned.w * skinned.h).toBeGreaterThan(0);
    expect(skinned.key).not.toBe(plain.key);
  });

  it("asks for the skin on the custom card, without the blink lids the skinned pet hides", async () => {
    const asked: string[] = [];
    const baked: string[] = [];
    const files = {
      key: "mine",
      manifest: { ...manifest },
      url: (f: string) => f,
    } as unknown as Parameters<typeof customBoardCard>[0];
    const card = customBoardCard(
      files,
      { skin: "gold", part: "night" },
      async (f) => (asked.push(f), decode(f)),
      (im, skin) => (baked.push(skin), im),
    );
    expect(card.id).toBe("mine|night|skin:gold");
    expect(customBoardCard(files, { part: "day" }).id).toBe("mine|day");
    await card.convert();
    expect(asked).not.toContain("rig-lids.webp");
    expect(baked).toEqual(["gold", "gold", "gold", "gold", "gold"]);
  });

  it("picks the sky from the local hour and draws a different scene for each", () => {
    const at = (h: number) => dayPartAt(new Date(2026, 9, 30, h, 30));
    expect([4, 5, 7, 8, 16, 17, 19, 20, 23].map(at)).toEqual([
      "night",
      "dawn",
      "dawn",
      "day",
      "day",
      "sunset",
      "sunset",
      "night",
      "night",
    ]);
    const shas = (["dawn", "day", "sunset", "night"] as const).map((p) => sha(backdrop(172, 320, p).data));
    expect(new Set(shas).size).toBe(4);
  });
});
