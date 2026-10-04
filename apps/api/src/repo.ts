import type { z } from "zod";
import type { DeviceDoc, HubTenantStatus, PairingCodeDoc } from "@chalito/protocol";
import type { RecoveryHash } from "./lib/recovery.js";

/**
 * Everything the API routes read or write, and nothing more. Firestore today
 * (firestore/repo.ts); a Postgres implementation can back the same interface. Methods
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
  /**
   * Atomic: only while the account has no active (unrevoked) client, creates the first
   * client and stores the recovery hash.
   */
  enrollFirstClient(
    owner: string,
    doc: DeviceDoc,
    recovery: StoredRecovery,
  ): Promise<"ok" | "client_exists" | "device_exists">;
  saveEndorsement(owner: string, newDeviceId: string, endorsement: unknown, at: number): Promise<void>;

  // ---- recovery ----
  getRecovery(owner: string): Promise<StoredRecovery | null>;
  startRecovery(owner: string, cooldownUntil: number, startedAt: number): Promise<void>;
  /** Atomic: creates the recovered client (fails if the id exists) and replaces the recovery hash. */
  completeRecovery(owner: string, doc: DeviceDoc, next: StoredRecovery): Promise<"ok" | "device_exists">;

  // ---- notifications ----
  createNotification(owner: string, nid: string, doc: Record<string, unknown>): Promise<void>;

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
      claimedAt: number;
    },
    build: (code: PairingCodeDoc) => Promise<DeviceDoc>,
  ): Promise<
    { ok: true; agentDeviceId: string } | { ok: false; reason: "not_found" | "already_claimed" | "device_exists" }
  >;
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
 * Mints and checks the credentials the API hands out (Firebase custom tokens today).
 * `verify` must reject revoked credentials; `disableDevice` makes a device's existing
 * credentials stop working.
 */
export interface IdentityIssuer {
  mintUser(owner: string, tier: string): Promise<string>;
  mintDevice(owner: string, deviceId: string, role: "client" | "agent"): Promise<string>;
  /** A credential that can only watch one pairing code. */
  mintPairingWatch(codeId: string): Promise<string>;
  verify(token: string): Promise<IdentityClaims>;
  disableDevice(deviceId: string): Promise<void>;
  /** Deletes a pairing watch's credential, if the backend keeps one per code. */
  releasePairingWatch?(codeId: string): Promise<void>;
}
