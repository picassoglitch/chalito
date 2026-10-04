// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { ready } from "@chalito/crypto";
import { collectArtifacts, mergeManifest } from "../scripts/release/collect.js";
import {
  LINUX_GPG,
  MACOS_CERT,
  MACOS_NOTARY,
  WINDOWS_SIGNING,
  labelName,
  releasePlan,
  type Os,
} from "../scripts/release/plan.js";
import { sidecarPlan } from "../scripts/release/sidecar.js";

const BASE = {
  version: "1.2.0",
  channel: "stable" as const,
  apiBase: "https://api.chalito.chalyb.com",
  updaterKey: "test" as const,
};
const PUB = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="; // shape only for plan tests
const all = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, `value-of-${k}`]));

describe("release plan: signing hooks skip cleanly without secrets", () => {
  it.each(["linux", "windows", "macos"] as const)(
    "%s without secrets → labelled unsigned, no signing config",
    (os: Os) => {
      const p = releasePlan({ ...BASE, os, env: {}, updaterPubkey: PUB });
      expect(p.signed).toBe(false);
      expect(p.label).toBe("unsigned");
      expect(p.notes.join(" ")).toMatch(/unsigned|not notarized/);
      expect(p.notes.join(" ")).toMatch(/THROWAWAY test key/);
      const bundle = p.overlay.bundle as Record<string, Record<string, unknown>>;
      expect(bundle.windows?.signCommand).toBeUndefined();
      expect(p.buildEnv.SIGN).toBeUndefined();
      if (os === "macos") expect(bundle.macOS).toMatchObject({ signingIdentity: "-", hardenedRuntime: true });
    },
  );

  it("windows signs with Azure Artifact Signing when every secret exists", () => {
    const p = releasePlan({ ...BASE, os: "windows", env: all(WINDOWS_SIGNING), updaterPubkey: PUB });
    expect(p.label).toBe("signed");
    expect((p.overlay.bundle as { windows: unknown }).windows).toEqual({
      signCommand: {
        cmd: "artifact-signing-cli",
        args: [
          "-e",
          "value-of-ARTIFACT_SIGNING_ENDPOINT",
          "-a",
          "value-of-ARTIFACT_SIGNING_ACCOUNT",
          "-c",
          "value-of-ARTIFACT_SIGNING_PROFILE",
          "-d",
          "Chalito",
          "%1",
        ],
      },
    });
    // One missing (or blank) secret: unsigned, not a broken signing attempt.
    const partial = { ...all(WINDOWS_SIGNING), AZURE_CLIENT_SECRET: " " };
    expect(releasePlan({ ...BASE, os: "windows", env: partial, updaterPubkey: PUB }).label).toBe("unsigned");
  });

  it("macOS signs only with Developer ID AND notarization keys; never half-signed", () => {
    const signed = releasePlan({
      ...BASE,
      os: "macos",
      env: { ...all(MACOS_CERT), ...all(MACOS_NOTARY) },
      updaterPubkey: PUB,
    });
    expect(signed.label).toBe("signed");
    expect((signed.overlay.bundle as { macOS: Record<string, unknown> }).macOS.signingIdentity).toBeUndefined();
    expect(() => releasePlan({ ...BASE, os: "macos", env: all(MACOS_CERT), updaterPubkey: PUB })).toThrow(
      /notarization/,
    );
  });

  it("linux GPG-signs the AppImage when the key exists", () => {
    const p = releasePlan({ ...BASE, os: "linux", env: all(LINUX_GPG), updaterPubkey: PUB });
    expect(p.label).toBe("signed");
    expect(p.buildEnv).toEqual({ SIGN: "1", SIGN_KEY: "value-of-APPIMAGE_SIGN_KEY", APPIMAGETOOL_FORCE_SIGN: "1" });
  });

  it("the overlay sets targets, sidecar, updater artifacts, key and the api endpoint", () => {
    const p = releasePlan({ ...BASE, os: "macos", channel: "beta", env: {}, updaterPubkey: `${PUB}\n` });
    expect(p.overlay).toMatchObject({
      version: "1.2.0",
      bundle: { targets: ["app", "dmg"], createUpdaterArtifacts: true, externalBin: ["binaries/chalito-agent"] },
      plugins: { updater: { pubkey: PUB, endpoints: ["https://api.chalito.chalyb.com/releases/beta/latest.json"] } },
    });
    expect(
      (releasePlan({ ...BASE, os: "linux", env: {}, updaterPubkey: PUB }).overlay.bundle as { targets: string[] })
        .targets,
    ).toEqual(["appimage", "deb", "rpm"]);
  });

  it("refuses a bad version, a missing key or a non-https api", () => {
    expect(() => releasePlan({ ...BASE, os: "linux", env: {}, updaterPubkey: PUB, version: "v1" })).toThrow();
    expect(() => releasePlan({ ...BASE, os: "linux", env: {}, updaterPubkey: " " })).toThrow();
    expect(() => releasePlan({ ...BASE, os: "linux", env: {}, updaterPubkey: PUB, apiBase: "http://x" })).toThrow();
  });

  it.each(["linux", "windows", "macos"] as const)(
    "%s overlay merged onto tauri.conf.json is a valid Tauri 2 config",
    (os) => {
      const req = createRequire(import.meta.url);
      const schema = JSON.parse(
        readFileSync(join(dirname(req.resolve("@tauri-apps/cli/package.json")), "config.schema.json"), "utf8"),
      );
      const base = JSON.parse(readFileSync(join(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
      const merge = (a: unknown, b: unknown): unknown =>
        a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)
          ? Object.fromEntries(
              [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [
                k,
                k in (b as object)
                  ? merge((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
                  : (a as Record<string, unknown>)[k],
              ]),
            )
          : (b ?? a);
      const env = os === "windows" ? all(WINDOWS_SIGNING) : {};
      const merged = merge(base, releasePlan({ ...BASE, os, env, updaterPubkey: PUB }).overlay);
      const ajv = new Ajv({
        strict: false,
        allErrors: true,
        validateFormats: false,
        code: { regExp: (p: string, f: string) => new RegExp(p, f.replace("u", "")) } as never,
      });
      const ok = ajv.validate(schema, merged);
      expect(ok, JSON.stringify(ajv.errors)).toBe(true);
    },
  );
});

describe("unsigned label", () => {
  it("unsigned files are named so; signed ones keep their name", () => {
    expect(labelName("Chalito_1.2.0_x64-setup.exe", "unsigned")).toBe("UNSIGNED_Chalito_1.2.0_x64-setup.exe");
    expect(labelName("UNSIGNED_x.dmg", "unsigned")).toBe("UNSIGNED_x.dmg");
    expect(labelName("Chalito_1.2.0_x64-setup.exe", "signed")).toBe("Chalito_1.2.0_x64-setup.exe");
  });
});

describe("sidecar", () => {
  it("copies the agent per triple; macOS lipos both architectures into a universal binary", () => {
    expect(sidecarPlan("linux", "d", "b")).toEqual([
      {
        kind: "copy",
        from: ["d/chalito-agent-x86_64-unknown-linux-gnu"],
        to: "b/chalito-agent-x86_64-unknown-linux-gnu",
      },
    ]);
    expect(sidecarPlan("windows", "d", "b")[0]!.to).toBe("b/chalito-agent-x86_64-pc-windows-msvc.exe");
    expect(sidecarPlan("macos", "d", "b")).toEqual([
      {
        kind: "lipo",
        from: ["d/chalito-agent-aarch64-apple-darwin", "d/chalito-agent-x86_64-apple-darwin"],
        to: "b/chalito-agent-universal-apple-darwin",
      },
    ]);
  });
});

/** A throwaway minisign key in Tauri's format (base64 of the minisign text files). */
const testKey = async () => {
  const sodium = await ready();
  const kp = sodium.crypto_sign_keypair();
  const id = sodium.randombytes_buf(8);
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const pub = b64(
    Buffer.from(`untrusted comment: test\n${b64(new Uint8Array([0x45, 0x64, ...id, ...kp.publicKey]))}\n`),
  );
  const sign = (file: Uint8Array) => {
    const sig = sodium.crypto_sign_detached(sodium.crypto_generichash(64, file, null), kp.privateKey);
    const tc = "timestamp:1\tfile:x";
    const g = sodium.crypto_sign_detached(new Uint8Array([...sig, ...Buffer.from(tc)]), kp.privateKey);
    return b64(
      Buffer.from(
        `untrusted comment: s\n${b64(new Uint8Array([0x45, 0x44, ...id, ...sig]))}\ntrusted comment: ${tc}\n${b64(g)}\n`,
      ),
    );
  };
  return { pub, sign };
};

describe("collect + manifest", () => {
  const bytes = (s: string) => new Uint8Array(Buffer.from(s));

  it("verifies updater signatures, labels unsigned files and hashes everything", async () => {
    const k = await testKey();
    const exe = bytes("nsis installer");
    const arts = await collectArtifacts(
      [
        { name: "Chalito_1.2.0_x64-setup.exe", bytes: exe, sig: k.sign(exe) },
        { name: "notes.txt", bytes: bytes("ignored") },
      ],
      { pubkey: k.pub, label: "unsigned" },
    );
    expect(arts).toEqual([
      {
        source: "Chalito_1.2.0_x64-setup.exe",
        name: "UNSIGNED_Chalito_1.2.0_x64-setup.exe",
        size: exe.byteLength,
        sha256: (await import("node:crypto")).createHash("sha256").update(exe).digest("hex"),
        signature: expect.any(String),
      },
    ]);
  });

  it("stops on a signature that doesn't verify, or a missing one", async () => {
    const k = await testKey();
    const other = await testKey();
    const app = bytes("app bundle");
    await expect(
      collectArtifacts([{ name: "Chalito.app.tar.gz", bytes: app, sig: other.sign(app) }], {
        pubkey: k.pub,
        label: "signed",
      }),
    ).rejects.toThrow(/key_mismatch/);
    await expect(
      collectArtifacts([{ name: "Chalito.app.tar.gz", bytes: bytes("tampered"), sig: k.sign(app) }], {
        pubkey: k.pub,
        label: "signed",
      }),
    ).rejects.toThrow(/bad_signature/);
    await expect(
      collectArtifacts([{ name: "Chalito.AppImage", bytes: app }], { pubkey: k.pub, label: "signed" }),
    ).rejects.toThrow(/without a .sig/);
    await expect(collectArtifacts([{ name: "x.txt", bytes: app }], { pubkey: k.pub, label: "signed" })).rejects.toThrow(
      /no release artifacts/,
    );
  });

  it("merges the three OS results; the manifest says which OS builds are unsigned", async () => {
    const k = await testKey();
    const ai = bytes("appimage");
    const linux = await collectArtifacts(
      [
        { name: "Chalito_1.2.0_amd64.AppImage", bytes: ai, sig: k.sign(ai) },
        { name: "Chalito_1.2.0_amd64.deb", bytes: bytes("deb") },
      ],
      { pubkey: k.pub, label: "signed" },
    );
    const exe = bytes("exe");
    const windows = await collectArtifacts([{ name: "Chalito_1.2.0_x64-setup.exe", bytes: exe, sig: k.sign(exe) }], {
      pubkey: k.pub,
      label: "unsigned",
    });
    const m = mergeManifest({
      channel: "stable",
      version: "1.2.0",
      pubDate: new Date("2026-10-20T00:00:00Z"),
      parts: [
        { os: "linux", label: "signed", artifacts: linux },
        { os: "windows", label: "unsigned", artifacts: windows },
      ],
    });
    expect(m.unsigned).toEqual({ linux: false, windows: true });
    expect(m.platforms["windows-x86_64"]?.url).toBe("stable/1.2.0/UNSIGNED_Chalito_1.2.0_x64-setup.exe");
    expect(m.downloads?.linux?.map((d) => d.name)).toEqual(["Chalito_1.2.0_amd64.AppImage", "Chalito_1.2.0_amd64.deb"]);
  });
});
