// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ready } from "@chalito/crypto";
import { parsePublicKey, verifyMinisign } from "../src/minisign.js";

/**
 * A REAL pair produced by `tauri signer generate` + `tauri signer sign` (2.12.1) over the bytes
 * "hello release\n". Public data only: the private key was a throwaway and is not kept.
 */
const TAURI_PUB =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDkxOTc5NEUxQjU0RkI3MEEKUldRS3QwKzE0WlNYa2MrSHorekQvbXdtd2ZoMUlycC8rRExFbnZHNHhsR1k3blV0WllKNnc5VXIK";
const TAURI_SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRS3QwKzE0WlNYa2FRaVFZSUsvYzY5Ukw3cHFLd09YVmNmOFNlamdHbU1OWDlvTGREc3M2QmkzVk5TTEF3a2swQzhId3ZvaGtkY3czaGFFejhiVHY2ZGtZeUhQRXc4MndNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxMDg2NDI0CWZpbGU6YXJ0aWZhY3QuYmluCitvNEdHVUdjVkYrQzlJS2x5SDVnNHpJS29iN3dFanRUTkpOQTFZM05DUHBhT0Z3Q1hQOFFsWDNxUjdsN3N1M1p2UzZBOW41N2VITzlGS1lnazVDRkNRPT0K";
const TAURI_FILE = new TextEncoder().encode("hello release\n");

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** A minisign keypair + signer, the way minisign / tauri lay it out. */
const minisign = async (alg: "ED" | "Ed" = "ED") => {
  const sodium = await ready();
  const kp = sodium.crypto_sign_keypair();
  const keyId = sodium.randombytes_buf(8);
  const pub = btoa(
    `untrusted comment: minisign public key\n${b64(new Uint8Array([0x45, 0x64, ...keyId, ...kp.publicKey]))}\n`,
  );
  const sign = (file: Uint8Array, comment = "timestamp:1\tfile:x", o: { keyId?: Uint8Array } = {}) => {
    const msg = alg === "ED" ? sodium.crypto_generichash(64, file, null) : file;
    const sig = sodium.crypto_sign_detached(msg, kp.privateKey);
    const head = new Uint8Array([...new TextEncoder().encode(alg), ...(o.keyId ?? keyId), ...sig]);
    const global = sodium.crypto_sign_detached(
      new Uint8Array([...sig, ...new TextEncoder().encode(comment)]),
      kp.privateKey,
    );
    return btoa(`untrusted comment: signature\n${b64(head)}\ntrusted comment: ${comment}\n${b64(global)}\n`);
  };
  return { pub, sign };
};

describe("minisign (Tauri updater signatures)", () => {
  it("verifies a signature made by the real tauri signer", async () => {
    expect(await verifyMinisign(TAURI_PUB, TAURI_SIG, TAURI_FILE)).toMatchObject({
      ok: true,
      trustedComment: expect.stringContaining("file:artifact.bin"),
    });
    const tampered = TAURI_FILE.slice();
    tampered[0]! ^= 1;
    expect(await verifyMinisign(TAURI_PUB, TAURI_SIG, tampered)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each(["ED", "Ed"] as const)("%s: valid, tampered file, another key, edited trusted comment", async (alg) => {
    const k = await minisign(alg);
    const other = await minisign(alg);
    const file = new TextEncoder().encode("Chalito_1.0.0_amd64.AppImage bytes");
    const sig = k.sign(file);
    expect((await verifyMinisign(k.pub, sig, file)).ok).toBe(true);
    expect(await verifyMinisign(k.pub, sig, new TextEncoder().encode("other"))).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyMinisign(other.pub, sig, file)).toEqual({ ok: false, reason: "key_mismatch" });
    // Same key id, different key: the signature itself fails.
    const forged = atob(sig).replace(/^trusted comment: .*$/m, "trusted comment: timestamp:9\tfile:evil");
    expect(await verifyMinisign(k.pub, btoa(forged), file)).toEqual({ ok: false, reason: "bad_comment_signature" });
  });

  it("refuses malformed keys and signatures", async () => {
    const k = await minisign();
    const file = new Uint8Array([1, 2, 3]);
    expect(await verifyMinisign("not a key", k.sign(file), file)).toEqual({ ok: false, reason: "malformed_key" });
    expect(await verifyMinisign(k.pub, "garbage", file)).toEqual({ ok: false, reason: "malformed_signature" });
    expect(await verifyMinisign(k.pub, btoa("untrusted comment: x\nAAAA\n"), file)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
    expect(parsePublicKey(TAURI_PUB)?.pk).toHaveLength(32);
  });
});
