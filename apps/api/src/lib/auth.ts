import type { Context, MiddlewareHandler } from "hono";
import type { Deps } from "../deps.js";
import { fail } from "./errors.js";

export type Role = "user" | "client" | "agent" | "pairing";

export interface Principal {
  role: Role;
  /** Hub user id; every Chalito path is users/{owner}/… */
  owner: string;
  deviceId: string | null;
  uid: string;
}

export type AuthEnv = { Variables: { principal: Principal } };

/** Firebase uid of a device. Each device has its own identity so it can be disabled alone. */
export const deviceUid = (deviceId: string) => `d_${deviceId}`;

/**
 * Verifies the Firebase ID token (refresh-token revocation checked) and, for devices,
 * that the device doc is not revoked — so revocation applies to the very next request.
 */
export const requireAuth =
  (deps: Deps, roles: Role[]): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) fail(401, "unauthenticated");
    let claims: Record<string, unknown>;
    try {
      claims = await deps.auth.verifyIdToken(token, true);
    } catch {
      return fail(401, "unauthenticated");
    }
    const role = claims.role as Role | undefined;
    const owner = typeof claims.owner === "string" ? claims.owner : "";
    if (!role || !roles.includes(role) || !owner) fail(403, "forbidden");
    const deviceId = typeof claims.deviceId === "string" ? claims.deviceId : null;
    if (role === "client" || role === "agent") {
      const snap = await deps.db.doc(`users/${owner}/devices/${deviceId}`).get();
      if (!snap.exists || snap.get("revoked") !== false) fail(403, "device_revoked");
    }
    c.set("principal", { role: role!, owner, deviceId, uid: String(claims.uid) });
    await next();
  };

export const principal = (c: Context<AuthEnv>): Principal => c.get("principal");
