import { describe, expect, it } from "vitest";
import { deriveDeviceId, generateSigningKeyPair, toB64url, type SigningKeyPair } from "@chalito/crypto";
import type { LanToken } from "@chalito/protocol";
import {
  LanAuthError,
  dialHandshake,
  listenHandshake,
  type HandshakeContext,
  type SecureLink,
} from "../src/lan/handshake.js";
import { memoryPair, mintToken } from "./lan-fakes.js";

interface Agent {
  id: string;
  sign: SigningKeyPair;
  pub: string;
}
const agent = async (): Promise<Agent> => {
  const sign = await generateSigningKeyPair();
  return { id: await deriveDeviceId(sign.publicKey), sign, pub: await toB64url(sign.publicKey) };
};
const ctx = (me: Agent, tokens: LanToken[], directory: Agent[], now = Date.now): HandshakeContext => ({
  deviceId: me.id,
  sign: me.sign,
  tokens: () => tokens,
  peerKey: (id) => directory.find((d) => d.id === id)?.pub ?? null,
  now,
});

const both = async (
  dialer: HandshakeContext,
  listener: HandshakeContext,
  dialToken: LanToken,
  expect: string | null = null,
  tap?: Parameters<typeof memoryPair>[0],
) => {
  const pair = memoryPair(tap);
  const l = listenHandshake(pair.b, listener, 500);
  const d = dialHandshake(pair.a, dialer, dialToken, expect, 500);
  const [dr, lr] = await Promise.allSettled([d, l]);
  return { dr, lr, pair };
};
const reason = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" && r.reason instanceof LanAuthError ? r.reason.reason : r.status;

describe("LAN handshake", () => {
  it("two agents of the same owner authenticate each other and exchange sealed frames", async () => {
    const [a, b] = [await agent(), await agent()];
    const tok = await mintToken();
    const { dr, lr } = await both(ctx(a, [tok], [b]), ctx(b, [tok], [a]), tok, b.id);
    expect(dr.status).toBe("fulfilled");
    expect(lr.status).toBe("fulfilled");
    const dl = (dr as PromiseFulfilledResult<SecureLink>).value;
    const ll = (lr as PromiseFulfilledResult<SecureLink>).value;
    expect(dl.peerDeviceId).toBe(b.id);
    expect(ll.peerDeviceId).toBe(a.id);
    const got: unknown[] = [];
    ll.onFrame((f) => got.push(f));
    await dl.send({ k: "bye", reason: "x" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]); // bye ends the link, it isn't delivered
  });

  it("refuses another owner's token (unknown token id)", async () => {
    const [a, b] = [await agent(), await agent()];
    const mine = await mintToken();
    const theirs = await mintToken();
    const { dr, lr, pair } = await both(ctx(a, [theirs], [b]), ctx(b, [mine], [a]), theirs);
    expect(reason(lr)).toBe("unknown_token");
    expect(dr.status).toBe("rejected");
    expect(pair.state.b.lastClose).toBe(4401);
  });

  it("refuses a dialer that copies the token id without the secret", async () => {
    const [a, b] = [await agent(), await agent()];
    const tok = await mintToken();
    const forged: LanToken = { ...tok, secret: (await mintToken()).secret };
    const { dr, lr } = await both(ctx(a, [forged], [b]), ctx(b, [tok], [a]), forged);
    expect(reason(dr)).toBe("bad_keys");
    expect(lr.status).toBe("rejected");
  });

  it("refuses a device with the owner's token that the directory doesn't list (stolen token)", async () => {
    const [a, b, mallory] = [await agent(), await agent(), await agent()];
    const tok = await mintToken();
    const { lr } = await both(ctx(mallory, [tok], [b]), ctx(b, [tok], [a]), tok);
    expect(reason(lr)).toBe("not_in_directory");
  });

  it("refuses a listed device id presented with another key", async () => {
    const [a, b, mallory] = [await agent(), await agent(), await agent()];
    const tok = await mintToken();
    const spoof: Agent = { ...mallory, id: a.id }; // claims a's id with its own key
    const { lr } = await both(ctx(spoof, [tok], [b]), ctx(b, [tok], [a]), tok);
    expect(reason(lr)).toBe("device_id_mismatch");
  });

  it("the dialer refuses a listener other than the one the advertisement named", async () => {
    const [a, b, c] = [await agent(), await agent(), await agent()];
    const tok = await mintToken();
    const { dr } = await both(ctx(a, [tok], [b, c]), ctx(c, [tok], [a]), tok, b.id);
    expect(reason(dr)).toBe("unexpected_peer");
  });

  it("refuses a stale signature (clock far off)", async () => {
    const [a, b] = [await agent(), await agent()];
    const tok = await mintToken();
    // The skewed side sees the other's signature as stale first; neither side gets a link.
    const { dr, lr } = await both(
      ctx(a, [tok], [b], () => Date.now() - 10 * 60_000),
      ctx(b, [tok], [a]),
      tok,
    );
    expect(reason(dr)).toBe("stale");
    expect(lr.status).toBe("rejected");
  });

  it("times out a silent peer", async () => {
    const [b, a] = [await agent(), await agent()];
    const pair = memoryPair();
    await expect(listenHandshake(pair.b, ctx(b, [await mintToken()], [a]), 50)).rejects.toMatchObject({
      reason: "timeout",
    });
  });

  it("a replayed or reordered frame ends the link", async () => {
    const [a, b] = [await agent(), await agent()];
    const tok = await mintToken();
    const seen: string[] = [];
    const { dr, lr, pair } = await both(ctx(a, [tok], [b]), ctx(b, [tok], [a]), tok, null, (dir, t) => {
      if (dir === "a2b") seen.push(t);
      return t;
    });
    const dl = (dr as PromiseFulfilledResult<SecureLink>).value;
    const ll = (lr as PromiseFulfilledResult<SecureLink>).value;
    const frames: unknown[] = [];
    let closedWith = "";
    ll.onFrame((f) => frames.push(f));
    ll.onClose((r) => (closedWith = r));
    await dl.send({ k: "ack", id: "c1", ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(frames).toHaveLength(1);
    pair.inject("a", seen.at(-1)!); // the captured frame, again
    await new Promise((r) => setTimeout(r, 20));
    expect(frames).toHaveLength(1);
    expect(closedWith).toBe("bad_frame");
  });
});
