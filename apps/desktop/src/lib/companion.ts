const companionRow = async (db: unknown, owner: string) =>
  (
    db as {
      from(t: "companions"): {
        select(c: "companion_id"): {
          eq(
            c: "owner",
            v: string,
          ): {
            maybeSingle(): PromiseLike<{ data: { companion_id?: unknown } | null; error: unknown }>;
          };
        };
      };
    }
  )
    .from("companions")
    .select("companion_id")
    .eq("owner", owner)
    .maybeSingle();

/** This owner's companion (one per account), or null. */
export const companionIdFor = async (db: unknown, owner: string): Promise<string | null> => {
  const { data, error } = await companionRow(db, owner);
  return !error && typeof data?.companion_id === "string" ? data.companion_id : null;
};

/** Like companionIdFor, but a failed query (offline, 5xx, expired JWT) throws: null only when there's no row. */
export const companionIdOrThrow = async (db: unknown, owner: string): Promise<string | null> => {
  const { data, error } = await companionRow(db, owner);
  if (error) throw new Error("companion lookup failed");
  return typeof data?.companion_id === "string" ? data.companion_id : null;
};
