import type { z } from "zod";
import type { DeviceDoc, DeviceRegistration, Endorsement, HubTenantStatus, PairingCodeDoc } from "@chalito/protocol";
import type { RecoveryHash } from "./lib/recovery.js";

/**
 * Everything the API routes read or write, and nothing more. Backed by Postgres on the
 * hub's Supabase project (postgres/repo.ts, ADR 0017). Methods
 * that must be atomic say so: implement them as one transaction.
 */
export interface ApiRepo {
  // ---- tenants / users (hub contract) ----
  /** Creates the tenant's user record; "exists" if it was already provisioned. */
  createTenant(t: TenantRecord): Promise<"created" | "exists">;
  /** False if the tenant doesn't exist. */
  setTenantStatus(tenantId: string, status: TenantStatus, at: number): Promise<boolean>;
  /** Creates or merges the user record from a verified SSO launch. */
  upsertUserFromSso(
    owner: string,
    fields: { tenantId: string; email: string; tier: string; lastSsoAt: number },
  ): Promise<void>;

  // ---- single-use markers ----
  /** Records an SSO token as used; false if it was used before. */
  claimSsoToken(sigHash: string, expiresAt: number): Promise<boolean>;
  /** Records a device refresh nonce as used; false if it was used before. */
  claimDeviceNonce(deviceId: string, nonce: string, expiresAt: number): Promise<boolean>;

  // ---- devices ----
  getDevice(owner: string, deviceId: string): Promise<DeviceDoc | null>;
  /** Creates a device; "exists" if the id is taken. */
  createDevice(owner: string, doc: DeviceDoc): Promise<"created" | "exists">;
  touchDevice(owner: string, deviceId: string, at: number): Promise<void>;
  revokeDevice(
    owner: string,
    deviceId: string,
    at: number,
    by: string | null,
  ): Promise<"revoked" | "already_revoked" | "not_found">;
  /** Revokes every active client of the owner except `keep`, in one statement; returns their ids. */
  revokeOtherClients(owner: string, keep: string, at: number): Promise<string[]>;
  /** Active (unrevoked) agent device ids. */
  activeAgents(owner: string): Promise<string[]>;
  /** Queues a command for an agent (chalito.commands, as the server). false if the id exists. */
  queueCommand(
    owner: string,
    c: { targetDeviceId: string; id: string; env: unknown; fromDeviceId: string; expiresAt: number },
  ): Promise<boolean>;
  /**
   * Atomic: only while the account has no active (unrevoked) device of any role, creates the
   * first client and stores the recovery hash. An active agent alone gives `agent_exists`.
   */
  enrollFirstClient(
    owner: string,
    doc: DeviceDoc,
    recovery: StoredRecovery,
  ): Promise<"ok" | "client_exists" | "agent_exists" | "device_exists">;
  saveEndorsement(owner: string, newDeviceId: string, endorsement: unknown, at: number): Promise<void>;

  // ---- recovery ----
  getRecovery(owner: string): Promise<StoredRecovery | null>;
  startRecovery(owner: string, cooldownUntil: number, startedAt: number): Promise<void>;
  /** Atomic: creates the recovered client (fails if the id exists) and replaces the recovery hash. */
  completeRecovery(owner: string, doc: DeviceDoc, next: StoredRecovery): Promise<"ok" | "device_exists">;

  // ---- notifications ----
  createNotification(owner: string, nid: string, doc: Record<string, unknown>): Promise<void>;

  // ---- WebAuthn passkeys (D-019/D-034) ----
  /** Stores the pending challenge for one device and purpose, replacing any earlier one. */
  putWebAuthnChallenge(c: WebAuthnChallenge): Promise<void>;
  /**
   * Atomic and single-use: returns the device's pending challenge for `purpose` and deletes it;
   * null if there is none or it expired by `now`.
   */
  takeWebAuthnChallenge(owner: string, deviceId: string, purpose: WebAuthnPurpose, now: number): Promise<string | null>;
  /** Records the device's passkey on its device record; false if the device doesn't exist. */
  setDeviceWebAuthn(owner: string, deviceId: string, cred: StoredWebAuthnCredential): Promise<boolean>;
  getDeviceWebAuthn(owner: string, deviceId: string): Promise<StoredWebAuthnCredential | null>;
  /**
   * Atomic, after a verified assertion: moves the passkey's sign counter forward. "cloned" when
   * it didn't advance (new ≤ stored, unless both are 0: authenticators without a counter always
   * report 0), the WebAuthn signal of a cloned authenticator; nothing is written then.
   * "not_found" when the device no longer has this credential.
   */
  bumpWebAuthnCounter(
    owner: string,
    deviceId: string,
    credentialId: string,
    counter: number,
  ): Promise<"ok" | "cloned" | "not_found">;
  /** Stores the device-signed binding for its current passkey (the route verified it). */
  setDeviceWebAuthnBinding(owner: string, deviceId: string, binding: unknown): Promise<boolean>;

  // ---- pairing ----
  /** "exists" if the code id was already published. */
  createPairingCode(doc: PairingCodeDoc): Promise<"created" | "exists">;
  findPairingCodeByShortHash(shortCodeHash: string): Promise<PairingCodeDoc | null>;
  /**
   * Atomic: detaches the pairing watchers of codes this agent was claimed through and returns
   * their code ids, each at most once (the caller then deletes the watcher credentials).
   * Backends whose watch credentials expire on their own return [].
   */
  releasePairingWatches(owner: string, agentDeviceId: string): Promise<string[]>;
  /**
   * Atomic: locks the code, lets `build` validate it and produce the agent's device doc
   * (it may throw to abort), then creates the device and marks the code claimed.
   */
  claimPairingCode(
    codeId: string,
    claim: {
      owner: string;
      claimedByDeviceId: string;
      claimerPubSign: string;
      claimerPubBox: string;
      /** The claimer's passkey binding, passed on to the agent for its reverse check. */
      claimerWebauthnBinding?: unknown;
      claimedAt: number;
    },
    build: (code: PairingCodeDoc) => Promise<DeviceDoc>,
  ): Promise<
    { ok: true; agentDeviceId: string } | { ok: false; reason: "not_found" | "already_claimed" | "device_exists" }
  >;

  // ---- endorsement handoff (/v1/endorse) ----
  /** "exists" if the code id or short code hash is taken. */
  createEndorseCode(r: NewEndorseCode): Promise<"created" | "exists">;
  findEndorseCode(codeId: string): Promise<EndorseCodeRecord | null>;
  findEndorseCodeByShortHash(shortCodeHash: string): Promise<EndorseCodeRecord | null>;
  /** Atomic, single use: stores the endorsement only on a live, not yet endorsed code of `owner`. */
  approveEndorseCode(
    codeId: string,
    owner: string,
    e: { endorsement: Endorsement; endorsedByDeviceId: string; endorsedAt: number },
    now: number,
  ): Promise<"ok" | "not_found" | "expired" | "already_endorsed">;
  /** Atomic, single use: hands the endorsement to the new device once. */
  takeEndorsement(
    codeId: string,
    owner: string,
    now: number,
  ): Promise<
    | { ok: true; endorsement: Endorsement }
    | { ok: false; reason: "not_found" | "expired" | "not_endorsed" | "already_taken" }
  >;
}

export interface NewEndorseCode {
  codeId: string;
  shortCodeHash: string;
  owner: string;
  registration: DeviceRegistration;
  expiresAt: number;
}

export interface EndorseCodeRecord extends NewEndorseCode {
  newDeviceId: string;
  endorsement: Endorsement | null;
  endorsedByDeviceId: string | null;
  endorsedAt: number | null;
  takenAt: number | null;
}

export type WebAuthnPurpose = "register" | "assert";

export interface WebAuthnChallenge {
  owner: string;
  deviceId: string;
  purpose: WebAuthnPurpose;
  /** base64url, as @simplewebauthn/server issues it. */
  challenge: string;
  expiresAt: number;
}

/** A device's passkey. `publicKey` is the base64url COSE key agents verify step-ups against. */
export interface StoredWebAuthnCredential {
  credentialId: string;
  publicKey: string;
  rpId: string;
  counter: number;
  transports: string[];
  createdAt: number;
  /** chalito.webauthn-binding.v1 signed by the device key, once the device sent it. */
  binding?: unknown;
}

export type TenantStatus = z.infer<typeof HubTenantStatus>["status"];

export interface TenantRecord {
  tenantId: string;
  email: string;
  displayName: string | null;
  tier: string;
  createdAt: number;
}

export type StoredRecovery = RecoveryHash & { cooldownUntil: number | null; createdAt?: number; startedAt?: number };

/** Claims carried by an API credential. */
export interface IdentityClaims {
  uid: string;
  role: string;
  owner: string;
  deviceId?: string;
}

/**
 * Mints and checks the credentials the API hands out (Supabase Auth users per device and
 * pairing watch; magic-link token hashes the clients exchange for a session).
 * `verify` must reject revoked credentials; `disableDevice` makes a device's existing
 * credentials stop working.
 */
export interface IdentityIssuer {
  mintUser(owner: string, tier: string): Promise<string>;
  mintDevice(owner: string, deviceId: string, role: "client" | "agent"): Promise<string>;
  /** A credential that can only watch one pairing code. */
  mintPairingWatch(codeId: string): Promise<string>;
  verify(token: string): Promise<IdentityClaims>;
  /** false when the ban could not be applied (logged; RLS and the revoked flag still cut the device off). */
  disableDevice(deviceId: string): Promise<boolean>;
  /** Deletes the device's Auth user (account deletion). Missing users count as deleted. */
  deleteDevice(deviceId: string): Promise<void>;
  /** Deletes a pairing watch's credential, if the backend keeps one per code. */
  releasePairingWatch?(codeId: string): Promise<void>;
}
