import { createHash } from "node:crypto";
import type { AuthClient, User } from "@supabase/supabase-js";
import type { IdentityClaims, IdentityIssuer } from "../repo.js";

/**
 * IdentityIssuer over Supabase Auth (the hub project, ADR 0017): every device, and every
 * pairing watch, is its own Auth user whose `app_metadata.chalito` = {owner, device_id, role,
 * pairing_code?} carries the claims RLS reads (`chalito.jwt_claims()`, claim_source
 * 'app_metadata'). Its id is `chalitoAuthUserId(...)`, which PostgresRepo also writes to
 * devices.auth_user_id / pairing_codes.watch_auth_user_id (RLS requires sub = that id). People are their own hub
 * users. Minting returns a magic-link token hash; the client exchanges it with
 * `auth.verifyOtp({ token_hash, type: "magiclink" })` for a session.
 *
 * Needs an AuthClient authorised with the service (secret) key: server only.
 */
type Auth = InstanceType<typeof AuthClient>;

/** ~100 years: Supabase Auth bans take a duration, not "forever". */
const BAN_FOREVER = "876000h";
const ROLES = new Set(["client", "agent", "pairing"]);

/**
 * Deterministic Auth user id (UUID v5) for a device or pairing code: minting twice finds the
 * same user, with no lookup table and no race. The email uses the same hex, because Auth
 * lower-cases emails and Chalito ids are case-sensitive.
 */
export const chalitoAuthUserId = (kind: "device" | "pairing", id: string): string => {
  const h = createHash("sha1").update(`chalito:${kind}:${id}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

const emailFor = (kind: "device" | "pairing", authUserId: string) =>
  `${authUserId}@${kind === "device" ? "devices" : "pairing"}.chalito.invalid`;

export class SupabaseIssuer implements IdentityIssuer {
  constructor(private readonly auth: Auth) {}

  /** The hub user's own account: a magic link for their email, no Chalito claims added. */
  async mintUser(owner: string, _tier: string) {
    const { data, error } = await this.auth.admin.getUserById(owner);
    if (error || !data.user?.email) throw new Error(`hub user ${owner} not found`, { cause: error });
    return this.#magicLink(data.user.email);
  }

  async mintDevice(owner: string, deviceId: string, role: "client" | "agent") {
    const id = chalitoAuthUserId("device", deviceId);
    await this.#ensureUser(id, emailFor("device", id), { owner, device_id: deviceId, role });
    return this.#magicLink(emailFor("device", id));
  }

  async mintPairingWatch(codeId: string) {
    const id = chalitoAuthUserId("pairing", codeId);
    await this.#ensureUser(id, emailFor("pairing", id), {
      owner: "pairing",
      pairing_code: codeId,
      role: "pairing",
    });
    return this.#magicLink(emailFor("pairing", id));
  }

  /** Deletes a pairing watch's Auth user (after the claim, or once the code expired). */
  async releasePairingWatch(codeId: string) {
    await this.auth.admin.deleteUser(chalitoAuthUserId("pairing", codeId)).catch(() => undefined);
  }

  async verify(token: string): Promise<IdentityClaims> {
    if (!token) throw new Error("unauthenticated");
    const { data, error } = await this.auth.getUser(token);
    if (error || !data.user) throw new Error("unauthenticated", { cause: error });
    return claimsOf(data.user);
  }

  /**
   * Bans the device's Auth user, so it can't refresh or get a new session. supabase-js has
   * no sign-out by user id (admin.signOut takes a session JWT); an access token already
   * issued stays valid until it expires, and RLS (device_ok) plus the API's revoked check
   * cut it off meanwhile.
   */
  async disableDevice(deviceId: string) {
    // supabase-js reports failures as `{ error }`, not by throwing: check it (R-L10).
    const res = await this.auth.admin
      .updateUserById(chalitoAuthUserId("device", deviceId), { ban_duration: BAN_FOREVER })
      .catch((err: unknown) => ({ error: err }));
    if (res.error) {
      console.error("[api] device ban failed", deviceId, res.error instanceof Error ? res.error.message : "error");
      return false;
    }
    return true;
  }

  async deleteDevice(deviceId: string) {
    const { error } = await this.auth.admin.deleteUser(chalitoAuthUserId("device", deviceId));
    if (error && (error as { status?: number }).status !== 404) throw error;
  }

  async #ensureUser(id: string, email: string, chalito: Record<string, string>) {
    const existing = await this.auth.admin.getUserById(id);
    if (existing.data.user) {
      const cur = (existing.data.user.app_metadata as { chalito?: Record<string, string> }).chalito;
      if (JSON.stringify(cur) !== JSON.stringify(chalito)) {
        const { error } = await this.auth.admin.updateUserById(id, { app_metadata: { chalito } });
        if (error) throw error;
      }
      return;
    }
    const { error } = await this.auth.admin.createUser({ id, email, email_confirm: true, app_metadata: { chalito } });
    // A concurrent mint may have created it first.
    if (error && !/already|exists|registered/i.test(error.message)) throw error;
  }

  async #magicLink(email: string) {
    const { data, error } = await this.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !data.properties?.hashed_token) throw new Error("could not mint a sign-in link", { cause: error });
    return data.properties.hashed_token;
  }
}

/** Device and pairing users carry app_metadata.chalito; anyone else is a hub user (role user). */
const claimsOf = (user: User): IdentityClaims => {
  const c = (user.app_metadata as { chalito?: Record<string, unknown> }).chalito;
  if (!c || typeof c !== "object") return { uid: user.id, role: "user", owner: user.id };
  const role = typeof c.role === "string" && ROLES.has(c.role) ? c.role : "";
  return {
    uid: user.id,
    role,
    owner: typeof c.owner === "string" ? c.owner : "",
    ...(role !== "pairing" && typeof c.device_id === "string" ? { deviceId: c.device_id } : {}),
  };
};
