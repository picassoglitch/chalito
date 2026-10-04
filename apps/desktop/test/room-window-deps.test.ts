// @vitest-environment node
import { describe, expect, it } from "vitest";
import { generateBoxKeyPair, toB64url } from "@chalito/crypto";
import { BROWSER_SESSION_KEY, memoryStorage, type BrowserSupabase } from "@chalito/client";
import { newRoom } from "@chalito/rooms";
import { roomWindowDeps, type RoomWindowIo } from "../src/lib/room-window.js";

const io = async (o: { session?: boolean; account?: boolean; keys?: boolean; companion?: string | null } = {}) => {
  const storage = memoryStorage();
  if (o.session !== false) await storage.setItem(BROWSER_SESSION_KEY, JSON.stringify({ access_token: "at_panel" }));
  const box = await generateBoxKeyPair();
  const tokensSeen: (string | null)[] = [];
  const queries: unknown[][] = [];
  const db = {
    from: (t: string) => ({
      select: (c: string) => ({
        eq: (k: string, v: string) => ({
          maybeSingle: async () => {
            queries.push([t, c, k, v]);
            return { data: o.companion === null ? null : { companion_id: o.companion ?? "chl_me" }, error: null };
          },
        }),
      }),
    }),
  };
  const value: RoomWindowIo = {
    storage,
    loadKeys: async () => (o.keys === false ? null : { deviceId: "dev_desk", box }),
    account: () => (o.account === false ? null : { owner: "hub-user-1", passkey: null }),
    supabase: (token) => {
      void token().then((t) => tokensSeen.push(t));
      return db as unknown as BrowserSupabase;
    },
    api: () => ({ post: async () => undefined as never }),
  };
  return { value, box, tokensSeen, queries };
};

describe("room window connection (borrows the panel's session)", () => {
  it("null until the panel has a session, this device's keys and its account", async () => {
    expect(await roomWindowDeps((await io({ session: false })).value)).toBeNull();
    expect(await roomWindowDeps((await io({ keys: false })).value)).toBeNull();
    expect(await roomWindowDeps((await io({ account: false })).value)).toBeNull();
    expect(await roomWindowDeps((await io({ companion: null })).value)).toBeNull();
  });

  it("uses the panel's token, finds this owner's companion, and unwraps room keys inside the vault's box", async () => {
    const i = await io();
    const deps = (await roomWindowDeps(i.value))!;
    expect(deps).toMatchObject({ deviceId: "dev_desk", companionId: "chl_me" });
    expect(i.queries).toEqual([["companions", "companion_id", "owner", "hub-user-1"]]);
    await new Promise((r) => setTimeout(r, 0));
    expect(i.tokensSeen).toEqual(["at_panel"]);
    const room = await newRoom({
      roomId: "r1",
      type: "family",
      name: "Casa",
      companionId: "chl_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      myDevices: [{ deviceId: "dev_desk", pubBox: await toB64url(i.box.publicKey) }],
    });
    const ring = await deps.keyring([{ epoch: 1, ct: room.request.wrappedKeys["dev_desk"]! }]);
    expect([...ring.get(1)!]).toEqual([...room.key]);
  });
});
