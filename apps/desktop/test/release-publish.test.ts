// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ready } from "@chalito/crypto";
import { buildManifest } from "@chalito/releases";
import { compareVersions, publicationFiles, publishRelease } from "../scripts/release/publish.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => "test-token") }));
afterEach(() => vi.unstubAllGlobals());

const fixture = async () => {
  const sodium = await ready();
  const keys = sodium.crypto_sign_keypair(),
    id = sodium.randombytes_buf(8);
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const publicKey = btoa(
    `untrusted comment: public key\n${b64(new Uint8Array([0x45, 0x64, ...id, ...keys.publicKey]))}\n`,
  );
  const bytes = new TextEncoder().encode("verified installer");
  const signature = sodium.crypto_sign_detached(sodium.crypto_generichash(64, bytes, null), keys.privateKey);
  const comment = "timestamp:1";
  const global = sodium.crypto_sign_detached(
    new Uint8Array([...signature, ...new TextEncoder().encode(comment)]),
    keys.privateKey,
  );
  const sig = btoa(
    `untrusted comment: signature\n${b64(new Uint8Array([0x45, 0x44, ...id, ...signature]))}\ntrusted comment: ${comment}\n${b64(global)}\n`,
  );
  const names = ["Chalito.AppImage", "Chalito-setup.exe", "Chalito.dmg", "Chalito.app.tar.gz"];
  const version = "1.0.0-beta.10",
    channel = "beta" as const;
  const manifest = buildManifest({
    channel,
    version,
    pubDate: new Date("2026-10-31T00:00:00Z"),
    unsigned: { linux: true, windows: true, macos: true },
    artifacts: names.map((name) => ({
      name,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature: sig,
    })),
  });
  return { manifest, version, channel, publicKey, bytes, names, read: () => bytes };
};

describe("automatic desktop publication", () => {
  it.each([
    ["1.0.0-beta.10", "1.0.0-beta.9", 1],
    ["1.0.0", "1.0.0-beta.10", 1],
    ["1.0.0", "2.0.0", -1],
    ["1.0.0-beta.1", "1.0.0-beta.1", 0],
    ["1.0.0-alpha", "1.0.0-beta", -1],
    ["1.0.0-beta", "1.0.0-beta.1", -1],
  ])("orders %s against %s", (a, b, result) => expect(compareVersions(a as string, b as string)).toBe(result));

  it("accepts complete beta builds signed with the production updater key", async () => {
    const f = await fixture();
    expect(await publicationFiles(f)).toEqual([...f.names].sort());
  });

  it("rejects missing platforms, wrong versions, traversal, corrupt installers and invalid signatures", async () => {
    const f = await fixture();
    await expect(publicationFiles({ ...f, version: "1.0.0-beta.11" })).rejects.toThrow("version");
    const missing = structuredClone(f.manifest);
    delete missing.platforms["windows-x86_64"];
    await expect(publicationFiles({ ...f, manifest: missing })).rejects.toThrow("Missing updater");
    const traversal = structuredClone(f.manifest);
    traversal.downloads!.linux![0]!.url = `beta/${f.version}/../evil`;
    await expect(publicationFiles({ ...f, manifest: traversal })).rejects.toThrow("Invalid release object");
    await expect(publicationFiles({ ...f, read: () => new Uint8Array([1]) })).rejects.toThrow("integrity");
    await expect(publicationFiles({ ...f, publicKey: "throwaway-key" })).rejects.toThrow("signature");
    const stable = structuredClone(f.manifest);
    stable.version = "1.0.0";
    await expect(publicationFiles({ ...f, manifest: stable, version: "1.0.0", channel: "stable" })).rejects.toThrow(
      "Unsigned stable",
    );
  });

  const run = async (
    options: {
      previous?: string;
      conflict?: boolean;
      existingDifferent?: boolean;
      uploadFailure?: boolean;
      storageDenied?: boolean;
    } = {},
  ) => {
    const f = await fixture();
    const dir = mkdtempSync(join(tmpdir(), "chalito-publish-"));
    for (const name of f.names) writeFileSync(join(dir, name), f.bytes);
    writeFileSync(join(dir, "latest-v2.json"), JSON.stringify(f.manifest));
    const uploads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const u = new URL(url),
          object = decodeURIComponent(u.pathname.split("/o/")[1] ?? "");
        if (init.method === "POST") {
          const name = u.searchParams.get("name")!;
          uploads.push(name);
          expect((init.headers as Record<string, string>)["X-Goog-Hash"]).toMatch(/^md5=.+/);
          if (options.uploadFailure && !name.endsWith("latest-v2.json"))
            return new Response("upload failed", { status: 503 });
          if (name.endsWith("latest-v2.json")) {
            expect(u.searchParams.get("ifGenerationMatch")).toBe(options.previous ? "42" : "0");
            if (options.conflict) return new Response("generation changed", { status: 412 });
          } else expect(u.searchParams.get("ifGenerationMatch")).toBe("0");
          return Response.json({ generation: "43" });
        }
        if (options.storageDenied) return new Response("forbidden", { status: 403 });
        if (object.endsWith("latest-v2.json") && options.previous) {
          if (u.searchParams.has("alt")) return Response.json({ ...f.manifest, version: options.previous });
          return Response.json({ generation: "42" });
        }
        if (options.existingDifferent && object.endsWith(".AppImage")) return Response.json({ md5Hash: "different" });
        return new Response("missing", { status: 404 });
      }),
    );
    try {
      await publishRelease({ ...f, dir, bucket: "test-releases" });
      return uploads;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("uploads every installer before advancing the channel and never touches latest.json", async () => {
    const uploads = await run({ previous: "1.0.0-beta.9" });
    expect(uploads).toHaveLength(5);
    expect(uploads.at(-1)).toBe("beta/latest-v2.json");
    expect(uploads.some((p) => p.endsWith("/latest.json"))).toBe(false);
  });
  it("refuses a downgrade before uploading", async () => {
    await expect(run({ previous: "1.0.0-beta.11" })).rejects.toThrow("downgrade");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
  it("retries a completed publication without rewriting assets or the manifest", async () => {
    expect(await run({ previous: "1.0.0-beta.10" })).toEqual([]);
  });
  it("refuses changed artifacts and concurrent channel updates", async () => {
    await expect(run({ existingDifferent: true })).rejects.toThrow("Existing artifact differs");
    await expect(run({ conflict: true })).rejects.toThrow("412");
  });
  it("keeps the channel unchanged if an installer upload fails", async () => {
    await expect(run({ uploadFailure: true })).rejects.toThrow("503");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([url, init]) =>
            init?.method === "POST" && new URL(url as string).searchParams.get("name")?.endsWith("latest-v2.json"),
        ),
    ).toBe(false);
  });
  it("does not treat cloud authorization failures as a missing manifest", async () => {
    await expect(run({ storageDenied: true })).rejects.toThrow("403");
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});
