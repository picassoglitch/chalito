import { describe, expect, it } from "vitest";
import { generateBoxKeyPair, toB64url } from "@chalito/crypto";
import {
  RoomController,
  bodyText,
  createRoom,
  joinRoom,
  myRooms,
  roomList,
  newRoom,
  reportBody,
  rotateRoom,
  sealRoomEvent,
  unwrapKeyring,
  type RoomEventRow,
  type RoomsDb,
} from "../src/index.js";

const ME = "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOM = "chl_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROOM = "room_1";

/** Tables with eq/gt/order, plus one private channel whose pointers the test sends. */
const fakeDb = () => {
  const tables: Record<string, Record<string, unknown>[]> = {
    rooms: [],
    room_members: [],
    room_member_keys: [],
    room_events: [],
  };
  let handler: ((msg: { payload?: unknown }) => void) | null = null;
  let onSub: ((s: string) => void) | null = null;
  const removed: unknown[] = [];
  const query = (table: string, filters: [string, unknown, "eq" | "gt"][]) => {
    const run = () => {
      let rows = tables[table]!.filter((r) =>
        filters.every(([c, v, op]) => (op === "eq" ? r[c] === v : Number(r[c]) > Number(v))),
      );
      rows = [...rows].sort((a, b) => Number(a.rev ?? 0) - Number(b.rev ?? 0));
      return { data: rows, error: null };
    };
    const q = {
      eq: (c: string, v: unknown) => query(table, [...filters, [c, v, "eq"]]),
      gt: (c: string, v: unknown) => query(table, [...filters, [c, v, "gt"]]),
      order: () => q,
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  const db = {
    realtime: { setAuth: async () => undefined },
    channel: () => {
      const ch = {
        on: (_t: string, _f: unknown, cb: (msg: { payload?: unknown }) => void) => ((handler = cb), ch),
        subscribe: (cb?: (s: string) => void) => {
          onSub = cb ?? null;
          queueMicrotask(() => onSub?.("SUBSCRIBED"));
          return ch;
        },
      };
      return ch;
    },
    removeChannel: async (ch: unknown) => void removed.push(ch),
    from: (table: string) => ({ select: () => query(table, []) }),
  } as unknown as RoomsDb;
  return { db, tables, removed, send: (payload: unknown) => handler?.({ payload }) };
};

const tick = () => new Promise((r) => setTimeout(r, 15));

const setup = async (o: { member?: boolean; owner?: boolean; signer?: boolean } = {}) => {
  const f = fakeDb();
  const box = await generateBoxKeyPair();
  const me = { deviceId: "dev_me", pubBox: await toB64url(box.publicKey) };
  const created = await newRoom({ roomId: ROOM, type: "family", name: "Casa", companionId: ME, myDevices: [me] });
  f.tables.rooms!.push({ room_id: ROOM, name: "Casa", type: "family" });
  f.tables.room_members!.push({ room_id: ROOM, companion_id: MOM, role: o.owner ? "member" : "owner" });
  if (o.member !== false)
    f.tables.room_members!.push({ room_id: ROOM, companion_id: ME, role: o.owner ? "owner" : "member" });
  f.tables.room_member_keys!.push({
    room_id: ROOM,
    device_id: "dev_me",
    epoch: 1,
    ct: created.request.wrappedKeys["dev_me"],
  });
  let rev = 0;
  /** Mom posts: sealed with `key` at `epoch`, stored, and a pointer goes out. */
  const momPosts = async (
    body: Parameters<typeof sealRoomEvent>[0]["body"],
    key = created.key,
    epoch = 1,
    extra: Partial<RoomEventRow> = {},
  ) => {
    const req = await sealRoomEvent({ roomId: ROOM, epoch, key, eid: `e${++rev}`, companionId: MOM, body, to: [ME] });
    f.tables.room_events!.push({
      room_id: ROOM,
      eid: req.eid,
      from_companion_id: MOM,
      to_companions: req.to,
      kind: req.kind,
      urgency: req.urgency,
      ct: req.ct,
      key_epoch: epoch,
      promoted: false,
      t: 1_000 + rev,
      expires_at: null,
      rev,
      ...extra,
    });
    f.send({ table: "room_events", op: "insert", key: { room_id: ROOM, eid: req.eid } });
    await tick();
  };
  const posted: { path: string; body: unknown }[] = [];
  /** Answers by path suffix (the api's JSON), for routes that return something. */
  const answers: Record<string, unknown> = {};
  let fail: { status: number } | null = null;
  let clock = 5_000;
  const keyringCalls: number[] = [];
  const seen: number[] = [];
  const session = new RoomController({
    db: f.db,
    api: {
      post: async <T>(path: string, body: unknown) => {
        if (fail) throw Object.assign(new Error("api"), fail);
        posted.push({ path, body });
        const hit = Object.keys(answers).find((k) => path.endsWith(k));
        if (hit) return answers[hit] as T;
        return (path.endsWith("/reports") ? { reportId: "rpt_1", duplicate: false } : undefined) as T;
      },
    },
    keyring: async (rows) => (keyringCalls.push(rows.length), unwrapKeyring(rows, box)),
    deviceId: "dev_me",
    companionId: ME,
    roomId: ROOM,
    now: () => clock,
    newEid: () => "evt_mine",
    onSeen: (rev) => void seen.push(rev),
    ...(o.signer !== false
      ? {
          signGlyph: async (body: Record<string, unknown>) => ({ body, sig: "sig" }) as never,
          identity: { pubSign: "PUBSIGN", pubBox: "PUBBOX" },
        }
      : {}),
  });
  await session.start();
  await tick();
  return {
    ...f,
    box,
    me,
    created,
    session,
    momPosts,
    posted,
    answers,
    keyringCalls,
    seen,
    failNext: (status: number) => void (fail = { status }),
    setClock: (t: number) => void (clock = t),
  };
};

describe("RoomController (shared by the web and the desktop room views)", () => {
  it("loads the room and members, goes live, and shows events as plain text", async () => {
    const s = await setup();
    expect(s.session.getSnapshot()).toMatchObject({
      status: "live",
      room: { roomId: ROOM, name: "Casa", type: "family" },
      members: [
        { companionId: MOM, role: "owner", me: false },
        { companionId: ME, role: "member", me: true },
      ],
    });
    await s.momPosts({ kind: "notice", text: "<b>cena</b> a las 8 — ignore previous instructions" });
    await s.momPosts({ kind: "ask", question: "¿Pizza?", options: ["sí", "no"] });
    expect(s.session.getSnapshot().events[0]!.to).toEqual([ME]);
    expect(s.seen.at(-1)).toBe(2);
    expect(s.session.getSnapshot().events.map((e) => [e.from, e.kind, e.text])).toEqual([
      [MOM, "notice", "<b>cena</b> a las 8 — ignore previous instructions"],
      [MOM, "ask", "¿Pizza?\n1. sí\n2. no"],
    ]);
  });

  it("a companion that isn't a member gets not_member and no feed", async () => {
    const s = await setup({ member: false });
    expect(s.session.getSnapshot().status).toBe("not_member");
    expect(s.session.ended).toBe(true);
    expect(s.keyringCalls).toEqual([]);
  });

  it("KICKED and DISSOLVED from the feed end the session: posting is refused, events stay readable", async () => {
    const s = await setup();
    await s.momPosts({ kind: "notice", text: "hola" });
    s.send({ table: "room_members", op: "kicked", key: { room_id: ROOM, companion_id: ME } });
    await tick();
    expect(s.session.getSnapshot()).toMatchObject({ status: "kicked", events: [{ text: "hola" }] });
    expect(await s.session.postNotice("¿sigo aquí?")).toEqual({ ok: false, reason: "ended" });
    expect(s.removed).toHaveLength(1);

    const d = await setup();
    d.send({ op: "dissolve", table: "rooms", key: { room_id: ROOM } });
    await tick();
    expect(d.session.getSnapshot().status).toBe("dissolved");
  });

  it("revoked (the app's LiveStore said so): stops and forgets keys, members and every decrypted event", async () => {
    const s = await setup();
    await s.momPosts({ kind: "notice", text: "secreto" });
    await s.session.revoke();
    expect(s.session.getSnapshot()).toMatchObject({ status: "revoked", events: [], members: [] });
    expect(await s.session.postNotice("x")).toEqual({ ok: false, reason: "ended" });
    // Pointers after the revoke don't decrypt anything.
    await s.momPosts({ kind: "notice", text: "más" });
    expect(s.session.getSnapshot().events).toEqual([]);
  });

  it("posts a notice sealed with the newest epoch, then after a rekey reads the new key once", async () => {
    const s = await setup();
    expect(await s.session.postNotice("voy")).toEqual({ ok: true });
    expect(s.posted[0]).toMatchObject({
      path: `/v1/rooms/${ROOM}/events`,
      body: { eid: "evt_mine", companionId: ME, kind: "notice", keyEpoch: 1 },
    });
    const rot = await rotateRoom({ companionId: MOM, currentEpoch: 1, remaining: { [ME]: [s.me] } });
    s.tables.room_member_keys!.push({
      room_id: ROOM,
      device_id: "dev_me",
      epoch: 2,
      ct: rot.request.wrappedKeys[ME]![s.me.deviceId],
    });
    await s.momPosts({ kind: "notice", text: "nueva clave" }, rot.key, 2);
    expect(s.session.getSnapshot().events.at(-1)!.text).toBe("nueva clave");
    expect(s.keyringCalls).toEqual([1, 2]);
    expect(await s.session.postNotice("ok")).toEqual({ ok: true });
    expect(s.posted.at(-1)!.body).toMatchObject({ keyEpoch: 2 });
  });

  it("an event this device can't open shows as null text (not dropped, not guessed)", async () => {
    const s = await setup();
    const other = await newRoom({ roomId: ROOM, type: "family", name: "x", companionId: MOM, myDevices: [] });
    await s.momPosts({ kind: "notice", text: "no para ti" }, other.key, 1);
    expect(s.session.getSnapshot().events.at(-1)!.text).toBeNull();
  });

  it("expired events are hidden, and prune() drops them as time passes", async () => {
    const s = await setup();
    await s.momPosts({ kind: "notice", text: "efímero" }, undefined, 1, { expires_at: 6_000 });
    await s.momPosts({ kind: "notice", text: "ya expiró" }, undefined, 1, { expires_at: 4_000 });
    expect(s.session.getSnapshot().events.map((e) => e.text)).toEqual(["efímero"]);
    s.setClock(6_001);
    s.session.prune();
    expect(s.session.getSnapshot().events).toEqual([]);
  });

  it("leave: posts it and ends the session as kicked; reports go to the reports API", async () => {
    const s = await setup();
    await s.momPosts({ kind: "notice", text: "spam spam" });
    expect(
      await s.session.report({ eventId: "e1", reason: "spam", note: "  molesto ", attachText: "spam spam" }),
    ).toEqual({ ok: true, duplicate: false });
    expect(s.posted.at(-1)).toEqual({
      path: `/v1/rooms/${ROOM}/reports`,
      body: {
        companionId: ME,
        eventId: "e1",
        reason: "spam",
        note: "molesto",
        attachedPlaintext: "spam spam",
        attachPlaintext: true,
      },
    });
    expect(await s.session.leave()).toEqual({ ok: true });
    expect(s.posted.at(-1)).toEqual({ path: `/v1/rooms/${ROOM}/leave`, body: { companionId: ME } });
    expect(s.session.getSnapshot().status).toBe("kicked");
    s.failNext(429);
    expect(await s.session.report({ memberCompanionId: MOM, reason: "abuse" })).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });
});

describe("RoomController: managing a room", () => {
  it("reads the key epoch, a pending rotation and the retention from the room row (defaults when absent)", async () => {
    const t = await setup();
    expect(t.session.getSnapshot().room).toMatchObject({
      keyEpoch: 1,
      needsRotation: false,
      retention: { ephemeralTtl: "PT24H", keepPromoted: true },
    });
    Object.assign(t.tables.rooms![0]!, {
      key_epoch: 3,
      needs_rotation: true,
      ephemeral_ttl: "P7D",
      keep_promoted: false,
    });
    await t.session.refresh();
    expect(t.session.getSnapshot().room).toMatchObject({
      keyEpoch: 3,
      needsRotation: true,
      retention: { ephemeralTtl: "P7D", keepPromoted: false },
    });
  });

  it("invite: a room_invite glyph signed by this device, posted for a short code", async () => {
    const t = await setup();
    t.answers["/invites"] = { inviteId: "x", shortCode: "KQ7R-M2XZ", expiresAt: 9 };
    const r = await t.session.invite();
    expect(r).toMatchObject({ ok: true, invite: { shortCode: "KQ7R-M2XZ", expiresAt: 9 } });
    const sent = t.posted.at(-1)!;
    expect(sent.path).toBe(`/v1/rooms/${ROOM}/invites`);
    const body = sent.body as { companionId: string; maxUses: number; glyph: { body: Record<string, unknown> } };
    expect(body.companionId).toBe(ME);
    expect(body.maxUses).toBe(1);
    expect(body.glyph.body).toMatchObject({
      purpose: "room_invite",
      issuerPubSign: "PUBSIGN",
      issuerPubBox: "PUBBOX",
      label: "Casa",
      issuedAt: 5_000,
      expiresAt: 5_000 + 7 * 86_400_000,
    });
    expect(body.glyph.body.codeId).toMatch(/^inv_[0-9a-f]{32}$/);
    const unsigned = await setup({ signer: false });
    expect(await unsigned.session.invite()).toEqual({ ok: false, reason: "unsupported" });
  });

  it("retention and dissolve are the owner's; a member is refused before asking the api", async () => {
    const member = await setup();
    expect(await member.session.setRetention({ ephemeralTtl: "P7D", keepPromoted: false })).toEqual({
      ok: false,
      reason: "not_owner",
    });
    expect(await member.session.dissolve()).toEqual({ ok: false, reason: "not_owner" });
    expect(member.posted).toEqual([]);

    const owner = await setup({ owner: true });
    owner.answers["/retention"] = { retention: { ephemeralTtl: "P7D", keepPromoted: false } };
    expect(await owner.session.setRetention({ ephemeralTtl: "P7D", keepPromoted: false })).toEqual({ ok: true });
    expect(owner.posted.at(-1)).toEqual({
      path: `/v1/rooms/${ROOM}/retention`,
      body: { companionId: ME, retention: { ephemeralTtl: "P7D", keepPromoted: false } },
    });
    expect(owner.session.getSnapshot().room!.retention).toEqual({ ephemeralTtl: "P7D", keepPromoted: false });
    expect(await owner.session.dissolve()).toEqual({ ok: true });
    expect(owner.posted.at(-1)!.path).toBe(`/v1/rooms/${ROOM}/dissolve`);
    expect(owner.session.getSnapshot().status).toBe("dissolved");
  });

  it("rotateKey: epoch + 1, wrapped to exactly the remaining members' devices", async () => {
    const t = await setup();
    const momBox = await generateBoxKeyPair();
    const mom = { deviceId: "dev_mom", pubBox: await toB64url(momBox.publicKey) };
    t.answers[`/members/${MOM}/devices`] = { devices: [mom] };
    t.answers[`/members/${ME}/devices`] = { devices: [t.me] };
    const r = await t.session.rotateKey();
    expect(r).toEqual({ ok: true, epoch: 2 });
    const rotate = t.posted.find((p) => p.path.endsWith("/rotate"))!;
    const body = rotate.body as {
      companionId: string;
      epoch: number;
      wrappedKeys: Record<string, Record<string, string>>;
    };
    expect(body.companionId).toBe(ME);
    expect(body.epoch).toBe(2);
    expect(Object.keys(body.wrappedKeys).sort()).toEqual([ME, MOM].sort());
    expect(Object.keys(body.wrappedKeys[MOM]!)).toEqual(["dev_mom"]);
    // Mom's device can open the new key; ours too.
    const ring = await unwrapKeyring([{ epoch: 2, ct: body.wrappedKeys[MOM]!["dev_mom"]! }], momBox);
    expect(ring.get(2)).toHaveLength(32);
  });

  it("a rotation someone else already did is a conflict", async () => {
    const t = await setup();
    t.answers[`/members/${MOM}/devices`] = { devices: [] };
    t.answers[`/members/${ME}/devices`] = { devices: [t.me] };
    t.failNext(409);
    expect(await t.session.rotateKey()).toEqual({ ok: false, reason: "conflict" });
  });
});

describe("createRoom", () => {
  it("wraps epoch 1 to this owner's client devices and creates the room as this companion", async () => {
    const box = await generateBoxKeyPair();
    const other = await generateBoxKeyPair();
    const devices = [
      { deviceId: "dev_me", pubBox: await toB64url(box.publicKey) },
      { deviceId: "dev_tablet", pubBox: await toB64url(other.publicKey) },
    ];
    const posted: { path: string; body: Record<string, unknown> }[] = [];
    const api = {
      post: async <T>(path: string, body: unknown) => (posted.push({ path, body: body as never }), {} as T),
    };
    const r = await createRoom(api, {
      companionId: ME,
      name: "  Casa  ",
      type: "family",
      myDevices: devices,
      roomId: "room_x",
    });
    expect(r).toEqual({ ok: true, roomId: "room_x" });
    expect(posted[0]!.path).toBe("/v1/rooms");
    expect(posted[0]!.body).toMatchObject({ roomId: "room_x", name: "Casa", type: "family", companionId: ME });
    const wrapped = posted[0]!.body.wrappedKeys as Record<string, string>;
    expect(Object.keys(wrapped).sort()).toEqual(["dev_me", "dev_tablet"]);
    const mine = await unwrapKeyring([{ epoch: 1, ct: wrapped["dev_me"]! }], box);
    const theirs = await unwrapKeyring([{ epoch: 1, ct: wrapped["dev_tablet"]! }], other);
    expect(mine.get(1)).toEqual(theirs.get(1));
  });

  it("maps the plan's room limit, rate limits, and no devices", async () => {
    const box = await generateBoxKeyPair();
    const dev = [{ deviceId: "dev_me", pubBox: await toB64url(box.publicKey) }];
    const failing = (status: number) => ({
      post: async () => Promise.reject(Object.assign(new Error("x"), { status })),
    });
    const input = { companionId: ME, name: "Casa", type: "family" as const, myDevices: dev };
    expect(await createRoom(failing(402), input)).toEqual({ ok: false, reason: "limit" });
    expect(await createRoom(failing(429), input)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await createRoom(failing(500), input)).toEqual({ ok: false, reason: "failed" });
    expect(await createRoom(failing(500), { ...input, myDevices: [] })).toEqual({ ok: false, reason: "no_devices" });
  });
});

describe("myRooms", () => {
  it("lists only this companion's rooms, by name", async () => {
    const f = fakeDb();
    f.tables.rooms!.push(
      { room_id: "r1", name: "Trabajo", type: "business" },
      { room_id: "r2", name: "Casa", type: "family" },
      { room_id: "r3", name: "Ajena", type: "project" },
    );
    f.tables.room_members!.push(
      { room_id: "r1", companion_id: ME, role: "member" },
      { room_id: "r2", companion_id: ME, role: "owner" },
      { room_id: "r3", companion_id: MOM, role: "owner" },
    );
    expect(await myRooms(f.db, ME)).toEqual([
      { roomId: "r2", name: "Casa", type: "family" },
      { roomId: "r1", name: "Trabajo", type: "business" },
    ]);
  });
});

describe("roomList and joinRoom", () => {
  it("member counts, and an unread dot only for others' events above what this device showed", async () => {
    const f = fakeDb();
    f.tables.rooms!.push(
      { room_id: "r1", name: "Casa", type: "family" },
      { room_id: "r2", name: "Obra", type: "project" },
    );
    f.tables.room_members!.push(
      { room_id: "r1", companion_id: ME, role: "member" },
      { room_id: "r1", companion_id: MOM, role: "owner" },
      { room_id: "r2", companion_id: ME, role: "owner" },
    );
    f.tables.room_events!.push(
      { room_id: "r1", eid: "a", from_companion_id: MOM, rev: 3 },
      { room_id: "r2", eid: "b", from_companion_id: ME, rev: 9 },
    );
    const seen: Record<string, number> = { r1: 2, r2: 0 };
    expect(await roomList(f.db, ME, (id) => seen[id] ?? 0)).toEqual([
      { roomId: "r1", name: "Casa", type: "family", memberCount: 2, unread: true },
      { roomId: "r2", name: "Obra", type: "project", memberCount: 1, unread: false },
    ]);
    seen.r1 = 3;
    expect((await roomList(f.db, ME, (id) => seen[id] ?? 0))[0]!.unread).toBe(false);
  });

  it("join maps the api's refusals", async () => {
    const posted: unknown[] = [];
    const api = (status?: number) => ({
      post: async <T>(path: string, body: unknown) => {
        if (status) throw Object.assign(new Error("x"), { status });
        posted.push([path, body]);
        return { roomId: "r9" } as T;
      },
    });
    expect(await joinRoom(api(), ME, "  ABCD-EFGH  ")).toEqual({ ok: true, roomId: "r9" });
    expect(posted).toEqual([["/v1/rooms/join", { companionId: ME, shortCode: "ABCD-EFGH" }]]);
    expect(await joinRoom(api(), ME, "short")).toEqual({ ok: false, reason: "bad_code" });
    for (const [status, reason] of [
      [404, "bad_code"],
      [410, "bad_code"],
      [402, "full"],
      [429, "rate_limited"],
      [500, "failed"],
    ] as const)
      expect(await joinRoom(api(status), ME, "ABCD-EFGH")).toEqual({ ok: false, reason });
  });
});

describe("bodyText and reportBody", () => {
  it("every kind is plain text", () => {
    expect(
      bodyText({ kind: "event_proposal", title: "Comida", when: "2026-10-04T14:00:00-06:00", where: "Casa" }),
    ).toBe("Comida · 2026-10-04T14:00:00-06:00 · Casa");
    expect(bodyText({ kind: "ack", ref: "e1", choice: 1 })).toBe("#2");
    expect(bodyText({ kind: "presence", state: "busy" })).toBe("busy");
    expect(bodyText({ kind: "enter" })).toBe("");
  });

  it("plaintext only with an event and an explicit opt-in", () => {
    expect(reportBody(ME, { memberCompanionId: MOM, reason: "abuse", attachText: "x" })).toEqual({
      companionId: ME,
      memberCompanionId: MOM,
      reason: "abuse",
    });
    expect(reportBody(ME, { eventId: "e1", reason: "other" })).toEqual({
      companionId: ME,
      eventId: "e1",
      reason: "other",
    });
  });
});
