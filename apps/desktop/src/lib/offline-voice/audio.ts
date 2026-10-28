/** whisper.cpp wants 16 kHz mono. */
export const SPEECH_RATE = 16_000;

export const concat = (chunks: readonly Float32Array[]): Float32Array => {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** Averages each output sample's window: a cheap low-pass, enough for speech recognition. */
export const downsample = (pcm: Float32Array, from: number, to = SPEECH_RATE): Float32Array => {
  if (from === to) return pcm;
  if (from < to) throw new Error(`can't upsample ${from} Hz to ${to} Hz`);
  const ratio = from / to;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(pcm.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += pcm[j]!;
    out[i] = b > a ? s / (b - a) : 0;
  }
  return out;
};

// From Alux by Omar (homiomar), pet/whisper.js: 16-bit mono PCM WAV from samples in [-1, 1].
export const wav = (pcm: Float32Array, rate = SPEECH_RATE): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++)
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i]!)) * 32767), true);
  return bytes;
};
