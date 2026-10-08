import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { deriveDeviceId, generateSigningKeyPair, toB64url } from "@chalito/crypto";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import type { DeviceDoc } from "@chalito/protocol";
import { GcsAccountFiles, MemoryAccountFiles } from "../src/account/files.js";
import {
  DELETION_GRACE_MS,
  accountRoutes,
  accountTaskRoutes,
  runDueDeletions,
  type AccountDeps,
} from "../src/account/routes.js";
import type { AccountStore, DeletionStatus } from "../src/account/store.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo, StoredWebAuthnCredential, WebAuthnChallenge } from "../src/repo.js";
import { webauthnRoutes } from "../src/routes/webauthn.js";

const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;
const NOW = 1_790_000_000_000;
const WA = { rpId: RP, rpName: "Chalito", origins: [ORIGIN], challengeTtlMs: 60_000 };
const SCHED = { audience: "https://api.test/tasks/account-deletions", email: "scheduler@test.iam" };

class MemoryAccountStore implements AccountStore {
  readonly rows = new Map<string, DeletionStatus>();
  readonly deleted: string[] = [];
  constructor(private readonly devicesOf: (o: string) => string[]) {}
  async status(o: string) {
    return this.rows.get(o) ?? null;
  }
  async schedule(o: string, _by: string, at: number, dueAt: number, exportPath: string) {
    if (this.rows.get(o)?.status === "scheduled") return "exists" as const;
    this.rows.set(o, { status: "scheduled", requestedAt: at, dueAt, exportPath });
    return "scheduled" as const;
  }
  async cancel(o: string) {
    const r = this.rows.get(o);
    if (r?.status !== "scheduled") return false;
    r.status = "cancelled";
    return true;
  }
  async due(now: number) {
    return [...this.rows].filter(([, r]) => r.status === "scheduled" && r.dueAt <= now).map(([o]) => o);
  }
  async export(o: string) {
    return { owner: o, tables: { devices: this.devicesOf(o).map((d) => ({ device_id: d })) } };
  }
  async deviceIds(o: string) {
    return this.devicesOf(o);
  }
  async deleteAccount(o: string) {
    this.deleted.push(o);
    this.rows.delete(o);
  }
}

const setup = async () => {
  const o = "hub-user-1";
  const sign = await generateSigningKeyPair();
  const phoneId = await deriveDeviceId(sign.publicKey);
  const devices = [
    { v: 1, deviceId: phoneId, owner: o, role: "client", revoked: false, pubSign: await toB64url(sign.publicKey) },
    { v: 1, deviceId: "agent_1", owner: o, role: "agent", revoked: false },
  ] as unknown as DeviceDoc[];
  const challenges = new Map<string, WebAuthnChallenge>();
  const creds = new Map<string, StoredWebAuthnCredential>();
  const notifications: string[] = [];
  const repo: Partial<ApiRepo> = {
    getDevice: async (ow, id) => devices.find((d) => d.owner === ow && d.deviceId === id) ?? null,
    createNotification: async (_o, nid) => void notifications.push(nid),
    putWebAuthnChallenge: async (c) => void challenges.set(`${c.owner}/${c.deviceId}/${c.purpose}`, c),
    takeWebAuthnChallenge: async (ow, d, p, now) => {
      const k = `${ow}/${d}/${p}`;
      const c = challenges.get(k);
      challenges.delete(k);
      return c && c.expiresAt > now ? c.challenge : null;
    },
    setDeviceWebAuthn: async (ow, d, cred) => (creds.set(`${ow}/${d}`, cred), true),
    getDeviceWebAuthn: async (ow, d) => creds.get(`${ow}/${d}`) ?? null,
    bumpWebAuthnCounter: async (ow, d, id, counter) => {
      const c = creds.get(`${ow}/${d}`);
      if (!c || c.credentialId !== id) return "not_found";
      if (counter === 0 && c.counter === 0) return "ok";
      if (counter <= c.counter) return "cloned";
      creds.set(`${ow}/${d}`, { ...c, counter });
      return "ok";
    },
  };
  let clock = NOW;
  const deletedDevices: string[] = [];
  const audit = new MemoryAudit();
  const deps = {
    repo,
    identity: {
      verify: async (t: string) => {
        if (t === "phone") return { uid: `d_${phoneId}`, role: "client", owner: o, deviceId: phoneId };
        if (t === "person") return { uid: o, role: "user", owner: o };
        throw new Error("bad token");
      },
      deleteDevice: async (id: string) => void deletedDevices.push(id),
    },
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => clock,
  } as unknown as Deps;
  const store = new MemoryAccountStore((ow) => devices.filter((d) => d.owner === ow).map((d) => d.deviceId));
  const files = new MemoryAccountFiles();
  files.objects.set(`avatars/${o}/asset_1/card.json`, Buffer.from("{}"));
  files.objects.set(`avatars/hub-user-2/asset_9/card.json`, Buffer.from("{}"));
  const account: AccountDeps = {
    store,
    files,
    scheduler: SCHED,
    verifyOidc: async (h, e) => h === "Bearer good-oidc" && e === SCHED,
  };
  const app = new Hono()
    .route("/v1/account", accountRoutes(deps, account, WA))
    .route("/tasks", accountTaskRoutes(deps, account))
    .route("/v1/webauthn", webauthnRoutes(deps, WA));
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, headers: res.headers };
  };
  const auth = new SoftAuthenticator({ origin: ORIGIN, alg: -8 });
  const enrol = async () => {
    const opts = await call("POST", "/v1/webauthn/register/options", "phone", {});
    await call("POST", "/v1/webauthn/register/verify", "phone", { response: await auth.create(opts.json.options) });
  };
  const stepUp = async () => auth.get((await call("POST", "/v1/webauthn/assert/options", "phone", {})).json.options);
  return {
    o,
    call,
    enrol,
    stepUp,
    store,
    files,
    audit,
    notifications,
    deletedDevices,
    tick: (ms: number) => (clock += ms),
  };
};

describe("account deletion (ARCO)", () => {
  it("needs a trusted client with a passkey and a fresh step-up", async () => {
    const s = await setup();
    expect((await s.call("POST", "/v1/account/deletion", "person", {})).status).toBe(403);
    expect((await s.call("POST", "/v1/account/deletion", "phone", {})).json.error).toBe("passkey_required");
    await s.enrol();
    expect((await s.call("POST", "/v1/account/deletion", "phone", {})).json.error).toBe("step_up_required");
    expect(s.store.rows.size).toBe(0);
  });

  it("writes the export first, schedules 7 days out, alerts every device, and can't be scheduled twice", async () => {
    const s = await setup();
    await s.enrol();
    const r = await s.call("POST", "/v1/account/deletion", "phone", { stepUp: await s.stepUp() });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ status: "scheduled", dueAt: NOW + DELETION_GRACE_MS, exportReady: true });
    expect(s.notifications).toHaveLength(1);
    expect(s.audit.events.at(-1)).toMatchObject({ action: "account.deletion_requested", owner: s.o });
    expect((await s.call("GET", "/v1/account/deletion", "person")).json).toMatchObject({ status: "scheduled" });
    const exp = await s.call("GET", "/v1/account/export", "person");
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-disposition")).toMatch(/attachment/);
    expect(exp.json.tables.devices).toHaveLength(2);
    expect((await s.call("POST", "/v1/account/deletion", "phone", { stepUp: await s.stepUp() })).status).toBe(409);
  });

  it("the owner can cancel during the grace period, and nothing is deleted", async () => {
    const s = await setup();
    await s.enrol();
    await s.call("POST", "/v1/account/deletion", "phone", { stepUp: await s.stepUp() });
    expect((await s.call("DELETE", "/v1/account/deletion", "person")).json).toEqual({ status: "cancelled" });
    s.tick(DELETION_GRACE_MS + 1);
    expect((await s.call("POST", "/tasks/account-deletions", undefined, {})).status).toBe(401);
    const run = await s.call("POST", "/tasks/account-deletions", "good-oidc", {});
    expect(run.json).toEqual({ deleted: 0, failed: 0 });
    expect(s.store.deleted).toEqual([]);
    expect((await s.call("DELETE", "/v1/account/deletion", "person")).status).toBe(404);
  });

  it("when due: device Auth users, the owner's files (only theirs) and the data are deleted", async () => {
    const s = await setup();
    await s.enrol();
    await s.call("POST", "/v1/account/deletion", "phone", { stepUp: await s.stepUp() });
    s.tick(DELETION_GRACE_MS - 1);
    expect((await s.call("POST", "/tasks/account-deletions", "good-oidc", {})).json.deleted).toBe(0);
    s.tick(2);
    expect((await s.call("POST", "/tasks/account-deletions", "good-oidc", {})).json).toEqual({ deleted: 1, failed: 0 });
    expect(s.deletedDevices).toHaveLength(2);
    expect(s.store.deleted).toEqual([s.o]);
    expect([...s.files.objects.keys()]).toEqual(["avatars/hub-user-2/asset_9/card.json"]);
    expect(s.audit.events.at(-1)).toMatchObject({ action: "account.deleted", owner: s.o, meta: { files: 2 } });
  });
});

describe("GcsAccountFiles.deleteOwner (versioned buckets)", () => {
  /** Buckets with versioning: getFiles({ versions: true }) lists noncurrent generations too. */
  const storage = () => {
    const objects: Record<string, { name: string; generation: number; live: boolean }[]> = {
      assets: [
        { name: "avatars/u1/a1/layer-happy.webp", generation: 1, live: false },
        { name: "avatars/u1/a1/layer-happy.webp", generation: 2, live: true },
        { name: "avatars/u1/a2/card.json", generation: 3, live: false }, // only a noncurrent version left
        { name: "uploads/u1/a3/original", generation: 4, live: false },
        { name: "avatars/u10/a1/card.json", generation: 5, live: true }, // another owner
      ],
      records: [{ name: "records/u1/r.json", generation: 6, live: true }],
      exports: [{ name: "exports/u1/e.json", generation: 7, live: false }],
    };
    const calls: { bucket: string; prefix: string; versions?: boolean }[] = [];
    const deleted: string[] = [];
    const fake = {
      bucket: (b: string) => ({
        getFiles: async (q: { prefix: string; versions?: boolean }) => {
          calls.push({ bucket: b, ...q });
          return [
            objects[b]!.filter((f) => f.name.startsWith(q.prefix) && (q.versions || f.live)).map((f) => ({
              ...f,
              delete: async () => void deleted.push(`${b}:${f.name}#${f.generation}`),
            })),
          ];
        },
      }),
    };
    const files = new GcsAccountFiles(fake as never, {
      exportBucket: "exports",
      prefixes: [
        { bucket: "assets", prefix: (o) => `avatars/${o}/` },
        { bucket: "assets", prefix: (o) => `uploads/${o}/` },
        { bucket: "records", prefix: (o) => `records/${o}/` },
      ],
    });
    return { files, calls, deleted };
  };

  it("deletes every generation under the owner's prefixes, noncurrent ones included, and no one else's", async () => {
    const s = storage();
    expect(await s.files.deleteOwner("u1")).toBe(6);
    expect(s.calls.every((c) => c.versions === true)).toBe(true);
    expect(s.calls.map((c) => `${c.bucket}:${c.prefix}`)).toEqual([
      "assets:avatars/u1/",
      "assets:uploads/u1/",
      "records:records/u1/",
      "exports:exports/u1/",
    ]);
    expect(s.deleted.sort()).toEqual([
      "assets:avatars/u1/a1/layer-happy.webp#1",
      "assets:avatars/u1/a1/layer-happy.webp#2",
      "assets:avatars/u1/a2/card.json#3",
      "assets:uploads/u1/a3/original#4",
      "exports:exports/u1/e.json#7",
      "records:records/u1/r.json#6",
    ]);
  });
});

describe("runDueDeletions (audit 2026-10-08)", () => {
  it("a cancel that lands after the due list was read wins: nothing of that owner is deleted", async () => {
    const store = new MemoryAccountStore(() => ["dev_1"]);
    store.rows.set("u_a", { status: "scheduled", requestedAt: 0, dueAt: NOW - 1, exportPath: "x" });
    store.rows.set("u_b", { status: "scheduled", requestedAt: 0, dueAt: NOW - 1, exportPath: "y" });
    const deletedDevices: string[] = [];
    const deps = {
      identity: { deleteDevice: async (id: string) => void deletedDevices.push(id) },
      audit: new MemoryAudit(),
      now: () => NOW,
    } as unknown as Deps;
    const files = new MemoryAccountFiles();
    // u_b cancels while u_a's files are being deleted.
    const account: AccountDeps = {
      store,
      files: {
        ...files,
        putExport: files.putExport.bind(files),
        getExport: files.getExport.bind(files),
        deleteOwner: async (o: string) => {
          if (o === "u_a") await store.cancel("u_b");
          return 0;
        },
      },
      scheduler: SCHED,
      verifyOidc: async () => true,
    };
    expect(await runDueDeletions(deps, account)).toEqual({ deleted: 1, failed: 0 });
    expect(store.deleted).toEqual(["u_a"]);
    expect(store.rows.get("u_b")?.status).toBe("cancelled");
    expect(deletedDevices).toEqual(["dev_1"]);
  });
});
