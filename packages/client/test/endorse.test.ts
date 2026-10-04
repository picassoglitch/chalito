import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDeviceId, generateBoxKeyPair, generateSigningKeyPair, signEnvelope, toB64url } from "@chalito/crypto";
import { EndorsementBody, type DeviceRegistration, type Endorsement } from "@chalito/protocol";
import {
  EndorseCodeExpiredError,
  EndorseFailedError,
  EndorsementUnavailableError,
  endorseTopic,
  endorsementChannel,
  supabaseEndorseWatch,
  unavailableEndorsement,
  type BrowserSupabase,
  type PostApi,
} from "../src/index.js";

const NOW = 1_790_000_000_000;
const CODE = {
  codeId: "AbCdEfGhIjKlMnOpQrStUv",
  shortCode: "KQ7R-M2XZ",
  watchToken: "watch-hash",
  expiresAt: NOW + 300_000,
};
const REG = { body: { deviceId: "dev_new" } } as unknown as DeviceRegistration;
/** A real, schema-valid endorsement (the channel parses what /take returns). */
const E: Endorsement = await (async () => {
  const signer = await generateSigningKeyPair();
  const subject = await generateSigningKeyPair();
  const signerId = await deriveDeviceId(signer.publicKey);
  return signEnvelope(
    "chalito.endorsement.v1",
    EndorsementBody.parse({
      v: 1,
      uid: "owner-1",
      newDeviceId: await deriveDeviceId(subject.publicKey),
      pubSign: await toB64url(subject.publicKey),
      pubBox: await toB64url((await generateBoxKeyPair()).publicKey),
      issuedAt: NOW,
    }),
    signerId,
    signer.secretKey,
  );
})();

class FakeApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** /codes, then /take answering `not_endorsed` until `endorse()` (or a scripted error). */
const fakeApi = () => {
  let state: "waiting" | "endorsed" | "taken" | { error: string } = "waiting";
  const calls: [string, unknown][] = [];
  const api: PostApi = {
    post: async <T>(path: string, body: unknown) => {
      calls.push([path, body]);
      if (path === "/v1/endorse/codes") return CODE as T;
      if (typeof state === "object") throw new FakeApiError(state.error);
      if (state === "waiting") throw new FakeApiError("not_endorsed");
      if (state === "taken") throw new FakeApiError("already_taken");
      state = "taken";
      return { endorsement: E } as T;
    },
  };
  return {
    api,
    calls,
    endorse: () => void (state = "endorsed"),
    error: (e: string) => void (state = { error: e }),
    takes: () => calls.filter(([p]) => p === "/v1/endorse/take").length,
  };
};

const fakeWatch = () => {
  let fire: (() => void) | null = null;
  const off = vi.fn();
  const watch = vi.fn(async (_c: string, _t: string, onPointer: () => void) => {
    fire = onPointer;
    return off;
  });
  return { watch, off, pointer: () => fire?.() };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("endorsement channel (new device)", () => {
  beforeEach(() => void vi.useFakeTimers({ now: NOW }));
  afterEach(() => void vi.useRealTimers());

  it("publishes the registration, shows the code and the signed glyph, joins the code's watch", async () => {
    const a = fakeApi();
    const w = fakeWatch();
    const glyphFor = vi.fn(async (c: { codeId: string }) => ({ glyph: c.codeId }));
    const s = await endorsementChannel({ api: a.api, watch: w.watch, glyphFor }).open(REG);
    expect(a.calls[0]).toEqual(["/v1/endorse/codes", { registration: REG }]);
    expect(s.display).toEqual({ ...CODE, watchToken: undefined, glyph: { glyph: CODE.codeId } } as never);
    expect(glyphFor).toHaveBeenCalledWith({ codeId: CODE.codeId, expiresAt: CODE.expiresAt });
    expect(w.watch).toHaveBeenCalledWith(CODE.codeId, "watch-hash", expect.any(Function));
    s.cancel();
  });

  it("a pointer takes the endorsement once, then stops listening", async () => {
    const a = fakeApi();
    const w = fakeWatch();
    const s = await endorsementChannel({ api: a.api, watch: w.watch }).open(REG);
    w.pointer(); // join resync: nothing yet
    await flush();
    a.endorse();
    w.pointer();
    expect(await s.endorsement).toEqual(E);
    expect(w.off).toHaveBeenCalled();
    const takes = a.takes();
    w.pointer();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(a.takes()).toBe(takes);
  });

  it("without realtime the poll still gets there", async () => {
    const a = fakeApi();
    const s = await endorsementChannel({
      api: a.api,
      watch: () => Promise.reject(new Error("websocket blocked")),
      pollMs: 1000,
    }).open(REG);
    a.endorse();
    vi.advanceTimersByTime(1000);
    expect(await s.endorsement).toEqual(E);
  });

  it("expires with the code", async () => {
    const a = fakeApi();
    const w = fakeWatch();
    const s = await endorsementChannel({ api: a.api, watch: w.watch, pollMs: 60_000 }).open(REG);
    vi.advanceTimersByTime(300_000);
    await expect(s.endorsement).rejects.toBeInstanceOf(EndorseCodeExpiredError);
    expect(w.off).toHaveBeenCalled();
  });

  it.each([
    ["expired", EndorseCodeExpiredError],
    ["already_taken", EndorseFailedError],
    ["not_found", EndorseFailedError],
  ] as const)("the api saying %s ends the wait", async (code, type) => {
    const a = fakeApi();
    const w = fakeWatch();
    const s = await endorsementChannel({ api: a.api, watch: w.watch }).open(REG);
    a.error(code);
    w.pointer();
    await expect(s.endorsement).rejects.toBeInstanceOf(type);
  });

  it("cancel stops everything", async () => {
    const a = fakeApi();
    const w = fakeWatch();
    const s = await endorsementChannel({ api: a.api, watch: w.watch, pollMs: 1000 }).open(REG);
    s.cancel();
    await expect(s.endorsement).rejects.toMatchObject({ code: "cancelled" });
    const takes = a.takes();
    vi.advanceTimersByTime(10_000);
    await flush();
    expect(a.takes()).toBe(takes);
  });

  it("the unavailable channel says so", async () => {
    await expect(unavailableEndorsement.open(REG)).rejects.toBeInstanceOf(EndorsementUnavailableError);
  });
});

describe("supabaseEndorseWatch", () => {
  const fakeSb = (session: { access_token: string } | null) => {
    const order: string[] = [];
    let onBroadcast: () => void = () => undefined;
    const channel = {
      on: (_t: string, _f: unknown, cb: () => void) => ((onBroadcast = cb), channel),
      subscribe: (cb: (s: string) => void) => (order.push("subscribe"), cb("SUBSCRIBED"), channel),
    };
    const sb = {
      auth: {
        verifyOtp: vi.fn(async () => ({ data: { session }, error: session ? null : { message: "x" } })),
      },
      realtime: { setAuth: vi.fn(async () => void order.push("setAuth")) },
      channel: vi.fn((topic: string, o: unknown) => (order.push(`channel ${topic} ${JSON.stringify(o)}`), channel)),
      removeChannel: vi.fn(async () => undefined),
      removeAllChannels: vi.fn(async () => undefined),
    };
    return { sb: sb as unknown as BrowserSupabase, raw: sb, order, broadcast: () => onBroadcast() };
  };

  it("exchanges the watch token on its own client, sets auth BEFORE joining the private topic", async () => {
    const f = fakeSb({ access_token: "watch-jwt" });
    const pointers = vi.fn();
    const off = await supabaseEndorseWatch("https://x.supabase.co", "pk", () => f.sb)(
      CODE.codeId,
      "watch-hash",
      pointers,
    );
    expect(f.raw.auth.verifyOtp).toHaveBeenCalledWith({ token_hash: "watch-hash", type: "magiclink" });
    expect(f.raw.realtime.setAuth).toHaveBeenCalledWith("watch-jwt");
    expect(f.order).toEqual([
      "setAuth",
      `channel ${endorseTopic(CODE.codeId)} {"config":{"private":true}}`,
      "subscribe",
    ]);
    expect(pointers).toHaveBeenCalledTimes(1); // resync on SUBSCRIBED
    f.broadcast();
    expect(pointers).toHaveBeenCalledTimes(2);
    off();
    expect(f.raw.removeAllChannels).toHaveBeenCalled();
  });

  it("a watch token that doesn't verify fails", async () => {
    const f = fakeSb(null);
    await expect(supabaseEndorseWatch("u", "k", () => f.sb)("c", "bad", () => undefined)).rejects.toBeInstanceOf(
      EndorseFailedError,
    );
  });
});
