import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresAvatarRepo } from "../src/avatar/repo.js";

/**
 * Co-members' custom cards (chalito_private.room_member_cards, migration 20261005000200) as
 * CHALITO_DB_ROLE: only a caller who is in the room right now gets anyone's card.
 */
const url = process.env.DATABASE_URL;
const role = process.env.CHALITO_DB_ROLE;

if (!url) {
  describe("PostgresAvatarRepo.roomCards", () => it.skip("needs DATABASE_URL", () => {}));
} else {
  const admin = postgres(url, { onnotice: () => {} });
  const sql = postgres(url, { max: 4, onnotice: () => {}, ...(role ? { connection: { role } } : {}) });
  afterAll(async () => {
    await sql.end();
    await admin.end();
  });
  const repo = new PostgresAvatarRepo(sql);
  const MANIFEST = { emotions: { mode: "swap", src: { neutral: "layer-neutral.webp" } }, thumbs: {} };
  const hex = () => randomUUID().replace(/-/g, "");
  /** chl_ + 26 of [a-z2-7] (the companions check). */
  const companionId = () =>
    `chl_${[...hex(), ...hex()]
      .slice(0, 26)
      .map((h) => "abcdefghijklmnopqrstuvwxyz234567"[parseInt(h, 16) * 2]!)
      .join("")}`;

  /** A user with a companion; with `custom`, wearing a succeeded custom card. */
  const person = async (custom: boolean) => {
    const u = `cards-${randomUUID()}`;
    const companion = companionId();
    await admin`insert into chalito.tenants (id) values (${u})`;
    await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${u}, ${u}, 'pro', 'America/Mexico_City')`;
    await admin`insert into chalito.companions (owner, companion_id, name) values (${u}, ${companion}, 'Chalito')`;
    const assetId = hex();
    if (custom) {
      await admin`
        insert into chalito.avatar_creations
          (creation_id, owner, asset_id, status, free, content_type, manifest, upload_deadline)
        values (${`cr_${hex()}`}, ${u}, ${assetId}, 'succeeded', true, 'image/png', ${admin.json(MANIFEST)}, now())`;
      await admin`update chalito.companions set asset_id = ${assetId} where owner = ${u}`;
    }
    return { u, companion, assetId };
  };
  const room = async (members: { u: string; companion: string }[]) => {
    const roomId = `room_${hex().slice(0, 20)}`;
    const [owner] = members;
    await admin`insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id)
      values (${roomId}, 'family', 'Casa', ${owner!.u}, ${owner!.companion})`;
    for (const [i, m] of members.entries())
      await admin`insert into chalito.room_members (room_id, companion_id, uid, role)
        values (${roomId}, ${m.companion}, ${m.u}, ${i === 0 ? "owner" : "member"})`;
    return roomId;
  };

  describe("PostgresAvatarRepo.roomCards", () => {
    it("members get the room's custom cards; a non-member, another room's member or a leaver gets none", async () => {
      const me = await person(false);
      const mom = await person(true);
      const stranger = await person(true);
      const fam = await room([me, mom]);
      const other = await room([stranger]);

      expect(await repo.roomCards(me.u, fam)).toEqual([
        { companionId: mom.companion, owner: mom.u, assetId: mom.assetId, manifest: MANIFEST },
      ]);
      expect(await repo.roomCards(stranger.u, fam)).toEqual([]);
      expect(await repo.roomCards(me.u, other)).toEqual([]);
      expect(await repo.roomCards(me.u, "room_does_not_exist")).toEqual([]);

      await admin`delete from chalito.room_members where room_id = ${fam} and uid = ${me.u}`;
      expect(await repo.roomCards(me.u, fam)).toEqual([]);
    });

    it("a card that is no longer worn (back to a roster avatar) isn't handed out", async () => {
      const me = await person(false);
      const mom = await person(true);
      const fam = await room([me, mom]);
      await admin`update chalito.companions set avatar = 'luna' where owner = ${mom.u}`; // clears asset_id
      expect(await repo.roomCards(me.u, fam)).toEqual([]);
    });

    it("clients can't call it directly", async () => {
      const [r] = await admin<{ ok: boolean }[]>`
        select has_function_privilege('authenticated', 'chalito_private.room_member_cards(text, text)', 'execute') as ok`;
      expect(r!.ok).toBe(false);
    });
  });
}
