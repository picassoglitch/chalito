import { describe, expect, it } from "vitest";
import { HubClient, avatarQuote } from "@chalito/billing";
import { loadModels, loadPrices } from "@chalito/config";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import {
  DAILY_CREATIONS,
  GENERATION_TIMEOUT_MS,
  UPLOAD_MAX_BYTES,
  UPLOAD_WINDOW_MS,
  type AvatarDeps,
} from "../src/avatar/routes.js";
import type { AvatarFiles } from "../src/avatar/files.js";
import { freeMarkers, markerKey } from "../src/avatar/free-marker.js";
import { MemoryAvatarRepo, type CardManifestLike } from "../src/avatar/repo.js";
import { MemoryAudit } from "../src/deps.js";
import type { ApiRepo, IdentityIssuer } from "../src/repo.js";
// The Chalyb hub, mocked at the HTTP layer (admit + settle), shared with the store tests.
import { RID, hubCalls, hubState } from "./store-harness.js";

const quote = avatarQuote(loadPrices(), loadModels().images.avatar, "pre_margin");
const OWNER = "hub-user-1";
const ID1 = "cr_0123456789abcdef01";
const ID2 = "cr_0123456789abcdef02";
const ID3 = "cr_0123456789abcdef03";
const KEY = "k".repeat(32);
const ADULT = { ownPhoto: true, ageBand: "18_plus" };

const MANIFEST: CardManifestLike = {
  v: 1,
  kind: "card",
  width: 600,
  height: 800,
  emotions: {
    mode: "swap",
    src: {
      neutral: "layer-neutral.webp",
      happy: "layer-happy.webp",
      sad: "layer-sad.webp",
      surprised: "layer-surprised.webp",
      tired: "layer-tired.webp",
    },
  },
  thumbs: { "128": "thumb-128.webp", "256": "thumb-256.webp" },
};

class FakeFiles implements AvatarFiles {
  readonly objects = new Map<string, { size: number; contentType: string }>();
  readonly deleted: string[] = [];
  readonly uploads: { object: string; contentType: string; maxBytes: number }[] = [];
  async signedUpload(object: string, contentType: string, maxBytes: number) {
    this.uploads.push({ object, contentType, maxBytes });
    return {
      url: `https://storage.googleapis.com/bucket/${object}?X-Goog-Signature=put`,
      method: "PUT" as const,
      headers: { "content-type": contentType, "x-goog-content-length-range": `0,${maxBytes}` },
      expiresAt: 0,
    };
  }
  async signedRead(object: string) {
    return `https://storage.googleapis.com/bucket/${object}?X-Goog-Signature=get`;
  }
  async stat(object: string) {
    return this.objects.get(object) ?? null;
  }
  async deleteAll(object: string) {
    this.deleted.push(object);
    this.objects.delete(object);
  }
}

const setup = () => {
  const clock = { now: 1_790_000_000_000 };
  const repo = new MemoryAvatarRepo();
  repo.companions.set(OWNER, null);
  repo.emails.set(OWNER, "Ana@Example.com");
  const files = new FakeFiles();
  const devices = new Map([
    ["dev_phone", { deviceId: "dev_phone", role: "client", revoked: false } as DeviceDoc],
    ["dev_agent", { deviceId: "dev_agent", role: "agent", revoked: false } as DeviceDoc],
  ]);
  const identity = {
    verify: async (token: string) => {
      const [role, deviceId, owner = OWNER] = token.split(":");
      return { uid: `d_${deviceId}`, role, owner, ...(deviceId ? { deviceId } : {}) };
    },
  } as unknown as IdentityIssuer;
  const avatar: AvatarDeps = {
    repo,
    files,
    hub: new HubClient({ baseUrl: "https://www.chalyb.com", token: "chalito-admin-token" }),
    quote,
    markerKey: KEY,
  };
  const app = createApp({
    repo: { getDevice: async (_o: string, id: string) => devices.get(id) ?? null } as unknown as ApiRepo,
    identity,
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => clock.now,
    avatar,
  });
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token = "client:dev_phone") => {
    const res = await app.request(`/v1/avatar${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const start = (creationId: string, contentType = "image/jpeg", token?: string, extra: object = {}) =>
    call("POST", "/creations", { creationId, contentType, attestation: ADULT, ...extra }, token);
  /** What the avatar job does (apps/avatar-jobs src/creation.ts), in the shared table. */
  const job = (creationId: string, outcome: "succeeded" | "failed") => {
    const r = repo.rows.get(creationId)!;
    if (outcome === "succeeded") repo.succeed(creationId, MANIFEST);
    else Object.assign(r, { status: "failed", failure: "refused" });
  };
  const upload = (creationId: string) => {
    const r = repo.rows.get(creationId)!;
    files.objects.set(`uploads/${OWNER}/${r.assetId}/original`, { size: 2_000_000, contentType: r.contentType });
  };
  return { call, start, job, upload, repo, files, clock };
};

describe("custom companion: the first one is free", () => {
  it("quote says free, with the paid price for later ones", async () => {
    const { call } = setup();
    const q = await call("GET", "/quote");
    expect(q.status).toBe(200);
    expect(q.json).toMatchObject({
      free: true,
      priceTokens: quote.priceTokens,
      dailyLeft: DAILY_CREATIONS,
      active: null,
    });
  });

  it("starts without the hub, answers a signed PUT for uploads/<owner>/<asset>/original (type and size bound)", async () => {
    const { start, files, repo } = setup();
    const r = await start(ID1, "image/png");
    expect(r.status).toBe(201);
    expect(hubCalls).toHaveLength(0);
    expect(r.json).toMatchObject({ creationId: ID1, status: "awaiting_upload", free: true, priceTokens: 0 });
    const row = repo.rows.get(ID1)!;
    expect(row.assetId).toMatch(/^[a-f0-9]{32}$/);
    expect(files.uploads).toEqual([
      { object: `uploads/${OWNER}/${row.assetId}/original`, contentType: "image/png", maxBytes: UPLOAD_MAX_BYTES },
    ]);
    expect(r.json.upload).toMatchObject({
      method: "PUT",
      headers: { "content-type": "image/png", "x-goog-content-length-range": `0,${UPLOAD_MAX_BYTES}` },
    });
  });

  it("only photos: other content types are refused", async () => {
    const { call } = setup();
    for (const contentType of ["image/gif", "image/svg+xml", "application/pdf", "text/html"])
      expect((await call("POST", "/creations", { creationId: ID1, contentType })).status).toBe(400);
  });

  it("one creation at a time", async () => {
    const { start } = setup();
    await start(ID1);
    const again = await start(ID2);
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: "busy", creationId: ID1 });
  });

  it("confirm: missing photo → 409; uploaded → queued", async () => {
    const { call, start, upload } = setup();
    await start(ID1);
    expect((await call("POST", `/creations/${ID1}/uploaded`)).status).toBe(409);
    upload(ID1);
    const r = await call("POST", `/creations/${ID1}/uploaded`);
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("queued");
  });

  it("a success uses up the free credit: the next one is paid (admitted before any work)", async () => {
    const { call, start, job, upload } = setup();
    await start(ID1);
    upload(ID1);
    job(ID1, "succeeded");
    const done = await call("GET", `/creations/${ID1}`);
    expect(done.json).toMatchObject({ status: "succeeded", free: true });
    const card = done.json.card as { manifest: CardManifestLike; urls: Record<string, string> };
    expect(card.manifest.emotions.mode).toBe("swap");
    expect(Object.keys(card.urls).sort()).toEqual(
      [
        "layer-happy.webp",
        "layer-neutral.webp",
        "layer-sad.webp",
        "layer-surprised.webp",
        "layer-tired.webp",
        "thumb-128.webp",
        "thumb-256.webp",
      ].sort(),
    );
    expect(hubCalls).toHaveLength(0); // a free creation never touches the hub

    expect((await call("GET", "/quote")).json).toMatchObject({ free: false, priceTokens: quote.priceTokens });
    const paid = await start(ID2);
    expect(paid.status).toBe(201);
    expect(paid.json).toMatchObject({ free: false, priceTokens: quote.priceTokens });
    expect(hubCalls.map((c) => c.path)).toEqual(["admit"]);
    expect(hubCalls[0]!.body).toMatchObject({
      external_user_id: OWNER,
      external_job_id: `avatar:${ID2}`,
      class: "job",
      operation: "avatar.create",
      est_tokens: quote.estTokens,
    });
  });

  it("a failed free attempt gives the free credit back", async () => {
    const { call, start, job } = setup();
    await start(ID1);
    job(ID1, "failed");
    expect((await call("GET", `/creations/${ID1}`)).json).toMatchObject({ status: "failed", failure: "refused" });
    expect((await call("GET", "/quote")).json).toMatchObject({ free: true });
    expect((await start(ID2)).json).toMatchObject({ free: true });
    expect(hubCalls).toHaveLength(0);
  });
});

describe("custom companion: paid creations", () => {
  const paidSetup = async () => {
    const s = setup();
    await s.start(ID1);
    s.job(ID1, "succeeded");
    hubCalls.length = 0;
    return s;
  };

  it("a success settles the reservation once (the job reported the real cost)", async () => {
    const { call, start, job } = await paidSetup();
    await start(ID2);
    job(ID2, "succeeded");
    await call("GET", `/creations/${ID2}`);
    await call("GET", `/creations/${ID2}`);
    expect(hubCalls.map((c) => c.path)).toEqual(["admit", "settle"]);
    expect(hubCalls[1]!.body).toEqual({ reservation_id: RID, outcome: "succeeded" });
  });

  it("a failure is never charged: the reservation is cancelled", async () => {
    const { call, start, job } = await paidSetup();
    await start(ID2);
    job(ID2, "failed");
    await call("GET", `/creations/${ID2}`);
    expect(hubCalls.map((c) => c.path)).toEqual(["admit", "settle"]);
    expect(hubCalls[1]!.body).toEqual({ reservation_id: RID, outcome: "cancelled" });
  });

  it("no_tokens: refused with the why-chip, nothing created", async () => {
    const { start, repo } = await paidSetup();
    hubState.mode = "no_tokens";
    const r = await start(ID2);
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ error: "no_tokens", chips: [{ href: "/creditos" }] });
    expect(repo.rows.has(ID2)).toBe(false);
  });

  it("a balance short of the price is no_tokens too (the reservation is cancelled)", async () => {
    const { start, repo } = await paidSetup();
    hubState.remaining = quote.priceTokens - 1;
    expect((await start(ID2)).status).toBe(402);
    expect(hubCalls.map((c) => c.path)).toEqual(["admit", "settle"]);
    expect(repo.rows.has(ID2)).toBe(false);
  });

  it("fails closed when the hub is down", async () => {
    const { start, repo } = await paidSetup();
    hubState.mode = "down";
    expect((await start(ID2)).status).toBe(503);
    expect(repo.rows.has(ID2)).toBe(false);
  });

  it("retrying the same start never admits twice", async () => {
    const { start } = await paidSetup();
    await start(ID2);
    const again = await start(ID2);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ creationId: ID2, status: "awaiting_upload", replay: true });
    expect(again.json.upload).toBeDefined();
    expect(hubCalls.filter((c) => c.path === "admit")).toHaveLength(1);
  });
});

describe("custom companion: housekeeping", () => {
  it("another owner's creation id is a conflict, and their creations are invisible", async () => {
    const { call, start } = setup();
    await start(ID1);
    expect((await start(ID1, "image/jpeg", "client:dev_phone:hub-user-2")).status).toBe(409);
    expect((await call("GET", `/creations/${ID1}`, undefined, "client:dev_phone:hub-user-2")).status).toBe(404);
  });

  it("agents can't create", async () => {
    const { start } = setup();
    expect((await start(ID1, "image/jpeg", "agent:dev_agent")).status).toBe(403);
  });

  it("an upload window that passes expires the creation, deletes any photo and cancels the reservation", async () => {
    const { call, start, job, upload, files, clock, repo } = setup();
    await start(ID1);
    job(ID1, "succeeded");
    hubCalls.length = 0;
    await start(ID2);
    upload(ID2); // uploaded, but never confirmed and the job never ran
    clock.now += UPLOAD_WINDOW_MS + 1;
    expect((await call("GET", `/creations/${ID2}`)).json).toMatchObject({ status: "expired" });
    expect(files.deleted).toEqual([`uploads/${OWNER}/${repo.rows.get(ID2)!.assetId}/original`]);
    expect(hubCalls.map((c) => [c.path, c.body.outcome])).toEqual([
      ["admit", undefined],
      ["settle", "cancelled"],
    ]);
  });

  it("a job that never finishes is a timeout failure (free credit back), and frees the slot", async () => {
    const { call, start, repo, clock } = setup();
    await start(ID1);
    repo.rows.get(ID1)!.status = "generating";
    clock.now += UPLOAD_WINDOW_MS + GENERATION_TIMEOUT_MS + 1;
    expect((await call("GET", `/creations/${ID1}`)).json).toMatchObject({ status: "failed", failure: "timeout" });
    expect((await start(ID2)).json).toMatchObject({ status: "awaiting_upload", free: true });
  });

  it("caps creations per day, failures included", async () => {
    const { start, job } = setup();
    const ids = Array.from({ length: DAILY_CREATIONS }, (_, i) => `cr_daily_cap_000000${i}`);
    for (const id of ids) {
      expect((await start(id)).status).toBe(201);
      job(id, "failed");
    }
    const over = await start(ID3);
    expect(over.status).toBe(429);
    expect(over.json.error).toBe("daily_limit");
  });

  it("use: only a finished creation; null goes back to the roster avatar", async () => {
    const { call, start, job, repo } = setup();
    await start(ID1);
    expect((await call("POST", "/use", { creationId: ID1 })).status).toBe(409);
    job(ID1, "succeeded");
    const used = await call("POST", "/use", { creationId: ID1 });
    expect(used.status).toBe(200);
    expect(repo.companions.get(OWNER)).toEqual({ assetId: repo.rows.get(ID1)!.assetId, manifest: MANIFEST });
    const mine = await call("GET", "/companion");
    expect(mine.json.assetId).toBe(repo.rows.get(ID1)!.assetId);
    expect((await call("POST", "/use", { creationId: null })).json).toEqual({ ok: true, assetId: null });
    expect((await call("GET", "/companion")).json).toEqual({ assetId: null });
  });

  it("use without a companion yet is a 404", async () => {
    const { call, start, job, repo } = setup();
    repo.companions.delete(OWNER);
    await start(ID1);
    job(ID1, "succeeded");
    expect((await call("POST", "/use", { creationId: ID1 })).json).toEqual({ error: "no_companion" });
  });
});

describe("custom companion: consent (self-attestation)", () => {
  const attempt = (attestation: unknown) => {
    const s = setup();
    return s
      .call("POST", "/creations", { creationId: ID1, contentType: "image/jpeg", attestation })
      .then((r) => ({ ...r, s }));
  };

  it("requires the attestation: missing, or the photo not confirmed as theirs → 400, nothing created", async () => {
    for (const a of [undefined, { ownPhoto: false, ageBand: "18_plus" }, { ownPhoto: true }, { ageBand: "18_plus" }]) {
      const r = await attempt(a);
      expect(r.status).toBe(400);
      expect(r.s.repo.rows.size).toBe(0);
    }
    expect((await attempt({ ownPhoto: false, ageBand: "18_plus" })).json.error).toBe("attestation_required");
    expect((await attempt({ ownPhoto: "yes", ageBand: "18_plus" })).json.error).toBe("bad_request");
    expect((await attempt({ ownPhoto: true, ageBand: "adult" })).json.error).toBe("bad_request");
  });

  it("under 13 can't create (403 age_refused), guardian or not", async () => {
    for (const guardianConsent of [undefined, true]) {
      const r = await attempt({ ownPhoto: true, ageBand: "under_13", guardianConsent });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("age_refused");
      expect(r.s.repo.rows.size).toBe(0);
      expect(r.s.files.uploads).toEqual([]);
    }
  });

  it("13–17 needs a parent's or guardian's permission", async () => {
    for (const guardianConsent of [undefined, false]) {
      const r = await attempt({ ownPhoto: true, ageBand: "13_17", guardianConsent });
      expect(r.status).toBe(403);
      expect(r.json.error).toBe("guardian_required");
      expect(r.s.repo.rows.size).toBe(0);
    }
    const ok = await attempt({ ownPhoto: true, ageBand: "13_17", guardianConsent: true });
    expect(ok.status).toBe(201);
    expect(ok.s.repo.rows.get(ID1)!.attestation).toEqual({
      ownPhoto: true,
      ageBand: "13_17",
      guardianConsent: true,
      at: expect.any(Number),
    });
  });

  it("records what an adult attested, with the time", async () => {
    const { start, repo, clock } = setup();
    expect((await start(ID1)).status).toBe(201);
    expect(repo.rows.get(ID1)!.attestation).toEqual({
      ownPhoto: true,
      ageBand: "18_plus",
      guardianConsent: false,
      at: clock.now,
    });
  });

  it("a retried start still needs it (no attestation, no replay)", async () => {
    const { start, call } = setup();
    await start(ID1);
    expect((await call("POST", "/creations", { creationId: ID1, contentType: "image/jpeg" })).status).toBe(400);
  });
});

describe("custom companion: the free creation is once per person", () => {
  it("markers are keyed hashes of the hub id and the lowercased email, never the data itself", () => {
    const m = freeMarkers(KEY, OWNER, " Ana@Example.com ");
    expect(m).toHaveLength(2);
    for (const x of m) expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(m).toEqual(freeMarkers(KEY, OWNER, "ana@example.com"));
    expect(m.join()).not.toContain("ana");
    expect(freeMarkers("z".repeat(32), OWNER, "ana@example.com")).not.toEqual(m);
    expect(freeMarkers(KEY, OWNER, null)).toEqual([m[0]]);
    expect(markerKey(undefined, "sso")).toMatch(/^[0-9a-f]{64}$/);
    expect(() => markerKey("short", "sso")).toThrow();
  });

  it("a free creation carries its markers; a paid one doesn't", async () => {
    const { start, job, repo } = setup();
    await start(ID1);
    expect(repo.rows.get(ID1)!.freeMarkers).toEqual(freeMarkers(KEY, OWNER, "ana@example.com"));
    expect(repo.markers.size).toBe(0); // only a success leaves them
    job(ID1, "succeeded");
    expect(repo.markers.size).toBe(2);
    await start(ID2);
    expect(repo.rows.get(ID2)!.freeMarkers).toBeNull();
  });

  it("deleting the account and signing up again (same hub user) doesn't give a second free one", async () => {
    const { call, start, job, repo } = setup();
    await start(ID1);
    job(ID1, "succeeded");
    repo.deleteOwner(OWNER); // chalito_private.delete_account: rows cascade, markers stay
    expect(repo.rows.size).toBe(0);
    // Re-signup: SSO upserts the user again, onboarding creates a companion.
    repo.emails.set(OWNER, "ana@example.com");
    repo.companions.set(OWNER, null);
    expect((await call("GET", "/quote")).json).toMatchObject({ free: false });
    const again = await start(ID2);
    expect(again.status).toBe(201);
    expect(again.json).toMatchObject({ free: false, priceTokens: quote.priceTokens });
    expect(hubCalls.map((c) => c.path)).toEqual(["admit"]);
  });

  it("a new hub account with the same email doesn't either; a different person does", async () => {
    const { call, start, job, repo } = setup();
    await start(ID1);
    job(ID1, "succeeded");
    repo.deleteOwner(OWNER);
    repo.emails.set("hub-user-2", "ANA@example.com");
    expect((await call("GET", "/quote", undefined, "client:dev_phone:hub-user-2")).json).toMatchObject({ free: false });
    repo.emails.set("hub-user-3", "bea@example.com");
    expect((await call("GET", "/quote", undefined, "client:dev_phone:hub-user-3")).json).toMatchObject({ free: true });
  });

  it("a failed free attempt leaves no marker (the credit survives a deletion too)", async () => {
    const { call, start, job, repo } = setup();
    await start(ID1);
    job(ID1, "failed");
    repo.deleteOwner(OWNER);
    repo.emails.set(OWNER, "ana@example.com");
    expect(repo.markers.size).toBe(0);
    expect((await call("GET", "/quote")).json).toMatchObject({ free: true });
  });

  it("the daily cap stays at 5", () => {
    expect(DAILY_CREATIONS).toBe(5);
  });
});

describe("custom companion: onboarding (useWhenReady)", () => {
  it("the companion wears the card as soon as the creation succeeds, without a /use call", async () => {
    const { start, job, repo } = setup();
    const r = await start(ID1, "image/jpeg", undefined, { useWhenReady: true });
    expect(r.status).toBe(201);
    expect(repo.rows.get(ID1)!.useWhenReady).toBe(true);
    expect(repo.companions.get(OWNER)).toBeNull();
    job(ID1, "succeeded");
    expect(repo.companions.get(OWNER)).toEqual({ assetId: repo.rows.get(ID1)!.assetId, manifest: MANIFEST });
  });

  it("without it, a success leaves the companion alone", async () => {
    const { start, job, repo } = setup();
    await start(ID1);
    job(ID1, "succeeded");
    expect(repo.companions.get(OWNER)).toBeNull();
  });
});
