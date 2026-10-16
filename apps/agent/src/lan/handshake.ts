import {
  LanCipher,
  deriveDeviceId,
  fromB64url,
  fromUtf8,
  lanEphemeral,
  lanSessionKeys,
  lanTranscript,
  randomBytes,
  signDetached,
  toB64url,
  utf8,
  verifyDetached,
  type SigningKeyPair,
} from "@chalito/crypto";
import {
  LanFrame,
  LanHello,
  LanHelloReply,
  LanIdentity,
  type LanHandshakeBody,
  type LanToken,
} from "@chalito/protocol";
import type { LanConn } from "./ws.js";

/**
 * The LAN handshake (see packages/crypto/src/lan.ts for the construction). A link is up only when
 * the other side proved, in one transcript, that it holds:
 *   1. this owner's current cloud-issued LAN token (else the keys don't match and nothing opens), and
 *   2. the device key of an agent the owner's directory lists (signature over the transcript; the
 *      device id must be derived from that key).
 * Any failure closes the socket with one generic code (4401), so a stranger learns nothing about why.
 */

export const LAN_AUTH_CLOSE = 4401;
export const HANDSHAKE_TIMEOUT_MS = 5000;
/** How far a handshake signature's clock may be from ours. */
const SKEW_MS = 60_000;

export type LanAuthReason =
  | "malformed"
  | "unknown_token"
  | "bad_keys"
  | "not_in_directory"
  | "device_id_mismatch"
  | "key_mismatch"
  | "self"
  | "bad_signature"
  | "stale"
  | "unexpected_peer"
  | "timeout"
  | "closed";

export class LanAuthError extends Error {
  override name = "LanAuthError";
  constructor(readonly reason: LanAuthReason) {
    super(`lan auth: ${reason}`);
  }
}

export interface HandshakeContext {
  deviceId: string;
  sign: SigningKeyPair;
  /** Valid tokens, newest first (the cloud returns the current one and any still-live older one). */
  tokens(): readonly LanToken[];
  /** The owner's other agents from the cloud's directory: device id → Ed25519 public key (base64url). */
  peerKey(deviceId: string): string | null;
  now(): number;
}

/** An authenticated, sealed link to one of the owner's agents. */
export interface SecureLink {
  readonly peerDeviceId: string;
  /** When the token this link was keyed with expires; the service re-keys before that. */
  readonly tokenExpiresAt: number;
  readonly remote: string;
  send(f: LanFrame): Promise<void>;
  onFrame(cb: (f: LanFrame) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(reason: string): void;
}

const fail = (conn: LanConn, reason: LanAuthReason): never => {
  conn.close(LAN_AUTH_CLOSE, "auth");
  throw new LanAuthError(reason);
};

/** Resolves with the next message, or rejects on close/timeout. One waiter at a time. */
const nextMessage = (conn: LanConn, queue: string[], waiters: ((t: string | null) => void)[]) =>
  new Promise<string>((resolve, reject) => {
    const q = queue.shift();
    if (q !== undefined) return resolve(q);
    waiters.push((t) => (t === null ? reject(new LanAuthError("closed")) : resolve(t)));
  });

const reader = (conn: LanConn) => {
  const queue: string[] = [];
  const waiters: ((t: string | null) => void)[] = [];
  let closed = false;
  let stopped = false;
  conn.onMessage((t) => {
    if (stopped) return;
    const w = waiters.shift();
    if (w) w(t);
    else if (queue.length < 4) queue.push(t);
  });
  conn.onClose(() => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  return {
    next: () =>
      closed && !queue.length ? Promise.reject(new LanAuthError("closed")) : nextMessage(conn, queue, waiters),
    /** Frames that arrived during the handshake, after its last message (handed to the link). */
    drain: () => {
      stopped = true;
      return queue.splice(0);
    },
  };
};

const parseJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

const identityFor = async (
  ctx: HandshakeContext,
  role: LanHandshakeBody["role"],
  th: Uint8Array,
  peerDeviceId: string | null,
): Promise<LanIdentity> => {
  const body: LanHandshakeBody = {
    v: 1,
    role,
    th: await toB64url(th),
    deviceId: ctx.deviceId,
    peerDeviceId,
    issuedAt: ctx.now(),
  };
  return {
    v: 1,
    deviceId: ctx.deviceId,
    pubSign: await toB64url(ctx.sign.publicKey),
    body,
    sig: await signDetached("chalito.lan-handshake.v1", body, ctx.sign.secretKey),
  };
};

/** Checks the other side's sealed identity; returns its device id. */
const checkIdentity = async (
  conn: LanConn,
  ctx: HandshakeContext,
  raw: unknown,
  expectRole: LanHandshakeBody["role"],
  th: Uint8Array,
): Promise<string> => {
  const parsed = LanIdentity.safeParse(raw);
  if (!parsed.success) return fail(conn, "malformed");
  const id = parsed.data;
  if (id.deviceId === ctx.deviceId) return fail(conn, "self");
  if (id.body.deviceId !== id.deviceId || id.body.role !== expectRole) return fail(conn, "malformed");
  if (id.body.th !== (await toB64url(th))) return fail(conn, "malformed");
  if (id.body.peerDeviceId !== null && id.body.peerDeviceId !== ctx.deviceId) return fail(conn, "unexpected_peer");
  if (Math.abs(ctx.now() - id.body.issuedAt) > SKEW_MS) return fail(conn, "stale");
  const pub = await fromB64url(id.pubSign);
  if ((await deriveDeviceId(pub)) !== id.deviceId) return fail(conn, "device_id_mismatch");
  const known = ctx.peerKey(id.deviceId);
  if (!known) return fail(conn, "not_in_directory");
  if (known !== id.pubSign) return fail(conn, "key_mismatch");
  if (!(await verifyDetached("chalito.lan-handshake.v1", id.body, id.sig, pub))) return fail(conn, "bad_signature");
  return id.deviceId;
};

const withTimeout = <T>(conn: LanConn, p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      conn.close(LAN_AUTH_CLOSE, "auth");
      reject(new LanAuthError("timeout"));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new LanAuthError("closed"));
      },
    );
  });

/** Wraps an authenticated connection: frames are sealed, ordered and schema-checked. */
const secureLink = (
  conn: LanConn,
  cipher: LanCipher,
  peerDeviceId: string,
  tokenExpiresAt: number,
  pending: string[],
): SecureLink => {
  const frameCbs: ((f: LanFrame) => void)[] = [];
  const closeCbs: ((r: string) => void)[] = [];
  let closed = false;
  // Decrypt strictly in arrival order (the cipher's sequence check depends on it).
  let chain = Promise.resolve();
  let sendChain = Promise.resolve();
  const end = (reason: string, code = 1000) => {
    if (closed) return;
    closed = true;
    conn.close(code, reason);
    for (const cb of closeCbs) cb(reason);
  };
  const onText = (t: string) => {
    chain = chain.then(async () => {
      if (closed) return;
      let f: LanFrame;
      try {
        const plain = await cipher.open(await fromB64url(t));
        const parsed = LanFrame.safeParse(parseJson(fromUtf8(plain)));
        if (!parsed.success) return end("malformed", 4400);
        f = parsed.data;
      } catch {
        return end("bad_frame", 4400); // replayed, reordered, forged or garbled
      }
      if (f.k === "bye") return end(f.reason);
      for (const cb of frameCbs) cb(f);
    });
  };
  conn.onClose(() => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb("closed");
  });
  for (const t of pending) onText(t);
  conn.onMessage(onText);
  return {
    peerDeviceId,
    tokenExpiresAt,
    remote: conn.remote,
    send: (f) =>
      (sendChain = sendChain.then(async () => {
        if (closed) throw new Error("lan: link closed");
        conn.send(await toB64url(await cipher.seal(utf8(JSON.stringify(f)))));
      })),
    onFrame: (cb) => void frameCbs.push(cb),
    onClose: (cb) => void closeCbs.push(cb),
    close: (reason) => {
      if (closed) return;
      void cipher
        .seal(utf8(JSON.stringify({ k: "bye", reason: reason.slice(0, 64) })))
        .then(async (ct) => conn.send(await toB64url(ct)))
        .catch(() => undefined)
        .finally(() => end(reason));
    },
  };
};

/**
 * Dialer side. `token` is the owner token the listener's advertised name was derived from;
 * `expectPeer` is the device that name maps to (a different authenticated device is refused).
 */
export const dialHandshake = async (
  conn: LanConn,
  ctx: HandshakeContext,
  token: LanToken,
  expectPeer: string | null,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<SecureLink> => {
  const r = reader(conn);
  const run = async () => {
    const eph = await lanEphemeral();
    const nonce = await randomBytes(32);
    const tid = await fromB64url(token.tid);
    const hello: LanHello = {
      v: 1,
      t: "hello",
      tid: token.tid,
      e: await toB64url(eph.publicKey),
      n: await toB64url(nonce),
    };
    conn.send(JSON.stringify(hello));
    const reply = LanHelloReply.safeParse(parseJson(await r.next()));
    if (!reply.success) return fail(conn, "malformed");
    const peerEph = await fromB64url(reply.data.e);
    const th = await lanTranscript({
      tid,
      dialerEph: eph.publicKey,
      dialerNonce: nonce,
      listenerEph: peerEph,
      listenerNonce: await fromB64url(reply.data.n),
    });
    let cipher: LanCipher;
    try {
      cipher = new LanCipher(await lanSessionKeys("dialer", eph, peerEph, await fromB64url(token.secret), th));
    } catch {
      return fail(conn, "bad_keys");
    }
    let identity: unknown;
    try {
      identity = parseJson(fromUtf8(await cipher.open(await fromB64url(reply.data.box))));
    } catch {
      return fail(conn, "bad_keys"); // the listener doesn't hold this owner's token
    }
    const peer = await checkIdentity(conn, ctx, identity, "listener", th);
    if (expectPeer && peer !== expectPeer) return fail(conn, "unexpected_peer");
    const mine = await identityFor(ctx, "dialer", th, peer);
    conn.send(await toB64url(await cipher.seal(utf8(JSON.stringify(mine)))));
    return secureLink(conn, cipher, peer, token.expiresAt, r.drain());
  };
  return withTimeout(conn, run(), timeoutMs);
};

/** Listener side: the dialer names a token id; an unknown one (another owner's, expired) is refused. */
export const listenHandshake = async (
  conn: LanConn,
  ctx: HandshakeContext,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
): Promise<SecureLink> => {
  const r = reader(conn);
  const run = async () => {
    const hello = LanHello.safeParse(parseJson(await r.next()));
    if (!hello.success) return fail(conn, "malformed");
    const now = ctx.now();
    const token = ctx.tokens().find((t) => t.tid === hello.data.tid && t.expiresAt > now);
    if (!token) return fail(conn, "unknown_token");
    const eph = await lanEphemeral();
    const nonce = await randomBytes(32);
    const peerEph = await fromB64url(hello.data.e);
    const th = await lanTranscript({
      tid: await fromB64url(token.tid),
      dialerEph: peerEph,
      dialerNonce: await fromB64url(hello.data.n),
      listenerEph: eph.publicKey,
      listenerNonce: nonce,
    });
    let cipher: LanCipher;
    try {
      cipher = new LanCipher(await lanSessionKeys("listener", eph, peerEph, await fromB64url(token.secret), th));
    } catch {
      return fail(conn, "bad_keys");
    }
    const mine = await identityFor(ctx, "listener", th, null);
    const reply: LanHelloReply = {
      v: 1,
      t: "hello",
      e: await toB64url(eph.publicKey),
      n: await toB64url(nonce),
      box: await toB64url(await cipher.seal(utf8(JSON.stringify(mine)))),
    };
    conn.send(JSON.stringify(reply));
    let identity: unknown;
    try {
      identity = parseJson(fromUtf8(await cipher.open(await fromB64url(await r.next()))));
    } catch (err) {
      if (err instanceof LanAuthError) throw err;
      return fail(conn, "bad_keys");
    }
    const peer = await checkIdentity(conn, ctx, identity, "dialer", th);
    return secureLink(conn, cipher, peer, token.expiresAt, r.drain());
  };
  return withTimeout(conn, run(), timeoutMs);
};
