// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "@chalito/client";
import { BoardLink, PAIR_MIN_MS } from "../src/lib/board/link.js";
import { memoryPairStore, type PairStore } from "../src/lib/board/pairing.js";
import { memoryCardErrors } from "../src/lib/board/card-errors.js";
import { parseBoardLine } from "../src/lib/board/protocol.js";
import { attachBoardApprovals } from "../src/lib/board/approvals.js";
import { FakeBoard } from "./fake-board.js";
import { setup, source, testCard, until } from "./board-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const quiet = () => ({
  warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  error: vi.spyOn(console, "error").mockImplementation(() => undefined),
});
const logged = (spy: ReturnType<typeof vi.spyOn>, text: string) =>
  spy.mock.calls.some((args: unknown[]) => args.map(String).join(" ").includes(text));

const snapshot = () =>
  ({
    status: "live",
    approvals: [],
    devices: [],
    sessions: [],
    notifications: [],
    events: {},
  }) as unknown as Snapshot;

describe("card failures", () => {
  it("logs a failed conversion with its reason, shares it, and retries until it works", async () => {
    const log = quiet();
    const errors = memoryCardErrors();
    const { board, link } = await setup({ cardErrors: errors, retryMs: 20 });
    const card = testCard();
    let fails = 2;
    link.setCard({
      id: "c1",
      convert: async () => {
        if (fails-- > 0) throw new Error("fetch failed: offline");
        return card;
      },
    });
    board.plug();
    await until(() => link.getSnapshot().card === "failed");
    expect(logged(log.warn, "fetch failed: offline")).toBe(true);
    expect(errors.get()).toBe("fetch failed: offline");
    expect(link.getSnapshot().cardError).toBe("fetch failed: offline");
    await until(() => link.getSnapshot().card === "stored");
    expect(board.card).toBe(card.key);
    expect(errors.get()).toBeNull();
    expect(link.getSnapshot().cardError).toBeNull();
  });

  it("logs the board's card-ack reason when every attempt fails, then retries later", async () => {
    const log = quiet();
    const { board, link } = await setup({ attempts: 2, retryMs: 30 });
    board.corrupt = 2;
    link.setCard(source(testCard()));
    board.plug();
    await until(() => link.getSnapshot().card === "failed");
    expect(link.getSnapshot().cardError).toBe("card-ack hash");
    expect(logged(log.warn, "card-ack hash")).toBe(true);
    await until(() => link.getSnapshot().card === "stored");
  });

  it("the same card set again after a failure tries again (the sky tick)", async () => {
    quiet();
    const { board, link } = await setup({ retryMs: 60_000 });
    let fail = true;
    const card = testCard();
    const s = {
      id: "same",
      convert: async () => {
        if (fail) throw new Error("expired url");
        return card;
      },
    };
    link.setCard(s);
    board.plug();
    await until(() => link.getSnapshot().card === "failed");
    fail = false;
    link.setCard({ ...s });
    await until(() => link.getSnapshot().card === "stored");
  });

  it("another window's link sees the card error the uploading link shares", async () => {
    quiet();
    const errors = memoryCardErrors();
    const board = new FakeBoard();
    const store = memoryPairStore();
    const panel = new BoardLink(board, store, { cardErrors: errors });
    panel.start();
    errors.set("card-ack hash");
    expect(panel.getSnapshot().cardError).toBe("card-ack hash");
    errors.set(null);
    expect(panel.getSnapshot().cardError).toBeNull();
  });
});

describe("pairing failures", () => {
  it("a pairing that can't be saved clears the code, says save-failed and logs", async () => {
    const log = quiet();
    const { board, link, store } = await setup({ paired: false });
    store.save = async () => {
      throw new Error("quota");
    };
    board.plug();
    await until(() => link.found);
    board.autoConfirm = true;
    expect(await link.pair()).toBe("save-failed");
    expect(link.getSnapshot().pairing).toBeNull();
    expect(link.ready).toBe(false);
    expect(logged(log.error, "quota")).toBe(true);
  });

  it("a pairing that can't be read is logged and shown, not taken for no pairing; a later read recovers", async () => {
    const log = quiet();
    const store = memoryPairStore();
    const load = store.load;
    let broken = true;
    const flaky: PairStore = { ...store, load: () => (broken ? Promise.reject(new Error("idb closed")) : load()) };
    const board = new FakeBoard();
    const link = new BoardLink(board, flaky);
    link.start();
    await until(() => link.getSnapshot().pairingError !== null);
    expect(link.getSnapshot().pairingError).toBe("idb closed");
    expect(logged(log.error, "idb closed")).toBe(true);
    broken = false;
    await store.clear();
    await until(() => link.getSnapshot().pairingError === null);
  });

  it("rejects a pair-ok sooner than a person can check the code and hold BOOT, and saves nothing", async () => {
    const log = quiet();
    expect(PAIR_MIN_MS).toBe(1500);
    const { board, link, store } = await setup({ paired: false, minPairMs: PAIR_MIN_MS });
    board.plug();
    await until(() => link.found);
    board.autoConfirm = true;
    expect(await link.pair()).toBe("failed");
    expect(await store.load()).toBeNull();
    expect(link.getSnapshot().pairing).toBeNull();
    expect(logged(log.warn, "pair-ok")).toBe(true);
  });

  it("a pair-ok 1.5 s after pair-begin still pairs", async () => {
    const { board, link, store } = await setup({ paired: false, minPairMs: PAIR_MIN_MS });
    board.plug();
    await until(() => link.found);
    vi.useFakeTimers({ toFake: ["Date"] });
    const result = link.pair();
    await until(() => board.pending !== null);
    await new Promise((r) => setTimeout(r, 5));
    vi.setSystemTime(Date.now() + PAIR_MIN_MS);
    board.confirmPairing();
    expect(await result).toBe("paired");
    expect((await store.load())?.keyId).toBe(board.keyId);
  });

  it("forget says when the board didn't get the pair-reset, and when the store couldn't clear", async () => {
    quiet();
    const { board, link, store } = await setup();
    board.plug();
    await until(() => link.ready);
    board.failNext.set("pair-reset", 1);
    expect(await link.forget()).toBe("board-unconfirmed");
    expect(await store.load()).toBeNull();
    const again = await setup();
    again.board.plug();
    await until(() => again.link.ready);
    again.store.clear = async () => {
      throw new Error("idb");
    };
    expect(await again.link.forget()).toBe("failed");
    const ok = await setup();
    ok.board.plug();
    await until(() => ok.link.ready);
    expect(await ok.link.forget()).toBe("forgotten");
  });
});

describe("link resilience", () => {
  it("a repeated hello from the same paired board never publishes paired:false", async () => {
    const { board, link } = await setup();
    const off = attachBoardApprovals(link, {
      live: { subscribe: () => () => undefined, getSnapshot: snapshot },
      actions: { decide: async () => undefined },
    } as never);
    board.plug();
    await until(() => link.ready);
    const seen: boolean[] = [];
    link.subscribe(() => seen.push(link.getSnapshot().paired));
    const frames = board.sent("approval-console").length;
    board.emit({ v: 1, type: "hello", fw: "0.1.0", board: "b", w: 172, h: 320, card: null, pair: board.keyId });
    await until(() => seen.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).not.toContain(false);
    // The display wasn't torn down and rebuilt: no fresh frame was forced out by a re-attach.
    expect(board.sent("approval-console").length).toBe(frames);
    off();
  });

  it("one throwing command handler doesn't stop the commands after it", async () => {
    const log = quiet();
    const { board, link } = await setup();
    const got: string[] = [];
    let first = true;
    link.onCommand((c) => {
      if (first) {
        first = false;
        throw new Error("handler bug");
      }
      got.push(c.type);
    });
    board.plug();
    await until(() => link.ready);
    board.emit({ v: 1, type: "next" });
    board.emit({ v: 1, type: "previous" });
    await until(() => got.length === 1);
    expect(got).toEqual(["previous"]);
    expect(logged(log.error, "handler bug")).toBe(true);
  });

  it("a WebCrypto failure is logged on its own, not counted as a pairing mismatch", async () => {
    const log = quiet();
    const board = new FakeBoard();
    const store = memoryPairStore();
    board.secret = Buffer.alloc(32, 1);
    await store.save({ keyId: board.keyId!, key: {} as CryptoKey });
    const link = new BoardLink(board, store);
    link.start();
    board.plug();
    await until(() => link.ready);
    board.decide("a1b2c3d4e5f6", "t".repeat(24), true);
    await until(() => log.error.mock.calls.length > 0);
    expect(logged(log.error, "couldn't check")).toBe(true);
    expect(link.getSnapshot().rejected).toBe(0);
  });

  it("retries a host hello that failed to send, with backoff, until the board answers", async () => {
    const log = quiet();
    const { board, link } = await setup({ helloRetryMs: 10 });
    board.failNext.set("hello", 2);
    // Connected without the board's own boot hello: only ours can make it answer.
    board.setStatus({ state: "connected", port: "/dev/fake" });
    await until(() => link.ready);
    expect(board.sent("hello")).toHaveLength(1);
    expect(logged(log.warn, "hello")).toBe(true);
  });

  it("a board that forgot us by itself (pair-cleared) gets a hello, and its answer unpairs it", async () => {
    expect(parseBoardLine('{"v":1,"type":"pair-cleared"}')).toEqual({ type: "pair-cleared" });
    const { board, link } = await setup();
    board.plug();
    await until(() => link.ready);
    const hellos = board.sent("hello").length;
    board.forgetOnBoard();
    await until(() => !link.ready);
    expect(board.sent("hello")).toHaveLength(hellos + 1);
    expect(link.getSnapshot().hasPairing).toBe(true);
    expect(link.found).toBe(true);
  });
});
