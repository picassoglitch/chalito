// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachApprovalDisplay, type Snapshot } from "@chalito/client";
import { CARD_FRAMES } from "../src/lib/board/card.js";
import { BoardLink, CHUNK_BYTES, PAIR_TIMEOUT_MS } from "../src/lib/board/link.js";
import { memoryPairStore } from "../src/lib/board/pairing.js";
import { boardMood, clampMs, hostHello, parseBoardLine } from "../src/lib/board/protocol.js";
import { attachBoardApprovals } from "../src/lib/board/approvals.js";
import { FakeBoard } from "./fake-board.js";
import { setup, source, testCard, until } from "./board-helpers.js";

afterEach(() => vi.useRealTimers());

describe("board lines", () => {
  it("ignores logs, junk and other versions; keeps unknown types for the approval parser", () => {
    expect(parseBoardLine("I (312) main_task: Calling app_main()")).toBeNull();
    expect(parseBoardLine("{broken")).toBeNull();
    expect(parseBoardLine("[1,2]")).toBeNull();
    expect(parseBoardLine('{"v":2,"type":"hello"}')).toBeNull();
    expect(parseBoardLine('{"v":1,"type":"hello","fw":"0.1.0","board":"b","w":172,"h":320,"card":null}')).toEqual({
      type: "hello",
      fw: "0.1.0",
      board: "b",
      w: 172,
      h: 320,
      card: null,
      pair: null,
    });
    expect(parseBoardLine('{"v":1,"type":"hello","fw":"0.1.0"}')).toBeNull();
    expect(parseBoardLine('{"v":1,"type":"pet","trick":"spin"}')).toEqual({ type: "pet", trick: "spin" });
    expect(parseBoardLine('{"v":1,"type":"card-ack","key":"k","ok":false,"reason":"hash"}')).toEqual({
      type: "card-ack",
      key: "k",
      ok: false,
      reason: "hash",
    });
    expect(parseBoardLine('{"v":1,"type":"next"}')).toEqual({ type: "other", raw: { v: 1, type: "next" } });
  });

  it("maps the pet's emotions to the board's five faces and clamps durations", () => {
    expect(["excited", "worried", "thinking", "tired"].map((t) => boardMood(t as never))).toEqual([
      "happy",
      "sad",
      "neutral",
      "tired",
    ]);
    expect([0, 1500.4, 120_000].map(clampMs)).toEqual([1, 1500, 60_000]);
  });
});

describe("BoardLink", () => {
  it("says hello when the board appears and is ready after its answer; silent without a board", async () => {
    const { board, link } = await setup();
    link.mood("happy", 1000);
    link.alert("danger", 1000);
    expect(board.got).toEqual([]);
    board.plug();
    await until(() => link.ready);
    expect(board.sent("hello")).toHaveLength(1);
    // BOARD_LINK: the board has no clock, so the hello carries ours for expiry.
    expect(board.sent("hello")[0]).toMatchObject({ v: 1, type: "hello", now: expect.any(Number) });
    link.mood("happy", 1500);
    link.alert("attention", 70_000);
    link.alert("danger");
    await until(() => board.got.length === 4);
    expect(board.got.slice(1)).toEqual([
      { v: 1, type: "mood", mood: "happy", ms: 1500 },
      { v: 1, type: "alert", level: "attention", ms: 60_000 },
      { v: 1, type: "alert", level: "danger" },
    ]);
    board.unplug();
    expect(link.ready).toBe(false);
  });

  it("hello carries the local offset so the board knows the hour", async () => {
    const at = new Date(Date.UTC(2026, 9, 30, 15, 0));
    expect(hostHello(at)).toEqual({ v: 1, type: "hello", now: at.getTime(), tz: -at.getTimezoneOffset() });
    const { board, link } = await setup();
    board.plug();
    await until(() => link.ready);
    expect(board.sent("hello")[0]).toMatchObject({ tz: -new Date().getTimezoneOffset() });
  });

  it("sends the agents' activity hint on change, only to the paired board, again after each hello", async () => {
    const { board, link } = await setup();
    // Each hello may be a rebooted board, so the hint goes out again; repeats are harmless.
    const hints = () => board.sent("activity").map((m) => m.hint);
    const changes = () => hints().filter((h, i, all) => i === 0 || all[i - 1] !== h);
    link.activity("working");
    expect(board.got).toEqual([]);
    board.plug();
    await until(() => link.ready && hints().length > 0);
    expect(board.sent("activity")[0]).toEqual({ v: 1, type: "activity", hint: "working" });
    await new Promise((r) => setTimeout(r, 20));
    const settled = hints().length;
    link.activity("working");
    expect(hints()).toHaveLength(settled);
    link.activity("idle");
    link.activity("idle");
    await until(() => hints().length === settled + 1);
    expect(changes()).toEqual(["working", "idle"]);
    board.unplug();
    link.activity("working");
    expect(changes()).toEqual(["working", "idle"]);
    board.plug();
    await until(() => changes().length === 3);
    expect(changes()).toEqual(["working", "idle", "working"]);
  });

  it("a new local offset (DST, travel) sends a fresh hello on the next hint", async () => {
    const { board, link } = await setup();
    board.plug();
    await until(() => link.ready);
    const hellos = board.sent("hello").length;
    link.activity("idle");
    expect(board.sent("hello")).toHaveLength(hellos);
    const moved = new Date().getTimezoneOffset() - 60;
    const spy = vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(moved);
    link.activity("idle");
    expect(board.sent("hello").at(-1)).toMatchObject({ tz: -moved });
    link.activity("idle");
    expect(board.sent("hello")).toHaveLength(hellos + 1);
    spy.mockRestore();
  });

  it("an unpaired board never gets the activity hint", async () => {
    const { board, link } = await setup({ paired: false });
    board.plug();
    await until(() => link.found);
    link.activity("working");
    await new Promise((r) => setTimeout(r, 20));
    expect(board.sent("activity")).toEqual([]);
  });

  it("uploads a card the board doesn't have, one chunk per card-progress, then knows it's stored", async () => {
    const { board, link } = await setup();
    const card = testCard();
    board.holdProgress = true;
    link.setCard(source(card));
    board.plug();
    await until(() => board.sent("card-chunk").length === 1);
    // Flow control: nothing more until the board acknowledges the chunk.
    await new Promise((r) => setTimeout(r, 30));
    expect(board.sent("card-chunk")).toHaveLength(1);
    board.holdProgress = false;
    board.release();
    await until(() => link.getSnapshot().card === "stored");
    expect(board.card).toBe(card.key);
    const begin = board.sent("card-begin")[0]!;
    expect(begin).toEqual({
      v: 1,
      type: "card-begin",
      key: card.key,
      x: 81,
      y: 298,
      w: 10,
      h: 10,
      frames: [...CARD_FRAMES],
    });
    const chunks = board.sent("card-chunk");
    expect(chunks).toHaveLength(Math.ceil((172 * 320 * 2) / CHUNK_BYTES) + 5);
    expect(chunks.every((c) => Buffer.from(c.data as string, "base64").length <= CHUNK_BYTES)).toBe(true);
    expect(board.sent("card-end")).toEqual([{ v: 1, type: "card-end", key: card.key }]);
  });

  it("doesn't upload what the board already stores, and converts a card once", async () => {
    const { board, link } = await setup();
    const card = testCard();
    board.card = card.key;
    const s = source(card);
    link.setCard(s);
    board.plug();
    await until(() => link.getSnapshot().card === "stored");
    board.emit({ v: 1, type: "hello", fw: "0.1.0", board: "b", w: 172, h: 320, card: card.key });
    await new Promise((r) => setTimeout(r, 20));
    expect(board.sent("card-begin")).toHaveLength(0);
    expect(s.calls).toBe(1);
  });

  it("retries after a failed hash ack and gives up after the attempts", async () => {
    const { board, link } = await setup({ attempts: 3 });
    const card = testCard();
    board.corrupt = 1;
    link.setCard(source(card));
    board.plug();
    await until(() => link.getSnapshot().card === "stored");
    expect(board.sent("card-begin")).toHaveLength(2);
    expect(board.card).toBe(card.key);

    const next = testCard(2);
    board.corrupt = 5;
    link.setCard(source(next));
    await until(() => link.getSnapshot().card === "failed");
    expect(board.sent("card-begin")).toHaveLength(2 + 3);
    expect(board.card).toBe(card.key);
  });

  it("stops on an unplug mid-upload and starts over when the board comes back", async () => {
    const { board, link } = await setup();
    const card = testCard();
    board.unplugAfterChunks = 10;
    link.setCard(source(card));
    board.plug();
    await until(() => link.getSnapshot().status.state === "absent" && board.sent("card-chunk").length === 10);
    await new Promise((r) => setTimeout(r, 400));
    expect(board.sent("card-begin")).toHaveLength(1);
    expect(board.card).toBeNull();
    board.plug();
    await until(() => link.getSnapshot().card === "stored");
    expect(board.sent("card-begin")).toHaveLength(2);
    expect(board.card).toBe(card.key);
  });

  it("retries when the board stops answering (it restarted mid-upload)", async () => {
    const { board, link } = await setup({ replyMs: 50 });
    const card = testCard();
    board.holdProgress = true;
    link.setCard(source(card));
    board.plug();
    await until(() => board.sent("card-begin").length === 2);
    board.holdProgress = false;
    board.release();
    await until(() => link.getSnapshot().card === "stored");
  });

  it("switches to a new card mid-upload", async () => {
    const { board, link } = await setup();
    const first = testCard(1);
    const second = testCard(2);
    board.holdProgress = true;
    link.setCard(source(first));
    board.plug();
    await until(() => board.sent("card-chunk").length === 1);
    link.setCard(source(second));
    board.holdProgress = false;
    board.release();
    await until(() => link.getSnapshot().card === "stored" && board.card === second.key);
  });

  it("hands on the board's tricks and only valid approval commands", async () => {
    const { board, link } = await setup();
    const tricks: string[] = [];
    const commands: unknown[] = [];
    link.onPet((t) => tricks.push(t));
    link.onCommand((c) => commands.push(c));
    board.plug();
    await until(() => link.ready);
    board.emit({ v: 1, type: "pet", trick: "spin" });
    board.emit({ v: 1, type: "next" });
    board.emit({ v: 1, type: "decide", aid: "a1", ticket: "short", allow: true });
    board.emit({ v: 1, type: "previous", extra: 1 });
    await until(() => tricks.length === 1 && commands.length === 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(tricks).toEqual(["spin"]);
    expect(commands).toEqual([{ v: 1, type: "next" }]);
  });
});

const snapshot = (over: Partial<Snapshot> = {}) =>
  ({
    status: "live",
    approvals: [],
    devices: [],
    sessions: [],
    notifications: [],
    events: {},
    ...over,
  }) as unknown as Snapshot;

describe("approval heartbeat", () => {
  it("writes an approval-console frame every second while the board is there, and stops on unplug", async () => {
    const { board, link } = await setup();
    board.plug();
    await until(() => link.ready);
    vi.useFakeTimers();
    const live = { subscribe: () => () => undefined, getSnapshot: () => snapshot() };
    const d = attachApprovalDisplay(live, { decide: async () => undefined }, link.approvalTransport());
    await vi.advanceTimersByTimeAsync(3500);
    const frames = board.sent("approval-console");
    expect(frames.length).toBeGreaterThanOrEqual(4);
    expect(frames[0]).toMatchObject({ v: 1, type: "approval-console", state: "empty", count: 0 });
    board.unplug();
    await vi.advanceTimersByTimeAsync(3000);
    expect(board.sent("approval-console")).toHaveLength(frames.length);
    d.close();
  });

  it("re-attaches on every hello and sends no timed alert for a new risky approval", async () => {
    const { board, link } = await setup();
    let snap = snapshot();
    const subs = new Set<() => void>();
    const live = { subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)), getSnapshot: () => snap };
    const off = attachBoardApprovals(link, { live, actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => board.sent("approval-console").length >= 1);
    snap = snapshot({ approvals: [{ aid: "a1", status: "pending", expiresAt: 10, risk: "HIGH" }] as never });
    for (const f of subs) f();
    await new Promise((r) => setTimeout(r, 200));
    expect(board.sent("alert")).toEqual([]);
    board.unplug();
    const before = board.sent("approval-console").length;
    board.plug();
    await until(() => board.sent("approval-console").length > before);
    off();
  });
});

describe("pairing", () => {
  const AID = "a1b2c3d4e5f6";
  const TICKET = "t".repeat(24);

  it("gives an unpaired board only hello and ignores everything it sends", async () => {
    const { board, link } = await setup({ paired: false });
    const got: unknown[] = [];
    link.onCommand((c) => got.push(c));
    link.onPet((t) => got.push(t));
    link.setCard(source(testCard()));
    const live = { subscribe: () => () => undefined, getSnapshot: () => snapshot() };
    const off = attachBoardApprovals(link, { live, actions: { decide: async () => undefined } } as never);
    board.plug();
    await until(() => link.found);
    link.mood("happy", 1000);
    link.alert("danger", 1000);
    board.emit({ v: 1, type: "next" });
    board.emit({ v: 1, type: "pet", trick: "spin" });
    board.emit({ v: 1, type: "decide", aid: AID, ticket: TICKET, allow: true, mac: "0".repeat(64) });
    await new Promise((r) => setTimeout(r, 1200));
    expect(link.ready).toBe(false);
    expect(new Set(board.got.map((m) => m.type))).toEqual(new Set(["hello"]));
    expect(got).toEqual([]);
    off();
  });

  it("pairs when the board confirms our code, then the board gets its card and frames", async () => {
    const { board, link, store } = await setup({ paired: false });
    link.setCard(source(testCard()));
    board.plug();
    await until(() => link.found);
    const result = link.pair();
    await until(() => board.pending !== null);
    expect(link.getSnapshot().pairing?.code).toBe(board.pending!.code);
    expect(board.pending!.secret).toHaveLength(32);
    board.confirmPairing();
    expect(await result).toBe("paired");
    expect((await store.load())?.keyId).toBe(board.keyId);
    await until(() => link.ready && link.getSnapshot().card === "stored");
    expect(link.getSnapshot().pairing).toBeNull();
  });

  it("a window that didn't pair sends the card once another window paired the board", async () => {
    const board = new FakeBoard();
    const store = memoryPairStore();
    const panel = new BoardLink(board, store, { replyMs: 300, minPairMs: 0 });
    const pet = new BoardLink(board, store, { replyMs: 300, minPairMs: 0 });
    panel.start();
    pet.start();
    pet.setCard(source(testCard()));
    board.plug();
    await until(() => panel.found && pet.found);
    const result = panel.pair();
    await until(() => board.pending !== null);
    board.confirmPairing();
    expect(await result).toBe("paired");
    await until(() => pet.ready && pet.getSnapshot().card === "stored");
    expect(board.card).toBe(testCard().key);
  });

  it("doesn't pair on a cancel, a wrong key id or silence past the timeout", async () => {
    expect(PAIR_TIMEOUT_MS).toBe(60_000);
    const { board, link, store } = await setup({ paired: false });
    const silent = await setup({ paired: false, pairMs: 50 });
    silent.board.plug();
    await until(() => silent.link.found);
    board.plug();
    await until(() => link.found);
    const cancelled = link.pair();
    await until(() => board.pending !== null);
    board.cancelPairing();
    expect(await cancelled).toBe("cancelled");

    const wrong = link.pair();
    await until(() => board.pending !== null);
    board.pending = null;
    board.emit({ v: 1, type: "pair-ok", pair: "0123456789abcdef" });
    expect(await wrong).toBe("failed");

    expect(await silent.link.pair()).toBe("timeout");
    expect(await store.load()).toBeNull();
    expect(link.ready).toBe(false);
  });

  it("keeps one paired board: a new pairing replaces the old secret", async () => {
    const { board, link, store } = await setup();
    board.plug();
    await until(() => link.ready);
    const old = (await store.load())!.keyId;
    board.autoConfirm = true;
    expect(await link.pair()).toBe("paired");
    const now = (await store.load())!.keyId;
    expect(now).not.toBe(old);
    expect(now).toBe(board.keyId);
    await until(() => link.ready);
  });

  it("drops a decide with a missing or wrong mac and passes a valid one on without it", async () => {
    const { board, link } = await setup();
    const got: unknown[] = [];
    link.onCommand((c) => got.push(c));
    board.plug();
    await until(() => link.ready);
    board.decide(AID, TICKET, true, null);
    board.decide(AID, TICKET, true, "f".repeat(64));
    // A mac for "deny" doesn't approve.
    const deny = (await import("node:crypto"))
      .createHmac("sha256", board.secret!)
      .update(`v1|decide|${AID}|${TICKET}|false`)
      .digest("hex");
    board.decide(AID, TICKET, true, deny);
    board.decide(AID, TICKET, true);
    board.emit({ v: 1, type: "previous" });
    await until(() => got.length === 2);
    expect(got).toEqual([
      { v: 1, type: "decide", aid: AID, ticket: TICKET, allow: true },
      { v: 1, type: "previous" },
    ]);
    expect(link.getSnapshot().rejected).toBe(3);
  });

  it("forgets the board: pair-reset sent, secret gone, nothing more for it", async () => {
    const { board, link, store } = await setup();
    board.plug();
    await until(() => link.ready);
    await link.forget();
    expect(board.sent("pair-reset")).toHaveLength(1);
    expect(await store.load()).toBeNull();
    await until(() => !link.ready);
    expect(link.getSnapshot().hasPairing).toBe(false);
    // Even with the board unplugged (it can't answer), the secret is deleted.
    const again = await setup();
    await again.link.forget();
    expect(await again.store.load()).toBeNull();
  });
});
