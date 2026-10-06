import { z } from "zod";
import { EpochMs } from "./common.js";

/**
 * "Connect your AI" (connect contract, 2026-10-05). Each device reports, per provider, how the
 * person connected it and whether its coding-agent CLI is ready. Status only: a key or a sign-in
 * token never leaves the device (keys live in the OS keychain, sign-ins in the provider's own
 * CLI profile).
 */

/** How a provider is connected: a BYO API key, or the person's own sign-in in the provider's official CLI. */
export const ProviderConnectMethod = z.enum(["api_key", "signin"]);
export type ProviderConnectMethod = z.infer<typeof ProviderConnectMethod>;

/**
 * `blocked_by_policy`: a plan sign-in was asked for but providers.yaml `subscriptionLocal` is
 * off (or owner_only and this person isn't on the Chalito team).
 */
export const ProviderState = z.enum([
  "not_installed",
  "installing",
  "needs_auth",
  "signing_in",
  "connected",
  "error",
  "blocked_by_policy",
]);
export type ProviderState = z.infer<typeof ProviderState>;

/**
 * Closed error codes, so no free text (a path, a CLI's output, a key) can reach the status doc.
 * `install_unconfirmed`: nobody confirmed a remote install on the device in time.
 */
export const ProviderErrorCode = z.enum([
  "install_failed",
  "install_unconfirmed",
  "npm_missing",
  "pin_failed",
  "signin_failed",
  "signin_timeout",
  "key_invalid",
  "keychain_failed",
  "status_failed",
]);
export type ProviderErrorCode = z.infer<typeof ProviderErrorCode>;

/** The `doc` of a `chalito.connections` row, one per (owner, device, provider), written by that device's agent. */
export const ProviderConnectionDoc = z
  .object({
    mode: ProviderConnectMethod.nullable(),
    connected: z.boolean(),
    state: ProviderState,
    cli: z.object({ installed: z.boolean(), version: z.string().max(64).nullable() }).strict(),
    error: ProviderErrorCode.nullable(),
    at: EpochMs,
  })
  .strict()
  .refine((d) => d.connected === (d.state === "connected"), { message: "connected iff state is connected" });
export type ProviderConnectionDoc = z.infer<typeof ProviderConnectionDoc>;
