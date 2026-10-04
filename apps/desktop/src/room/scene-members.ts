import { COMPANIONS, DEFAULT_COMPANION } from "@chalito/ui";
import type { RoomMemberView } from "@chalito/rooms";
import type { RoomSceneMember } from "@chalito/scene";

type Rows = PromiseLike<{ data: Record<string, unknown>[] | null; error: unknown }>;
type Db = { from(t: string): { select(c: string): { eq(c: string, v: unknown): Rows } } };

const card = (v: unknown) => ((COMPANIONS as readonly string[]).includes(String(v)) ? String(v) : DEFAULT_COMPANION);

/**
 * Room members as the scene draws them: a roster card each. Co-members' companions come from
 * companion_directory (what co-members may see of each other); an unknown or missing card is the
 * default companion. Cosmetics: none yet (no shared source for another owner's equipped items).
 */
export const sceneMembersFor = async (db: unknown, members: readonly RoomMemberView[]): Promise<RoomSceneMember[]> => {
  const d = db as Db;
  const out: RoomSceneMember[] = [];
  for (const m of members) {
    const { data } = await d
      .from("companion_directory")
      .select("companion_id, avatar_thumb")
      .eq("companion_id", m.companionId);
    out.push({ companionId: m.companionId, avatar: card(data?.[0]?.avatar_thumb), presence: "online" });
  }
  return out;
};
