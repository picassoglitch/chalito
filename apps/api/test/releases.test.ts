import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "@chalito/releases";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { v4SignedUrl, type ReleaseStore } from "../src/releases/gcs.js";
import { SIGNED_URL_TTL_SEC, releasesRoutes } from "../src/routes/releases.js";

const SIGNER = "chalito-release-signer@chalyb-prod.iam.gserviceaccount.com";

describe("GCS V4 signed URLs", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signBlob = async (_email: string, data: Uint8Array) =>
    new Uint8Array(createSign("RSA-SHA256").update(data).sign(privateKey));

  it("builds the documented canonical request and signs its hash as the signer", async () => {
    const url = new URL(
      await v4SignedUrl({
        bucket: "chalyb-prod-chalito-releases",
        object: "stable/1.2.0/Chalito 1.2.0_x64-setup.exe",
        signerEmail: SIGNER,
        now: new Date("2026-10-20T12:34:56.789Z"),
        expiresSec: 900,
        signBlob,
      }),
    );
    expect(url.origin).toBe("https://storage.googleapis.com");
    expect(url.pathname).toBe("/chalyb-prod-chalito-releases/stable/1.2.0/Chalito%201.2.0_x64-setup.exe");
    const q = url.searchParams;
    expect(q.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(q.get("X-Goog-Credential")).toBe(`${SIGNER}/20261020/auto/storage/goog4_request`);
    expect(q.get("X-Goog-Date")).toBe("20261020T123456Z");
    expect(q.get("X-Goog-Expires")).toBe("900");
    expect(q.get("X-Goog-SignedHeaders")).toBe("host");

    // Rebuild what GCS rebuilds and check the signature against the signer's public key.
    const query = url.search.slice(1).replace(/&X-Goog-Signature=[0-9a-f]+$/, "");
    expect(query.split("&").map((p) => p.split("=")[0])).toEqual(
      [...query.split("&").map((p) => p.split("=")[0])].sort(),
    );
    const canonical = ["GET", url.pathname, query, "host:storage.googleapis.com", "", "host", "UNSIGNED-PAYLOAD"].join(
      "\n",
    );
    const toSign = [
      "GOOG4-RSA-SHA256",
      "20261020T123456Z",
      "20261020/auto/storage/goog4_request",
      createHash("sha256").update(canonical).digest("hex"),
    ].join("\n");
    const sig = Buffer.from(q.get("X-Goog-Signature")!, "hex");
    expect(createVerify("RSA-SHA256").update(toSign).verify(publicKey, sig)).toBe(true);
  });

  it("percent-encodes per RFC 3986 and bounds the lifetime", async () => {
    const url = await v4SignedUrl({
      bucket: "b",
      object: "stable/x/a(1)!*'.txt",
      signerEmail: SIGNER,
      now: new Date(),
      expiresSec: 60,
      signBlob,
    });
    expect(url).toContain("/b/stable/x/a%281%29%21%2A%27.txt?");
    await expect(
      v4SignedUrl({ bucket: "b", object: "x", signerEmail: SIGNER, now: new Date(), expiresSec: 604_801, signBlob }),
    ).rejects.toThrow(/range/);
  });
});

const H = "c".repeat(64);
const MANIFEST: ReleaseManifest = {
  version: "1.2.0",
  notes: "",
  pub_date: "2026-10-20T12:00:00Z",
  platforms: {
    "linux-x86_64": { signature: "sig", url: "stable/1.2.0/Chalito.AppImage" },
    "windows-x86_64": { signature: "sig", url: "beta/1.2.0/sneaky-setup.exe" },
  },
  downloads: {
    linux: [
      { kind: "appimage", name: "Chalito.AppImage", url: "stable/1.2.0/Chalito.AppImage", size: 1, sha256: H },
      { kind: "deb", name: "evil.deb", url: "https://evil.example/x.deb", size: 1, sha256: H },
    ],
  },
  unsigned: { linux: true },
};

const setup = (manifest: unknown) => {
  const signed: [string, number][] = [];
  const store: ReleaseStore = {
    manifest: vi.fn(async () => manifest),
    signedUrl: async (object, ttl) => (signed.push([object, ttl]), `https://signed.example/${object}?sig=1`),
  };
  const deps = { now: Date.now } as unknown as Deps;
  const app = new Hono().route("/releases", releasesRoutes(deps, store));
  return { app, store, signed };
};

describe("GET /releases/:channel/latest.json", () => {
  it("serves the manifest with signed URLs and drops anything outside the channel", async () => {
    const s = setup(MANIFEST);
    const res = await s.app.request("/releases/stable/latest.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    const body = (await res.json()) as ReleaseManifest;
    expect(body.platforms).toEqual({
      "linux-x86_64": { signature: "sig", url: "https://signed.example/stable/1.2.0/Chalito.AppImage?sig=1" },
    });
    expect(body.downloads?.linux?.map((d) => d.url)).toEqual([
      "https://signed.example/stable/1.2.0/Chalito.AppImage?sig=1",
    ]);
    expect(body.unsigned).toEqual({ linux: true });
    expect(s.signed.every(([o, ttl]) => o.startsWith("stable/") && ttl === SIGNED_URL_TTL_SEC)).toBe(true);
  });

  it("unknown channel 404, no release 404, malformed manifest 503", async () => {
    expect((await setup(MANIFEST).app.request("/releases/nightly/latest.json")).status).toBe(404);
    const none = await setup(null).app.request("/releases/beta/latest.json");
    expect([none.status, ((await none.json()) as { error: string }).error]).toEqual([404, "no_release"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await setup({ version: "x" }).app.request("/releases/stable/latest.json")).status).toBe(503);
    spy.mockRestore();
  });

  it("is mounted only when the api has a release store", async () => {
    const base = {
      repo: {},
      identity: {},
      audit: new MemoryAudit(),
      config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 1 },
      now: Date.now,
    } as unknown as Deps;
    expect((await createApp(base).request("/releases/stable/latest.json")).status).toBe(404);
    const withStore = createApp({ ...base, releases: { manifest: async () => MANIFEST, signedUrl: async (o) => o } });
    expect((await withStore.request("/releases/stable/latest.json")).status).toBe(200);
  });
});

describe("GET /releases/:channel/latest.json when GCS or the signer fails", () => {
  it("answers 503 release_unavailable, never a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = { now: Date.now } as unknown as Deps;
    const down: ReleaseStore = {
      manifest: async () => {
        throw new Error("releases manifest: HTTP 500");
      },
      signedUrl: async (o) => o,
    };
    const res = await new Hono().route("/releases", releasesRoutes(deps, down)).request("/releases/stable/latest.json");
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([503, "release_unavailable"]);
    const noSigner: ReleaseStore = {
      manifest: async () => MANIFEST,
      signedUrl: async () => {
        throw new Error("signBlob 403");
      },
    };
    const res2 = await new Hono()
      .route("/releases", releasesRoutes(deps, noSigner))
      .request("/releases/stable/latest.json");
    expect(res2.status).toBe(503);
    spy.mockRestore();
  });
});
