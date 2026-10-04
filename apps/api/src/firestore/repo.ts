import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import type { DeviceDoc, PairingCodeDoc } from "@chalito/protocol";
import type { ApiRepo, StoredRecovery, TenantRecord, TenantStatus } from "../repo.js";

/** Firestore's ALREADY_EXISTS from `create()`. */
const isAlreadyExists = (err: unknown) => (err as { code?: number }).code === 6;

/** Runs a `create()` and maps ALREADY_EXISTS to false. */
const created = async (write: () => Promise<unknown>): Promise<boolean> => {
  try {
    await write();
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    throw err;
  }
};

/** ApiRepo over Firestore (Admin SDK). Paths and shapes match firestore.rules. */
export class FirestoreRepo implements ApiRepo {
  constructor(private readonly db: Firestore) {}

  #user(owner: string) {
    return this.db.doc(`users/${owner}`);
  }
  #device(owner: string, deviceId: string) {
    return this.db.doc(`users/${owner}/devices/${deviceId}`);
  }
  #recovery(owner: string) {
    return this.db.doc(`users/${owner}/private/recovery`);
  }

  async createTenant(t: TenantRecord) {
    const ok = await created(() => this.#user(t.tenantId).create({ v: 1, ...t, status: "active", locale: "es" }));
    return ok ? ("created" as const) : ("exists" as const);
  }

  async setTenantStatus(tenantId: string, status: TenantStatus, at: number) {
    const ref = this.#user(tenantId);
    if (!(await ref.get()).exists) return false;
    await ref.update({ status, statusAt: at });
    return true;
  }

  async upsertUserFromSso(owner: string, fields: { tenantId: string; email: string; tier: string; lastSsoAt: number }) {
    await this.#user(owner).set({ v: 1, ...fields }, { merge: true });
  }

  claimSsoToken(sigHash: string, expiresAt: number) {
    return created(() => this.db.doc(`ssoTokens/${sigHash}`).create({ expireAt: new Date(expiresAt) }));
  }

  claimDeviceNonce(deviceId: string, nonce: string, expiresAt: number) {
    return created(() => this.db.doc(`deviceNonces/${deviceId}_${nonce}`).create({ expireAt: new Date(expiresAt) }));
  }

  async getDevice(owner: string, deviceId: string) {
    const snap = await this.#device(owner, deviceId).get();
    return snap.exists ? (snap.data() as DeviceDoc) : null;
  }

  async createDevice(owner: string, doc: DeviceDoc) {
    const ok = await created(() => this.#device(owner, doc.deviceId).create(doc));
    return ok ? ("created" as const) : ("exists" as const);
  }

  async touchDevice(owner: string, deviceId: string, at: number) {
    await this.#device(owner, deviceId).update({ lastSeenAt: at });
  }

  async revokeDevice(owner: string, deviceId: string, at: number, by: string | null) {
    const ref = this.#device(owner, deviceId);
    const snap = await ref.get();
    if (!snap.exists) return "not_found" as const;
    if (snap.get("revoked") === true) return "already_revoked" as const;
    await ref.update({ revoked: true, revokedAt: at, revokedBy: by });
    return "revoked" as const;
  }

  async enrollFirstClient(owner: string, doc: DeviceDoc, recovery: StoredRecovery) {
    const devices = this.db.collection(`users/${owner}/devices`);
    return this.db.runTransaction(async (tx) => {
      const active = await tx.get(devices.where("role", "==", "client").where("revoked", "==", false).limit(1));
      if (!active.empty) return "client_exists" as const;
      const ref = devices.doc(doc.deviceId);
      if ((await tx.get(ref)).exists) return "device_exists" as const;
      tx.create(ref, doc);
      tx.set(this.#recovery(owner), recovery);
      return "ok" as const;
    });
  }

  async saveEndorsement(owner: string, newDeviceId: string, endorsement: unknown, at: number) {
    await this.db.doc(`users/${owner}/endorsements/${newDeviceId}`).set({ ...(endorsement as object), createdAt: at });
  }

  async getRecovery(owner: string) {
    const snap = await this.#recovery(owner).get();
    return snap.exists ? (snap.data() as StoredRecovery) : null;
  }

  async startRecovery(owner: string, cooldownUntil: number, startedAt: number) {
    await this.#recovery(owner).update({ cooldownUntil, startedAt });
  }

  async completeRecovery(owner: string, doc: DeviceDoc, next: StoredRecovery) {
    return this.db.runTransaction(async (tx) => {
      const ref = this.#device(owner, doc.deviceId);
      if ((await tx.get(ref)).exists) return "device_exists" as const;
      tx.create(ref, doc);
      tx.set(this.#recovery(owner), next);
      return "ok" as const;
    });
  }

  async createNotification(owner: string, nid: string, doc: Record<string, unknown>) {
    await this.db.doc(`users/${owner}/notifications/${nid}`).set(doc);
  }

  async createPairingCode(doc: PairingCodeDoc) {
    const ok = await created(() =>
      this.db.doc(`pairingCodes/${doc.codeId}`).create({ ...doc, expireAt: new Date(doc.expiresAt) }),
    );
    return ok ? ("created" as const) : ("exists" as const);
  }

  async findPairingCodeByShortHash(shortCodeHash: string) {
    const q = await this.db.collection("pairingCodes").where("shortCodeHash", "==", shortCodeHash).limit(1).get();
    return (q.docs[0]?.data() as PairingCodeDoc | undefined) ?? null;
  }

  async claimPairingCode(
    codeId: string,
    claim: {
      owner: string;
      claimedByDeviceId: string;
      claimerPubSign: string;
      claimerPubBox: string;
      claimedAt: number;
    },
    build: (code: PairingCodeDoc) => Promise<DeviceDoc>,
  ) {
    const codeRef = this.db.doc(`pairingCodes/${codeId}`);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef);
      if (!snap.exists) return { ok: false as const, reason: "not_found" as const };
      const code = snap.data() as PairingCodeDoc;
      if (code.claimed) return { ok: false as const, reason: "already_claimed" as const };
      const agentDoc = await build(code);
      const deviceRef: DocumentReference = this.#device(claim.owner, agentDoc.deviceId);
      if ((await tx.get(deviceRef)).exists) return { ok: false as const, reason: "device_exists" as const };
      tx.create(deviceRef, agentDoc);
      tx.update(codeRef, { claimed: true, ...claim });
      return { ok: true as const, agentDeviceId: agentDoc.deviceId };
    });
  }
}
