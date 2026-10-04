import type { SupabaseClient } from "@supabase/supabase-js";

/** Who is calling: a Chalito client device (Supabase Auth device user, app_metadata.chalito). */
export interface Caller {
  owner: string;
  deviceId: string;
  role: string;
}

export interface Authn {
  verify(token: string): Promise<Caller>;
}

export class SupabaseAuthn implements Authn {
  constructor(private readonly auth: SupabaseClient["auth"]) {}
  async verify(token: string): Promise<Caller> {
    const { data, error } = await this.auth.getUser(token);
    if (error || !data.user) throw new Error("unauthenticated");
    const c = (data.user.app_metadata as { chalito?: Record<string, unknown> }).chalito ?? {};
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return { owner: str(c.owner), deviceId: str(c.device_id), role: str(c.role) };
  }
}
