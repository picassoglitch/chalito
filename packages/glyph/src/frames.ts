/**
 * Frames + fountain coding.
 *
 * Frame (33 bytes): [seq][k][29 data bytes][CRC-16/CCITT over bytes 0..30].
 * seq < k  → data chunk `seq` (systematic).
 * seq >= k → parity: XOR of a pseudo-random subset of data chunks chosen from `seq`.
 * The stream loops forever, so a camera can start anywhere; a frame whose CRC fails is
 * simply an erasure, and parity frames fill gaps by peeling.
 */
export const FRAME_BYTES = 33;
export const CHUNK_BYTES = 29;

export const crc16 = (bytes: Uint8Array, end = bytes.length): number => {
  let crc = 0xffff;
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i]! << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
};

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Data chunks combined into parity frame `seq` (2..4 distinct chunks, or all when k < 2). */
export const paritySubset = (seq: number, k: number): number[] => {
  if (k <= 2) return Array.from({ length: k }, (_, i) => i);
  const rnd = mulberry32(seq * 2654435761);
  const degree = 2 + Math.floor(rnd() * Math.min(3, k - 1));
  const set = new Set<number>();
  while (set.size < degree) set.add(Math.floor(rnd() * k));
  return [...set].sort((a, b) => a - b);
};

const chunksOf = (payload: Uint8Array): Uint8Array[] => {
  const framed = new Uint8Array(2 + payload.length);
  new DataView(framed.buffer).setUint16(0, payload.length);
  framed.set(payload, 2);
  const k = Math.ceil(framed.length / CHUNK_BYTES);
  if (k > 200) throw new Error("glyph: payload too large");
  return Array.from({ length: k }, (_, i) => {
    const c = new Uint8Array(CHUNK_BYTES);
    c.set(framed.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
    return c;
  });
};

const makeFrame = (seq: number, k: number, data: Uint8Array): Uint8Array => {
  const f = new Uint8Array(FRAME_BYTES);
  f[0] = seq;
  f[1] = k;
  f.set(data, 2);
  const crc = crc16(f, 31);
  f[31] = crc >> 8;
  f[32] = crc & 0xff;
  return f;
};

/** One loop of the stream: k data frames followed by max(2, ceil(k/2)) parity frames. */
export const encodeFrames = (payload: Uint8Array): Uint8Array[] => {
  const chunks = chunksOf(payload);
  const k = chunks.length;
  const parityCount = Math.max(2, Math.ceil(k / 2));
  const frames = chunks.map((c, i) => makeFrame(i, k, c));
  for (let seq = k; seq < k + parityCount; seq++) {
    const p = new Uint8Array(CHUNK_BYTES);
    for (const i of paritySubset(seq, k)) for (let b = 0; b < CHUNK_BYTES; b++) p[b]! ^= chunks[i]![b]!;
    frames.push(makeFrame(seq, k, p));
  }
  return frames;
};

export const frameIsValid = (f: Uint8Array): boolean =>
  f.length === FRAME_BYTES && f[1]! > 0 && crc16(f, 31) === ((f[31]! << 8) | f[32]!);

/** Collects frames in any order (duplicates and bad frames ignored) until the payload is complete. */
export class FrameAssembler {
  #k = 0;
  #chunks = new Map<number, Uint8Array>();
  #parity = new Map<number, { set: Set<number>; data: Uint8Array }>();

  /** Returns the payload once every chunk is known; otherwise null. */
  push(frame: Uint8Array): Uint8Array | null {
    if (!frameIsValid(frame)) return null;
    const seq = frame[0]!;
    const k = frame[1]!;
    if (this.#k && k !== this.#k) this.reset();
    this.#k = k;
    const data = frame.slice(2, 31);
    if (seq < k) this.#chunks.set(seq, data);
    else if (!this.#parity.has(seq)) this.#parity.set(seq, { set: new Set(paritySubset(seq, k)), data });
    this.#peel();
    return this.#chunks.size === this.#k ? this.#assemble() : null;
  }

  get progress(): number {
    return this.#k ? this.#chunks.size / this.#k : 0;
  }

  reset(): void {
    this.#k = 0;
    this.#chunks.clear();
    this.#parity.clear();
  }

  #peel(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [seq, p] of this.#parity) {
        for (const i of [...p.set]) {
          const known = this.#chunks.get(i);
          if (!known) continue;
          for (let b = 0; b < CHUNK_BYTES; b++) p.data[b]! ^= known[b]!;
          p.set.delete(i);
        }
        if (p.set.size === 1) {
          const [only] = p.set;
          this.#chunks.set(only!, p.data);
          this.#parity.delete(seq);
          progressed = true;
        } else if (p.set.size === 0) {
          this.#parity.delete(seq);
        }
      }
    }
  }

  #assemble(): Uint8Array | null {
    const all = new Uint8Array(this.#k * CHUNK_BYTES);
    for (let i = 0; i < this.#k; i++) all.set(this.#chunks.get(i)!, i * CHUNK_BYTES);
    const len = new DataView(all.buffer).getUint16(0);
    if (len + 2 > all.length) return null;
    return all.slice(2, 2 + len);
  }
}
