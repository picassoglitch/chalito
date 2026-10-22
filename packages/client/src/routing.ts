import { RouteRules, resolveRoute, type RouteChoice, type RouteComputer } from "@chalito/protocol";
import type { DeviceView } from "./live.js";

/** The settings RPCs this needs (supabase-js, schema `chalito`); not settings.ts, which pulls in the UI. */
export interface RoutingDb {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

// ADR 0031 §5: where a new session runs when the owner doesn't pick. Stored in the owner's settings
// (`prefs.routing`); resolved here, then signed as a normal session.start for the chosen computer.

export class RoutingError extends Error {
  override name = "RoutingError";
  constructor(readonly code: "invalid" | "failed") {
    super(code);
  }
}

/** The saved rules, or null (none saved, or a shape this client doesn't accept). */
export const loadRouteRules = async (db: RoutingDb): Promise<RouteRules | null> => {
  const { data, error } = await db.rpc("get_my_settings");
  if (error) throw new RoutingError("failed");
  const raw = (data as { prefs?: { routing?: unknown } } | null)?.prefs?.routing;
  const r = RouteRules.safeParse(raw);
  return r.success ? r.data : null;
};

/** Saves the rules (null clears them); refuses a shape or size the protocol doesn't accept. */
export const saveRouteRules = async (db: RoutingDb, rules: RouteRules | null): Promise<void> => {
  if (rules !== null && !RouteRules.safeParse(rules).success) throw new RoutingError("invalid");
  const { error } = await db.rpc("update_my_settings", { p: { prefs: { routing: rules } } });
  if (error) throw new RoutingError(error.code === "23514" || error.code === "22023" ? "invalid" : "failed");
};

/** The owner's computers as routing sees them (agents only, revoked ones dropped). */
export const routeComputers = (devices: readonly DeviceView[]): RouteComputer[] =>
  devices
    .filter((d) => d.role === "agent" && !d.revoked)
    .map((d) => ({
      deviceId: d.deviceId,
      online: d.online,
      adapters: d.setup?.adapters ?? [],
      labels: d.setup?.labels ?? [],
      workspaces: d.setup?.workspaces ?? 0,
    }));

/** "Automático": the computer, AI and folder the rules pick for this request right now. */
export const pickComputer = (
  rules: RouteRules | null,
  want: { workspaceLabel?: string; appId?: string },
  devices: readonly DeviceView[],
): RouteChoice => resolveRoute(rules, want, routeComputers(devices));
