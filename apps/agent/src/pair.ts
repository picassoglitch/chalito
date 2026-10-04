import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { TrustedClientList, deriveDeviceId, fingerprint, fromB64url, randomNonce } from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import { CreatePairingCodeResponse, PAIRING_TTL_MS, PairingCodeDoc } from "@chalito/protocol";
import {
  firebasePairingWatcher,
  postJson,
  supabasePairingWatcher,
  type FetchFn,
  type PairingWatcher,
} from "./cloud.js";
import { createEphemeralAuth, exchangeTokenHash } from "./device-auth.js";
import { ConfigTamperedError, readConfig, writeConfig } from "./config.js";
import type { OsAuth } from "./devmode.js";
import { loadOrCreateIdentity } from "./identity.js";
import type { SecretStore } from "./secrets.js";
import { TrustStore } from "./trust-store.js";

const COPY = {
  es: {
    code: (c: string) =>
      `\nEn tu teléfono, abre Chalito → Agregar computadora y escanea el glifo o escribe:\n\n    ${c}\n\n`,
    thisFp: (fp: string) => `Huella de esta computadora: ${fp}\n`,
    expires: (min: number) => `El código vence en ${min} minutos. Esperando a tu teléfono…\n`,
    claimed: (fp: string) => `\nTu teléfono reclamó esta computadora. Huella del teléfono:\n\n    ${fp}\n\n`,
    confirm: "¿Coincide con la huella que muestra tu teléfono? [s/N] ",
    paired: "Listo: esta computadora confía en tu teléfono. Instala el servicio con `chalito service install`.\n",
    rejected:
      "No se agregó nada. Si no reconoces ese teléfono, revoca esta computadora desde un teléfono de confianza.\n",
    expired: "El código venció. Ejecuta `chalito pair` otra vez.\n",
    authFailed: "La autenticación del sistema falló. No se emparejó nada.\n",
    replaceWarn: (from: string | null, to: string) =>
      `\nATENCIÓN: esto reemplaza la cuenta de esta computadora (${from ?? "desconocida"} → ${to}) y borra los teléfonos de confianza actuales.\n`,
    replacePrompt: 'Escribe "REEMPLAZAR" para continuar: ',
    replacePhrase: "REEMPLAZAR",
  },
  en: {
    code: (c: string) => `\nOn your phone, open Chalito → Add computer and scan the glyph or type:\n\n    ${c}\n\n`,
    thisFp: (fp: string) => `This computer's fingerprint: ${fp}\n`,
    expires: (min: number) => `The code expires in ${min} minutes. Waiting for your phone…\n`,
    claimed: (fp: string) => `\nYour phone claimed this computer. Phone fingerprint:\n\n    ${fp}\n\n`,
    confirm: "Does it match the fingerprint your phone shows? [y/N] ",
    paired: "Done: this computer trusts your phone. Install the service with `chalito service install`.\n",
    rejected: "Nothing was added. If you don't recognise that phone, revoke this computer from a trusted phone.\n",
    expired: "The code expired. Run `chalito pair` again.\n",
    authFailed: "OS authentication failed. Nothing was paired.\n",
    replaceWarn: (from: string | null, to: string) =>
      `\nWARNING: this replaces this computer's account (${from ?? "unknown"} → ${to}) and removes the current trusted phones.\n`,
    replacePrompt: 'Type "REPLACE" to continue: ',
    replacePhrase: "REPLACE",
  },
} as const;

export interface PairDeps {
  dir: string;
  env?: Record<string, string | undefined>;
  secrets: SecretStore;
  fetch: FetchFn;
  watcher?: PairingWatcher;
  /** Local y/N for the reverse fingerprint check. */
  confirm: (question: string) => Promise<boolean>;
  /** Asks the user to type `phrase` exactly; used before replacing an account or trust list. */
  confirmTyped: (question: string, phrase: string) => Promise<boolean>;
  /** OS user authentication; pairing decides who can control this computer. */
  osAuth: OsAuth;
  out: (s: string) => void;
  now?: () => number;
  hostname?: string;
  platform?: NodeJS.Platform;
  kind?: "desktop" | "laptop";
}

export type PairResult =
  | { ok: true; owner: string; deviceId: string; phoneDeviceId: string }
  | { ok: false; reason: "expired" | "rejected_locally" | "bad_claim" | "os_auth_failed" | "replace_declined" };

const PLATFORMS: Partial<Record<NodeJS.Platform, "linux" | "windows" | "macos">> = {
  linux: "linux",
  win32: "windows",
  darwin: "macos",
};

/**
 * `chalito pair` (ADR 0006, phone-first). The desktop shows its glyph + short code, the
 * phone checks this computer's fingerprint and claims it, then the desktop shows the
 * phone's fingerprint and the user confirms it HERE. Only that local yes adds the
 * phone's key to the trusted list; nothing the cloud says can.
 */
export const runPair = async (deps: PairDeps): Promise<PairResult> => {
  const now = deps.now ?? Date.now;
  const base = readConfig(deps.dir, deps.env);
  const c = COPY[base.locale];
  const platform = PLATFORMS[deps.platform ?? process.platform];
  if (!platform) throw new Error(`unsupported platform ${deps.platform ?? process.platform}`);

  if (!(await deps.osAuth.verify("Chalito: emparejar esta computadora"))) {
    deps.out(c.authFailed);
    return { ok: false, reason: "os_auth_failed" };
  }
  const id = await loadOrCreateIdentity(deps.secrets);
  // The owner on record only counts if config.json still carries the agent's signature.
  let ownerOnRecord = base.owner;
  let ownerVerified = true;
  if (base.owner !== null) {
    try {
      readConfig(deps.dir, deps.env, { keys: id.sign });
    } catch (err) {
      if (!(err instanceof ConfigTamperedError)) throw err;
      ownerVerified = false;
      ownerOnRecord = null;
    }
  }
  const issuedAt = now();
  const glyph = await signGlyph(
    {
      v: 1,
      purpose: "pair_device",
      codeId: await randomNonce(),
      issuerPubSign: id.pubSign,
      issuerPubBox: id.pubBox,
      label: (deps.hostname ?? osHostname()).slice(0, 40),
      issuedAt,
      expiresAt: issuedAt + PAIRING_TTL_MS,
      nonce: await randomNonce(),
    },
    id.sign.secretKey,
  );
  const created = CreatePairingCodeResponse.parse(
    await postJson(deps.fetch, `${base.apiBase}/v1/pairing/codes`, {
      glyph,
      kind: deps.kind ?? "desktop",
      platform,
    }),
  );
  deps.out(c.code(created.shortCode));
  deps.out(c.thisFp(id.fingerprint));
  deps.out(c.expires(Math.round((created.expiresAt - now()) / 60_000)));

  // Wait for the claim (event-driven), or the code's expiry.
  const watcher =
    deps.watcher ??
    (base.supabase
      ? supabasePairingWatcher(base.supabase, {
          // Device-user mode: the API's watch credential is a magic-link token_hash for a pairing user.
          ...(base.supabase.auth === "device-user"
            ? {
                exchange: (h: string) =>
                  exchangeTokenHash(createEphemeralAuth(base.supabase!.url, base.supabase!.publishableKey), h),
              }
            : {}),
        })
      : firebasePairingWatcher(base.firebase!, deps.env ?? process.env));
  let onClaim!: (d: PairingCodeDoc | null) => void;
  const claim = new Promise<PairingCodeDoc | null>((resolve) => (onClaim = resolve));
  const expiry = setTimeout(() => onClaim(null), Math.max(0, created.expiresAt - now()));
  const watching = watcher.watch(created.watchToken, glyph.body.codeId, (data) => {
    const parsed = PairingCodeDoc.safeParse(data);
    if (parsed.success && parsed.data.claimed) onClaim(parsed.data);
  });
  const claimed = await Promise.race([claim, watching.then(() => claim)]).finally(() => clearTimeout(expiry));
  await watching.then((stop) => stop()).catch(() => undefined);

  if (!claimed) {
    deps.out(c.expired);
    return { ok: false, reason: "expired" };
  }

  // The doc must describe THIS device and carry a phone key that matches its device id.
  const { owner, claimedByDeviceId, claimerPubSign, claimerPubBox } = claimed;
  if (
    claimed.agentDeviceId !== id.deviceId ||
    claimed.glyph.body.issuerPubSign !== id.pubSign ||
    !owner ||
    !claimedByDeviceId ||
    !claimerPubSign ||
    !claimerPubBox ||
    (await deriveDeviceId(await fromB64url(claimerPubSign))) !== claimedByDeviceId
  ) {
    deps.out(c.rejected);
    return { ok: false, reason: "bad_claim" };
  }

  deps.out(c.claimed(await fingerprint(await fromB64url(claimerPubSign))));
  if (!(await deps.confirm(c.confirm))) {
    deps.out(c.rejected);
    return { ok: false, reason: "rejected_locally" };
  }

  const trustStore = new TrustStore(deps.dir, id.sign, id.deviceId);
  const loaded = await trustStore.load();
  // A different account, or a list that failed its signature, starts from scratch.
  // An owner that fails its signature is unknown, so any claim counts as switching accounts.
  const switching = ownerOnRecord !== null ? ownerOnRecord !== owner : !ownerVerified;
  const reset = loaded.tampered || switching;
  // Never silently: replacing the account or dropping trusted phones needs the typed phrase.
  if (reset && (switching || loaded.list.toJSON().length > 0 || existsSync(trustStore.file))) {
    deps.out(c.replaceWarn(base.owner, owner));
    if (!(await deps.confirmTyped(c.replacePrompt, c.replacePhrase))) {
      deps.out(c.rejected);
      return { ok: false, reason: "replace_declined" };
    }
  }
  const list = reset ? new TrustedClientList(id.deviceId) : loaded.list;
  await list.addConfirmed({ deviceId: claimedByDeviceId, pubSign: claimerPubSign, pubBox: claimerPubBox }, now());
  await trustStore.save(list);
  writeConfig(deps.dir, { ...base, owner, deviceId: id.deviceId }, id.sign);
  deps.out(c.paired);
  return { ok: true, owner, deviceId: id.deviceId, phoneDeviceId: claimedByDeviceId };
};
