import jpegJs from "jpeg-js";
import { SCREEN_CHUNK_MAX, SCREEN_FRAME_HEADER, SCREEN_FRAME_VERSION } from "@chalito/protocol";
import { downscaleRgba, fitSize } from "../computer/image.js";

/**
 * Screen frames for the remote viewer: a display capture, downscaled to fit STREAM_MAX, encoded
 * as JPEG and cut into data-channel chunks (protocol screen.ts documents the chunk layout).
 * Nothing here leaves the device except through the peer connection's DTLS channel.
 */

/** Frames fit in this box (aspect kept, never upscaled). */
export const STREAM_MAX = { width: 1600, height: 1000 } as const;
export const JPEG_QUALITY = 60;

/** RGBA capture → downscaled JPEG, plus the size it was encoded at. */
export const encodeFrame = (
  cap: { width: number; height: number; rgba: Uint8Array },
  quality = JPEG_QUALITY,
  max: { width: number; height: number } = STREAM_MAX,
): { jpeg: Buffer; width: number; height: number } => {
  const size = fitSize(cap.width, cap.height, max);
  const rgb = downscaleRgba(cap.rgba, cap.width, cap.height, size.width, size.height);
  const rgba = new Uint8Array(size.width * size.height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i]!;
    rgba[j + 1] = rgb[i + 1]!;
    rgba[j + 2] = rgb[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { jpeg: jpegJs.encode({ width: size.width, height: size.height, data: rgba }, quality).data, ...size };
};

/** Cuts one encoded frame into data-channel messages. */
export const chunkFrame = (frameId: number, data: Uint8Array, max = SCREEN_CHUNK_MAX): Buffer[] => {
  const room = max - SCREEN_FRAME_HEADER;
  const count = Math.max(1, Math.ceil(data.length / room));
  if (count > 0xffff) throw new Error("frame too large");
  const out: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const part = data.subarray(i * room, (i + 1) * room);
    const msg = Buffer.alloc(SCREEN_FRAME_HEADER + part.length);
    msg[0] = SCREEN_FRAME_VERSION;
    msg.writeUInt32BE(frameId >>> 0, 1);
    msg.writeUInt16BE(i, 5);
    msg.writeUInt16BE(count, 7);
    msg.set(part, SCREEN_FRAME_HEADER);
    out.push(msg);
  }
  return out;
};

/**
 * The viewer's side of chunkFrame (the hub implements the same in the browser; this one backs the
 * tests and documents the rules): complete frames only, never older than the last one shown.
 */
export class FrameAssembler {
  #parts = new Map<number, { count: number; got: Map<number, Uint8Array> }>();
  #last = -1;

  push(msg: Uint8Array): Uint8Array | null {
    if (msg.length < SCREEN_FRAME_HEADER || msg[0] !== SCREEN_FRAME_VERSION) return null;
    const view = Buffer.from(msg.buffer, msg.byteOffset, msg.byteLength);
    const id = view.readUInt32BE(1);
    const idx = view.readUInt16BE(5);
    const count = view.readUInt16BE(7);
    if (id <= this.#last || count === 0 || idx >= count) return null;
    let f = this.#parts.get(id);
    if (!f) {
      f = { count, got: new Map() };
      this.#parts.set(id, f);
    }
    f.got.set(idx, view.subarray(SCREEN_FRAME_HEADER));
    if (f.got.size < f.count) return null;
    this.#last = id;
    for (const k of this.#parts.keys()) if (k <= id) this.#parts.delete(k);
    return Buffer.concat([...Array(f.count).keys()].map((i) => f.got.get(i)!));
  }
}
