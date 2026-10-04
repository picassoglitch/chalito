import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
// Server-side JSON types (same wire shapes as the browser package's, without DOM types), so Node
// packages without the DOM lib (the agent) can use this authenticator.
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/**
 * A software WebAuthn authenticator for tests (Node only; never imported by the app). It
 * fits the browser `Ceremonies` (structurally), producing real attestation ("none") and assertion
 * responses signed with ES256 (P-256) or EdDSA (Ed25519), so the API's @simplewebauthn/server
 * checks and the agent's own verifier run against genuine bytes.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

// ---- minimal CBOR encoder (maps, ints, bytes, text)
type CborValue = number | Uint8Array | string | Map<number | string, CborValue>;
const head = (major: number, n: number): number[] =>
  n < 24
    ? [(major << 5) | n]
    : n < 256
      ? [(major << 5) | 24, n]
      : n < 65536
        ? [(major << 5) | 25, n >> 8, n & 255]
        : [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const cbor = (v: CborValue): number[] => {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  const out = head(5, v.size);
  for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
  return out;
};

const coseKey = (alg: -7 | -8, pub: KeyObject): Uint8Array => {
  const jwk = pub.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const m =
    alg === -8
      ? new Map<number, CborValue>([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, x],
        ])
      : new Map<number, CborValue>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, x],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ]);
  return new Uint8Array(cbor(m));
};

export interface SoftAuthenticatorOptions {
  origin: string;
  alg?: -7 | -8;
  /** Override the authenticator flags (default UP|UV). */
  flags?: number;
}

export class SoftAuthenticator {
  readonly alg: -7 | -8;
  readonly #keys: { publicKey: KeyObject; privateKey: KeyObject };
  readonly #credId = randomBytes(16);
  #counter = 0;
  #rpId: string | null = null;

  constructor(private readonly opts: SoftAuthenticatorOptions) {
    this.alg = opts.alg ?? -7;
    this.#keys = this.alg === -7 ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
  }

  get credentialId(): string {
    return b64u(this.#credId);
  }

  /** The COSE public key (base64url), as a server stores it after registration. */
  get publicKey(): string {
    return b64u(coseKey(this.alg, this.#keys.publicKey));
  }

  #clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.opts.origin, crossOrigin: false }));
  }

  async create(o: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> {
    const rpId = o.rp.id ?? new URL(this.opts.origin).hostname;
    if (!o.pubKeyCredParams.some((p) => p.alg === this.alg)) throw new Error("authenticator: algorithm not offered");
    this.#rpId = rpId;
    const cose = coseKey(this.alg, this.#keys.publicKey);
    const authData = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([(this.opts.flags ?? 0x05) | 0x40]),
      Buffer.from([0, 0, 0, this.#counter]),
      Buffer.alloc(16),
      Buffer.from([this.#credId.length >> 8, this.#credId.length & 255]),
      this.#credId,
      cose,
    ]);
    const attestationObject = new Uint8Array(
      cbor(
        new Map<string, CborValue>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      ),
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.#clientData("webauthn.create", o.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** A step-up assertion over `challenge`, in the protocol's WebAuthnAssertion shape. */
  stepUp(rpId: string) {
    return async (challenge: Uint8Array) => {
      const r = await this.get({
        challenge: b64u(challenge),
        rpId,
        allowCredentials: [{ id: this.credentialId, type: "public-key" }],
      });
      return {
        credentialId: r.id,
        authenticatorData: r.response.authenticatorData,
        clientDataJSON: r.response.clientDataJSON,
        signature: r.response.signature,
      };
    };
  }

  async get(o: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> {
    const rpId = o.rpId ?? this.#rpId ?? new URL(this.opts.origin).hostname;
    if (o.allowCredentials?.length && !o.allowCredentials.some((c) => c.id === this.credentialId))
      throw new Error("authenticator: credential not allowed");
    const authData = Buffer.concat([
      createHash("sha256").update(rpId).digest(),
      Buffer.from([this.opts.flags ?? 0x05]),
      Buffer.from([0, 0, 0, ++this.#counter]),
    ]);
    const clientDataJSON = this.#clientData("webauthn.get", o.challenge);
    const data = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
    const signature =
      this.alg === -7
        ? sign("sha256", data, { key: this.#keys.privateKey, dsaEncoding: "der" })
        : sign(null, data, this.#keys.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
    };
  }
}
