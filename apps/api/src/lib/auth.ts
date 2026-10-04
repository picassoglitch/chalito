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

/**
 * Verifies the credential (revocation checked by the IdentityIssuer) and, for devices,
 * that the device record is not revoked — so revocation applies to the very next request.
 */
export const requireAuth =
  (deps: Deps, roles: Role[]): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) fail(401, "unauthenticated");
    let claims: Awaited<ReturnType<Deps["identity"]["verify"]>>;
    try {
      claims = await deps.identity.verify(token);
    } catch {
      return fail(401, "unauthenticated");
    }
    const role = claims.role as Role;
    const owner = claims.owner;
    if (!role || !roles.includes(role) || !owner) fail(403, "forbidden");
    const deviceId = claims.deviceId ?? null;
    if (role === "client" || role === "agent") {
      const device = deviceId ? await deps.repo.getDevice(owner, deviceId) : null;
      if (!device || device.revoked !== false) fail(403, "device_revoked");
    }
    c.set("principal", { role, owner, deviceId, uid: claims.uid });
    await next();
  };

export const principal = (c: Context<AuthEnv>): Principal => c.get("principal");
