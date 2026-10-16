import { describe, expect, it } from "vitest";
import {
  LanCipher,
  lanAdvertId,
  lanEphemeral,
  lanSessionKeys,
  lanTranscript,
  randomBytes,
  utf8,
} from "../src/index.js";

const setup = async (dialerToken?: Uint8Array) => {
  const token = await randomBytes(32);
  const d = await lanEphemeral();
  const l = await lanEphemeral();
  const th = await lanTranscript({
    tid: await randomBytes(16),
    dialerEph: d.publicKey,
    dialerNonce: await randomBytes(32),
    listenerEph: l.publicKey,
    listenerNonce: await randomBytes(32),
  });
  const dk = await lanSessionKeys("dialer", d, l.publicKey, dialerToken ?? token, th);
  const lk = await lanSessionKeys("listener", l, d.publicKey, token, th);
  return { dk, lk, token, d, l, th };
};

describe("LAN handshake keys", () => {
  it("both sides derive matching per-direction keys", async () => {
    const { dk, lk } = await setup();
    expect(dk.send).toEqual(lk.recv);
    expect(dk.recv).toEqual(lk.send);
    expect(dk.send).not.toEqual(dk.recv);
  });

  it("a side without the owner's token derives different keys", async () => {
    const { dk, lk } = await setup(await randomBytes(32));
    expect(dk.send).not.toEqual(lk.recv);
  });

  it("refuses a low-order peer key and bad lengths", async () => {
    const eph = await lanEphemeral();
    const th = new Uint8Array(32);
    await expect(lanSessionKeys("dialer", eph, new Uint8Array(32), new Uint8Array(32), th)).rejects.toThrow(
      /low-order/,
    );
    await expect(lanSessionKeys("dialer", eph, eph.publicKey, new Uint8Array(16), th)).rejects.toThrow(/token/);
    await expect(
      lanTranscript({
        tid: new Uint8Array(15),
        dialerEph: eph.publicKey,
        dialerNonce: new Uint8Array(32),
        listenerEph: eph.publicKey,
        listenerNonce: new Uint8Array(32),
      }),
    ).rejects.toThrow();
  });

  it("the transcript binds every input", async () => {
    const base = {
      tid: new Uint8Array(16),
      dialerEph: new Uint8Array(32).fill(1),
      dialerNonce: new Uint8Array(32).fill(2),
      listenerEph: new Uint8Array(32).fill(3),
      listenerNonce: new Uint8Array(32).fill(4),
    };
    const a = await lanTranscript(base);
    expect(await lanTranscript({ ...base, listenerNonce: new Uint8Array(32).fill(5) })).not.toEqual(a);
    expect(await lanTranscript({ ...base, tid: new Uint8Array(16).fill(9) })).not.toEqual(a);
  });
});

describe("LanCipher", () => {
  it("round-trips in order and refuses replays, reordering and tampering", async () => {
    const { dk, lk } = await setup();
    const tx = new LanCipher(dk);
    const rx = new LanCipher(lk);
    const f0 = await tx.seal(utf8("zero"));
    const f1 = await tx.seal(utf8("one"));
    const f2 = await tx.seal(utf8("two"));
    expect(new TextDecoder().decode(await rx.open(f0))).toBe("zero");
    await expect(rx.open(f0)).rejects.toThrow(); // replay
    await expect(rx.open(f2)).rejects.toThrow(); // skipped f1
    const bad = f1.slice();
    bad[0] = (bad[0] ?? 0) ^ 1;
    await expect(rx.open(bad)).rejects.toThrow(); // tampered
    expect(new TextDecoder().decode(await rx.open(f1))).toBe("one");
  });

  it("a frame from one direction can't be reflected back", async () => {
    const { dk, lk } = await setup();
    const tx = new LanCipher(dk);
    const f = await tx.seal(utf8("x"));
    await expect(new LanCipher(dk).open(f)).rejects.toThrow();
    expect(await new LanCipher(lk).open(f)).toEqual(utf8("x"));
  });
});

describe("lanAdvertId", () => {
  it("is stable per token, device and window, and unlinkable otherwise", async () => {
    const k = await randomBytes(32);
    const a = await lanAdvertId(k, "dev_a", 1);
    expect(a).toMatch(/^[0-9a-hjkmnp-tv-z]{16}$/);
    expect(await lanAdvertId(k, "dev_a", 1)).toBe(a);
    expect(await lanAdvertId(k, "dev_a", 2)).not.toBe(a);
    expect(await lanAdvertId(k, "dev_b", 1)).not.toBe(a);
    expect(await lanAdvertId(await randomBytes(32), "dev_a", 1)).not.toBe(a);
    expect(a).not.toContain("dev");
  });
});
