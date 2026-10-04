/** This owner's companion (one per account), or null. */
export const companionIdFor = async (db: unknown, owner: string): Promise<string | null> => {
  const { data, error } = await (
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
  return !error && typeof data?.companion_id === "string" ? data.companion_id : null;
};
