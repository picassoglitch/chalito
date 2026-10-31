import { spawnSync } from "node:child_process";
import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_BRIDGE_VERSION,
  LEGACY_MANIFEST,
  UPDATER_MANIFEST,
  UPDATER_PLATFORMS,
  manifestFiles,
  type ReleaseManifest,
} from "@chalito/releases";
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

/** `files`: what each stored manifest file holds (absent → null), or one manifest for every file. */
const setup = (files: unknown, perFile = false) => {
  const signed: [string, number][] = [];
  const read = (file: string) => (perFile ? ((files as Record<string, unknown>)[file] ?? null) : files);
  const store: ReleaseStore = {
    manifest: vi.fn(async (_ch: string, file: string) => read(file)),
    signedUrl: async (object, ttl) => (signed.push([object, ttl]), `https://signed.example/${object}?sig=1`),
  };
  const deps = { now: Date.now } as unknown as Deps;
  const app = new Hono().route("/releases", releasesRoutes(deps, store));
  return { app, store, signed };
};

const DESKTOP = join(__dirname, "../../desktop");
const TSX = createRequire(join(__dirname, "../package.json")).resolve("tsx/cli");

/** Runs the real `release manifest` command as the Release workflow does; returns the files it wrote. */
const runManifestCli = (channel: "stable" | "beta", version: string): Record<string, ReleaseManifest> => {
  const dir = mkdtempSync(join(tmpdir(), "chalito-release-"));
  try {
    const art = (name: string, signature?: string) => ({
      name,
      size: 1,
      sha256: H,
      ...(signature ? { signature } : {}),
    });
    const parts = {
      linux: {
        os: "linux",
        label: "signed",
        artifacts: [art(`Chalito_${version}_amd64.AppImage`, "l"), art(`Chalito_${version}_amd64.deb`)],
      },
      windows: { os: "windows", label: "signed", artifacts: [art(`Chalito_${version}_x64-setup.exe`, "w")] },
      macos: {
        os: "macos",
        label: "signed",
        artifacts: [art("Chalito.app.tar.gz", "m"), art(`Chalito_${version}.dmg`)],
      },
    };
    for (const [os, part] of Object.entries(parts))
      writeFileSync(join(dir, `artifacts-${os}.json`), JSON.stringify(part));
    const out = join(dir, "out");
    mkdirSync(out);
    const args = ["scripts/release/cli.ts", "manifest", "--channel", channel, "--version", version];
    const r = spawnSync(process.execPath, [TSX, ...args, "--in", dir, "--out-dir", out], {
      cwd: DESKTOP,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`release manifest failed: ${r.stderr}`);
    return Object.fromEntries(
      readdirSync(out).map((f) => [f, JSON.parse(readFileSync(join(out, f), "utf8")) as ReleaseManifest]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const ENDPOINTS = [UPDATER_MANIFEST, LEGACY_MANIFEST];

describe.each(ENDPOINTS)("GET /releases/:channel/%s", (file) => {
  it("serves the manifest with signed URLs and drops anything outside the channel", async () => {
    const s = setup(MANIFEST);
    const res = await s.app.request(`/releases/stable/${file}`);
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
    expect((await setup(MANIFEST).app.request(`/releases/nightly/${file}`)).status).toBe(404);
    const none = await setup(null).app.request(`/releases/beta/${file}`);
    expect([none.status, ((await none.json()) as { error: string }).error]).toEqual([404, "no_release"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await setup({ version: "x" }).app.request(`/releases/stable/${file}`)).status).toBe(503);
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
    expect((await createApp(base).request(`/releases/stable/${file}`)).status).toBe(404);
    const withStore = createApp({ ...base, releases: { manifest: async () => MANIFEST, signedUrl: async (o) => o } });
    expect((await withStore.request(`/releases/stable/${file}`)).status).toBe(200);
  });

  it("GCS or the signer failing answers 503 release_unavailable, never a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = { now: Date.now } as unknown as Deps;
    const down: ReleaseStore = {
      manifest: async () => {
        throw new Error("releases manifest: HTTP 500");
      },
      signedUrl: async (o) => o,
    };
    const res = await new Hono().route("/releases", releasesRoutes(deps, down)).request(`/releases/stable/${file}`);
    expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([503, "release_unavailable"]);
    const noSigner: ReleaseStore = {
      manifest: async () => MANIFEST,
      signedUrl: async () => {
        throw new Error("signBlob 403");
      },
    };
    const res2 = await new Hono()
      .route("/releases", releasesRoutes(deps, noSigner))
      .request(`/releases/stable/${file}`);
    expect(res2.status).toBe(503);
    spy.mockRestore();
  });

  it("a failing read never falls back: v2 erroring answers 503 without touching latest.json", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = { now: Date.now } as unknown as Deps;
    const reads: string[] = [];
    const store = (v2: "throws" | "absent"): ReleaseStore => ({
      manifest: async (_ch, f) => {
        reads.push(f);
        if (f === UPDATER_MANIFEST && v2 === "absent") return null;
        throw new Error("releases manifest: HTTP 500");
      },
      signedUrl: async (o) => o,
    });
    const get = (v2: "throws" | "absent") =>
      new Hono().route("/releases", releasesRoutes(deps, store(v2))).request(`/releases/beta/${UPDATER_MANIFEST}`);
    expect((await get("throws")).status).toBe(503);
    expect(reads).toEqual([UPDATER_MANIFEST]);
    // v2 not uploaded yet and the legacy read failing: still 503, never a 404 or a 500.
    reads.length = 0;
    expect((await get("absent")).status).toBe(503);
    expect(reads).toEqual([UPDATER_MANIFEST, LEGACY_MANIFEST]);
    spy.mockRestore();
  });
});

describe("legacy latest.json is frozen at the bridge release", () => {
  const at = (version: string): ReleaseManifest => ({
    version,
    notes: "",
    pub_date: "2026-10-28T12:00:00Z",
    platforms: {
      "linux-x86_64": { signature: "l", url: `beta/${version}/Chalito.AppImage` },
      "windows-x86_64": { signature: "w", url: `beta/${version}/Chalito_x64-setup.exe` },
      "darwin-aarch64": { signature: "m", url: `beta/${version}/Chalito.app.tar.gz` },
      "darwin-x86_64": { signature: "m", url: `beta/${version}/Chalito.app.tar.gz` },
    },
  });

  it("each endpoint reads its own stored file", async () => {
    const s = setup({ [UPDATER_MANIFEST]: at("0.1.0-beta.14"), [LEGACY_MANIFEST]: at(LEGACY_BRIDGE_VERSION) }, true);
    const v2 = (await (await s.app.request(`/releases/beta/${UPDATER_MANIFEST}`)).json()) as ReleaseManifest;
    const legacy = (await (await s.app.request(`/releases/beta/${LEGACY_MANIFEST}`)).json()) as ReleaseManifest;
    expect([v2.version, legacy.version]).toEqual(["0.1.0-beta.14", LEGACY_BRIDGE_VERSION]);
    expect(s.store.manifest).toHaveBeenCalledWith("beta", UPDATER_MANIFEST);
    expect(s.store.manifest).toHaveBeenCalledWith("beta", LEGACY_MANIFEST);
  });

  it("only the bridge release writes latest.json; every release writes latest-v2.json", () => {
    expect(manifestFiles(LEGACY_BRIDGE_VERSION).sort()).toEqual([LEGACY_MANIFEST, UPDATER_MANIFEST].sort());
    for (const v of ["0.1.0-beta.14", "0.1.0-beta.12", "0.2.0", "1.0.0"])
      expect(manifestFiles(v)).toEqual([UPDATER_MANIFEST]);
  });

  it("real release CLI, both channels: the stored latest.json offers every OS the bridge and nothing later", async () => {
    // What beta.12 and earlier uploaded, then every release from the bridge on, as the workflow runs it.
    const bucket: Record<string, unknown> = { [`beta/${LEGACY_MANIFEST}`]: at("0.1.0-beta.12") };
    const publish = (ch: "stable" | "beta", v: string) => {
      const files = runManifestCli(ch, v);
      for (const [f, m] of Object.entries(files)) bucket[`${ch}/${f}`] = m;
      return Object.keys(files).sort();
    };
    expect(publish("beta", LEGACY_BRIDGE_VERSION)).toEqual([LEGACY_MANIFEST, UPDATER_MANIFEST].sort());
    expect(publish("beta", "0.1.0-beta.14")).toEqual([UPDATER_MANIFEST]);
    expect(publish("beta", "0.1.0-beta.15")).toEqual([UPDATER_MANIFEST]);
    expect(publish("stable", "0.1.0")).toEqual([UPDATER_MANIFEST]);
    expect(publish("stable", "1.0.0")).toEqual([UPDATER_MANIFEST]);
    const store: ReleaseStore = {
      manifest: async (ch, f) => bucket[`${ch}/${f}`] ?? null,
      signedUrl: async (o) => `https://signed.example/${o}`,
    };
    const app = new Hono().route("/releases", releasesRoutes({ now: Date.now } as unknown as Deps, store));
    const get = async (path: string) => (await (await app.request(path)).json()) as ReleaseManifest;
    const legacy = await get(`/releases/beta/${LEGACY_MANIFEST}`);
    expect(legacy.version).toBe(LEGACY_BRIDGE_VERSION);
    expect(Object.keys(legacy.platforms).sort()).toEqual([...UPDATER_PLATFORMS].sort());
    for (const p of Object.values(legacy.platforms)) expect(p.url).toContain(`/beta/${LEGACY_BRIDGE_VERSION}/`);
    expect((await get(`/releases/beta/${UPDATER_MANIFEST}`)).version).toBe("0.1.0-beta.15");
    // No stable install exists (every tag so far is a beta): stable starts on v2 and never gets a legacy file.
    expect((await app.request(`/releases/stable/${LEGACY_MANIFEST}`)).status).toBe(404);
    expect((await get(`/releases/stable/${UPDATER_MANIFEST}`)).version).toBe("1.0.0");
  }, 60_000);

  it("before the bridge is uploaded, latest-v2.json serves the legacy file instead of 404, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = setup({ [LEGACY_MANIFEST]: at("0.1.0-beta.12") }, true);
    const res = await s.app.request(`/releases/beta/${UPDATER_MANIFEST}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as ReleaseManifest).version).toBe("0.1.0-beta.12");
    expect(warn).toHaveBeenCalledWith(
      "[api] releases: no",
      UPDATER_MANIFEST,
      "yet; serving",
      LEGACY_MANIFEST,
      "for",
      "beta",
    );
    warn.mockRestore();
  });

  it("both manifests share one rate-limit bucket per caller", async () => {
    const s = setup(at("0.1.0-beta.14"));
    for (let i = 0; i < 30; i++) expect((await s.app.request(`/releases/beta/${UPDATER_MANIFEST}`)).status).toBe(200);
    expect((await s.app.request(`/releases/beta/${LEGACY_MANIFEST}`)).status).toBe(429);
  });
});
