import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import type { AgentEvent, ApprovalRequest, CallLine, DeviceEvent } from "@chalito/protocol";
import { randomUUID } from "node:crypto";
import { redactDeep, sanitizeDeviceEvent } from "./redact.js";
import type { AgentStore, AuditEntry } from "./store.js";

const EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** AgentStore over Firestore (client SDK, signed in as this device). Shapes match firestore.rules. */
export class FirestoreStore implements AgentStore {
  constructor(
    private readonly db: Firestore,
    private readonly owner: string,
    private readonly deviceId: string,
  ) {}

  #u(path: string) {
    return doc(this.db, `users/${this.owner}/${path}`);
  }

  async createApproval(req: ApprovalRequest) {
    await setDoc(this.#u(`approvals/${req.aid}`), { ...req, decision: null });
  }

  watchApproval(aid: string, onDecision: (decision: unknown) => void) {
    return onSnapshot(this.#u(`approvals/${aid}`), (snap) => {
      const d = snap.get("decision");
      if (d) onDecision(d);
    });
  }

  async resolveApproval(aid: string, status: ApprovalRequest["status"], reason: string, at: number) {
    await updateDoc(this.#u(`approvals/${aid}`), { status, reason, resolvedAt: at });
  }

  async writeEvent(e: AgentEvent) {
    await setDoc(this.#u(`sessions/${e.sid}/events/${e.eid}`), {
      ...e,
      expireAt: Timestamp.fromMillis(e.t + EVENT_TTL_MS),
    });
  }

  async upsertSession(sid: string, data: Record<string, unknown>) {
    await setDoc(this.#u(`sessions/${sid}`), { ...data, deviceId: this.deviceId }, { merge: true });
  }

  watchCommands(onCommand: (id: string, doc: Record<string, unknown>) => void) {
    return onSnapshot(collection(this.db, `users/${this.owner}/devices/${this.deviceId}/commands`), (snap) => {
      for (const ch of snap.docChanges()) if (ch.type === "added") onCommand(ch.doc.id, ch.doc.data());
    });
  }

  async deleteCommand(id: string) {
    await deleteDoc(doc(this.db, `users/${this.owner}/devices/${this.deviceId}/commands/${id}`));
  }

  async updateDevice(fields: { policyHash?: string; devMode?: unknown; lastSeenAt?: number }) {
    await updateDoc(this.#u(`devices/${this.deviceId}`), fields);
  }

  async publishDeviceEvent(raw: DeviceEvent) {
    const e = sanitizeDeviceEvent(raw);
    await updateDoc(this.#u(`devices/${this.deviceId}`), { lastEvent: e });
    await this.audit({ eid: randomUUID(), t: e.t, type: e.type, meta: { ...e }, source: "deviceEvent" });
  }

  async audit(entry: AuditEntry) {
    // JSON round-trip drops undefined values, which Firestore rejects.
    const meta = JSON.parse(JSON.stringify(redactDeep(entry.meta) ?? {})) as Record<string, unknown>;
    await setDoc(this.#u(`devices/${this.deviceId}/audit/${entry.eid}`), {
      t: entry.t,
      type: entry.type,
      meta,
      source: entry.source,
      deviceId: this.deviceId,
    });
  }

  async callBriefingEnabled() {
    const snap = await getDoc(doc(this.db, `users/${this.owner}`));
    return snap.get("callBriefing.enabled") === true;
  }

  async writeCallLine(id: string, line: CallLine) {
    await setDoc(this.#u(`callLines/${id}`), { ...line, expireAt: Timestamp.fromMillis(line.expireAt) });
  }

  async deleteCallLine(id: string) {
    await deleteDoc(this.#u(`callLines/${id}`)).catch(() => undefined);
  }
}
