/**
 * Release build plan per OS (ADR 0014, D-011): which signing applies, given the secrets that
 * exist, and the Tauri config overlay that turns the dev config into a release build (bundle
 * targets, sidecar, updater artifacts + public key + endpoint, signing hooks).
 *
 * Signing secrets may not exist yet (owner OPS items): every hook then skips cleanly and the
 * build is LABELLED unsigned (file names, manifest, draft notes). Never half-signed: a macOS
 * certificate without notarization keys is an error, not a quietly broken DMG.
 */
import { UPDATER_MANIFEST } from "@chalito/releases";

export type Os = "linux" | "windows" | "macos";
export type Env = Record<string, string | undefined>;

const has = (env: Env, ...keys: string[]) => keys.every((k) => (env[k] ?? "").trim() !== "");

export const WINDOWS_SIGNING = [
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "ARTIFACT_SIGNING_ENDPOINT",
  "ARTIFACT_SIGNING_ACCOUNT",
  "ARTIFACT_SIGNING_PROFILE",
] as const;
export const MACOS_CERT = ["APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "APPLE_SIGNING_IDENTITY"] as const;
/** App Store Connect API key notarization (D-011), not an Apple ID password. */
export const MACOS_NOTARY = ["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH"] as const;
export const LINUX_GPG = ["APPIMAGE_SIGN_KEY", "APPIMAGETOOL_SIGN_PASSPHRASE"] as const;

export interface PlanInput {
  os: Os;
  env: Env;
  version: string;
  channel: "stable" | "beta";
  apiBase: string;
  /** Updater public key (tauri signer). In CI tests: a throwaway key generated in the job. */
  updaterPubkey: string;
  updaterKey: "release" | "test";
  /** `app.security.csp` of src-tauri/tauri.conf.json: its connect-src must allow `apiBase`. */
  csp: string;
}

export interface Plan {
  signed: boolean;
  /** `signed` or `unsigned`: prefixed to file names and written into the manifest. */
  label: "signed" | "unsigned";
  /** Extra env for `tauri build` (signing toolchains read these). */
  buildEnv: Record<string, string>;
  overlay: Record<string, unknown>;
  notes: string[];
}

const TARGETS: Record<Os, string[]> = {
  linux: ["appimage", "deb", "rpm"],
  windows: ["nsis"],
  macos: ["app", "dmg"],
};

/** The sources a CSP directive lists (empty when it's absent). */
const directive = (csp: string, name: string): string[] =>
  (
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .find(([n]) => n === name) ?? []
  ).slice(1);

/** The origins a CSP's `connect-src` lists. */
export const connectSrc = (csp: string): string[] => directive(csp, "connect-src");

/** A connect-src entry that is an api host: `https://api.…`, or a Cloud Run `https://….run.app`. */
const API_HOST = /^https:\/\/(?:api\.[^/]+|[^/]+\.run\.app)$/;

/**
 * The app talks to exactly the api it was built for: the CSP must allow `apiBase`'s origin and no
 * other api host (`api.…` or a `….run.app` service), or a build would sign in fine and then fail
 * every request (ADR 0028 §A). `where` names the CSP in the error: tauri.conf.json's or the overlay's.
 */
export const checkCsp = (csp: string, apiBase: string, where = "tauri.conf.json CSP") => {
  // libsodium (device keys, sealing) is WebAssembly: without this the sign-in hangs enrolling (2026-10-27).
  const scripts = directive(csp, "script-src");
  const wasm = (scripts.length ? scripts : directive(csp, "default-src")).includes("'wasm-unsafe-eval'");
  if (!wasm) throw new Error(`${where} script-src doesn't allow 'wasm-unsafe-eval' (libsodium)`);
  const origin = new URL(apiBase).origin;
  const src = connectSrc(csp);
  if (!src.includes(origin)) throw new Error(`${where} connect-src doesn't allow ${origin}`);
  const stale = src.filter((s) => API_HOST.test(s) && s !== origin);
  if (stale.length) throw new Error(`${where} connect-src allows another api: ${stale.join(" ")}`);
};

export const releasePlan = (i: PlanInput): Plan => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(i.version)) throw new Error(`bad version ${i.version}`);
  if (!i.updaterPubkey.trim()) throw new Error("updater public key missing");
  if (!i.apiBase.startsWith("https://")) throw new Error("apiBase must be https");
  checkCsp(i.csp, i.apiBase);
  const notes: string[] = [];
  const buildEnv: Record<string, string> = {};
  const bundle: Record<string, unknown> = {
    active: true,
    targets: TARGETS[i.os],
    createUpdaterArtifacts: true,
    externalBin: ["binaries/chalito-agent"],
  };
  let signed = false;

  if (i.os === "windows") {
    if (has(i.env, ...WINDOWS_SIGNING)) {
      signed = true;
      bundle.windows = {
        signCommand: {
          cmd: "artifact-signing-cli",
          args: [
            "-e",
            i.env.ARTIFACT_SIGNING_ENDPOINT!,
            "-a",
            i.env.ARTIFACT_SIGNING_ACCOUNT!,
            "-c",
            i.env.ARTIFACT_SIGNING_PROFILE!,
            "-d",
            "Chalito",
            "%1",
          ],
        },
      };
    } else notes.push("windows: Azure Artifact Signing secrets absent; NSIS installer is unsigned");
  }

  if (i.os === "macos") {
    const cert = has(i.env, ...MACOS_CERT);
    const notary = has(i.env, ...MACOS_NOTARY);
    if (cert && !notary)
      throw new Error(
        "macOS certificate present but App Store Connect API keys missing: refusing to sign without notarization",
      );
    // Bun's compiled sidecar needs JIT under the hardened runtime.
    const macOS: Record<string, unknown> = {
      hardenedRuntime: true,
      entitlements: "entitlements.plist",
      minimumSystemVersion: "11.0",
    };
    if (cert && notary) signed = true;
    else {
      // Ad-hoc: arm64 refuses to run entirely unsigned code; Gatekeeper will still warn.
      macOS.signingIdentity = "-";
      notes.push("macos: Developer ID / notarization secrets absent; ad-hoc signed, not notarized");
    }
    bundle.macOS = macOS;
  }

  if (i.os === "linux") {
    if (has(i.env, ...LINUX_GPG)) {
      signed = true;
      Object.assign(buildEnv, { SIGN: "1", SIGN_KEY: i.env.APPIMAGE_SIGN_KEY!, APPIMAGETOOL_FORCE_SIGN: "1" });
    } else notes.push("linux: AppImage GPG key absent; AppImage is unsigned (deb/rpm are never signed in beta)");
  }

  // Stable is the public channel: an unsigned Windows installer (SmartScreen) or a macOS app
  // that isn't notarized (Gatekeeper) never ships there; beta allows them, labelled UNSIGNED_.
  if (i.channel === "stable" && !signed && (i.os === "windows" || i.os === "macos"))
    throw new Error(`${i.os}: the stable channel needs a signed build; use a beta (x.y.z-beta.n) version`);

  if (i.updaterKey === "test")
    notes.push("updater: signed with a THROWAWAY test key; this build can't update real installs");

  const overlay = {
    version: i.version,
    bundle,
    plugins: {
      updater: {
        pubkey: i.updaterPubkey.trim(),
        endpoints: [`${i.apiBase.replace(/\/+$/, "")}/releases/${i.channel}/${UPDATER_MANIFEST}`],
        windows: { installMode: "passive" },
      },
    },
  };
  checkOverlay(i.csp, overlay, i.apiBase);
  return { signed, label: signed ? "signed" : "unsigned", buildEnv, notes, overlay };
};

/**
 * The overlay is what the release build actually runs with (the updater exists only there,
 * src-tauri/src/lib.rs `has_updater`): every updater endpoint is on the api's origin, and the
 * CSP the build ends up with (the overlay's, if it sets one, else tauri.conf.json's) allows it.
 */
export const checkOverlay = (baseCsp: string, overlay: Record<string, unknown>, apiBase: string) => {
  const origin = new URL(apiBase).origin;
  const app = overlay.app as { security?: { csp?: string } } | undefined;
  const own = app?.security?.csp;
  checkCsp(own ?? baseCsp, apiBase, own === undefined ? "tauri.conf.json CSP" : "release overlay CSP");
  const updater = (overlay.plugins as { updater?: { endpoints?: string[] } } | undefined)?.updater;
  const endpoints = updater?.endpoints ?? [];
  if (!endpoints.length) throw new Error("release overlay has no updater endpoint");
  const off = endpoints.filter((e) => new URL(e).origin !== origin);
  if (off.length) throw new Error(`updater endpoint not on ${origin}: ${off.join(" ")}`);
};

/** `UNSIGNED_Chalito_1.2.0_x64-setup.exe`: unsigned files say so wherever they end up. */
export const labelName = (name: string, label: Plan["label"]) =>
  label === "unsigned" && !name.startsWith("UNSIGNED_") ? `UNSIGNED_${name}` : name;
