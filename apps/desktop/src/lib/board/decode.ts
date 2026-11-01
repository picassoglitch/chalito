import type { Rgba } from "./pillow.js";

/** A card drawing's straight RGBA. Canvas stores premultiplied pixels, so semi-transparent
 * edges may differ from Pillow's decode by a rounding step; opaque pixels match. */
export const decodeImage = async (url: string): Promise<Rgba> => {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx) throw new Error("no 2d canvas");
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: "srgb" });
  return { width: d.width, height: d.height, data: new Uint8Array(d.data.buffer) };
};
