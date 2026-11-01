# ADR 0014: Desktop distribution, signing and updates

- Status: Proposed (M0); built in M14; signing choices updated 2026-10-16 (M17, see the end)

## Verified context (2026-10-03)
- Tauri **2.12.1**. Bundle targets: `appimage`, `deb`, `rpm`, `nsis`, `msi`, `app`, `dmg`.
- `macOSPrivateApi` is a no-op in 2.12.1+ (transparency always available).
- Updater plugin 2.13: signature verification is mandatory and **cannot be disabled**. Keys come from `tauri signer generate`.
- `tauri-apps/tauri-action@v1` supports `releaseDraft` and `uploadUpdaterJson`.
- Windows: EV no longer bypasses SmartScreen (2024 change). Azure **Artifact Signing** (formerly Trusted Signing) works via `signCommand`.
- macOS notarization env: `APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`, or App Store Connect API keys.

## Decision
- **Artifacts:** Linux AppImage + `.deb` + `.rpm`; Windows **NSIS**; macOS `.dmg` built as `universal-apple-darwin`, with the sidecar lipo'd to universal.
- **Windows signing:** **Azure Artifact Signing** by default. It is cheaper than an OV/EV certificate, cloud-held and CI-friendly; OV certificate as the alternative (owner decision #24). Reputation builds over time either way.
- **macOS:** Developer ID signing + notarization with **App Store Connect API keys** (`APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`) rather than an Apple ID password. The bun-compiled sidecar gets hardened-runtime JIT entitlements and is signed with the app.
  - Brief deviation: `APPLE_APP_SPECIFIC_PASSWORD` is not a Tauri variable; it is `APPLE_PASSWORD`. Recorded as D-011.
- **Linux:** AppImage GPG signature (`SIGN=1`) plus published checksums. deb/rpm repos are out of scope in beta; downloads only.
- **Updates:** Tauri updater with a **static manifest** per channel (`stable`, `beta`) in the private `releases` bucket.
  - The app fetches it through `api` (`GET /releases/{channel}/latest-v2.json`), which returns short-lived **signed URLs**. There are no public buckets.
  - Builds before 0.1.0-beta.13 ask for `latest.json`. That file is frozen at 0.1.0-beta.13 (the bridge, `LEGACY_BRIDGE_VERSION`), the first build with the v2 endpoint and the glibc gate, so an old install never reaches a later build its system may not run (2026-10-28, the Linux build moving to Ubuntu 24.04).
  - The bridge is a beta release, and only the beta channel gets a frozen `latest.json`. No stable install exists (every tag so far is a beta), so the stable channel starts on `latest-v2.json` and never writes `latest.json`; a stable request for it answers 404 (2026-10-28).
  - The updater public key is in `tauri.conf.json`. The private key and password live only in GitHub Actions secrets.
- **CI:** a matrix on ubuntu/windows/macos runners.
  - PRs build unsigned artifacts.
  - Tags build signed **draft** releases, when the secrets exist.
  - Publishing (promoting the draft and updating `latest-v2.json`) needs the owner's go.

## Consequences
- Linux Wayland: click-through polling needs `cursorPosition()`, which returns (0,0) on native Wayland. The app sets `GDK_BACKEND=x11` (XWayland) for the pet window, and native Wayland is best effort (D-006).
- First Windows downloads will show SmartScreen warnings until reputation accrues. This is documented on `/descargar`.

## Update 2026-10-16 (M17): what the owner decided
Owner decisions: **full macOS signing** (the owner has an Apple Developer account), **no paid Windows signing**. This resolves decision #24 (Windows signing: none for now) and replaces the Azure Artifact Signing default above.

| OS | Artifacts | Signing | What the user sees |
|---|---|---|---|
| macOS | universal `.dmg` (+ updater `.app.tar.gz`) | **Developer ID Application** + hardened runtime (JIT entitlements for the bun sidecar, `entitlements.plist`) + **notarization** with an App Store Connect API key (`notarytool`, run by the Tauri bundler) + stapled ticket | Opens normally, no Gatekeeper warning |
| Windows | NSIS `-setup.exe` (+ updater `.nsis.zip`) | **No Authenticode.** Updates are still verified with the Tauri updater key, which can't be turned off | SmartScreen "Windows protected your PC" on first run: *More info* → *Run anyway*. `/descargar` shows the two steps with screenshots and the SHA-256 |
| Linux | AppImage + `.deb` (+ `.rpm` as built today) | AppImage GPG signature (optional, free) + published checksums | No warning; `chmod +x` for the AppImage |

### macOS: exactly what the owner creates in the Apple portal
The release workflow (`.github/workflows/release.yml`) and `apps/desktop/scripts/release/plan.ts` already read these. A certificate without the notarization key is refused (never half-signed).

| # | Create | Where | Becomes the GitHub **secret** |
|---|---|---|---|
| 1 | Note the **Team ID** (10 characters) | developer.apple.com → Account → Membership details | Part of `APPLE_SIGNING_IDENTITY`; no separate secret (the workflow doesn't read `APPLE_TEAM_ID`) |
| 2 | A **Developer ID Application** certificate (not "Installer", not "Apple Distribution"). Needs the **Account Holder** role. Make a CSR in Keychain Access on a Mac, upload it, download the `.cer`, install it, then export the certificate **with its private key** as a `.p12` with a strong password. Apple allows at most 5 | Certificates, Identifiers & Profiles → Certificates → + → Developer ID Application | `APPLE_CERTIFICATE` = `base64 -i cert.p12`; `APPLE_CERTIFICATE_PASSWORD` = the .p12 password; `APPLE_SIGNING_IDENTITY` = `Developer ID Application: <Name> (<TEAMID>)` exactly as Keychain shows it |
| 3 | An **App Store Connect API key** (Team key) with the **Developer** role, for `notarytool`. The `.p8` can be downloaded **once** | App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys | `APPLE_API_ISSUER` = Issuer ID; `APPLE_API_KEY` = Key ID; `APPLE_API_PRIVATE_KEY` = the full text of `AuthKey_<KeyID>.p8` (CI writes it to a file and sets `APPLE_API_KEY_PATH`) |
| 4 | Accept the latest Program License Agreement | developer.apple.com → Account | — (notarization fails with an agreement error otherwise) |

Not needed: an App ID or provisioning profile (no restricted entitlements), a Developer ID Installer certificate (we ship a DMG, not a `.pkg`), an app-specific password (we use the API key, D-011). The bundle identifier is `com.chalyb.chalito` (`tauri.conf.json`).

Back up the `.p12`, its password and the `.p8` offline, next to the updater key. If a certificate is ever revoked, Gatekeeper can refuse the builds signed with it, so rotate by creating a new certificate, updating the three secrets and cutting a new release.

### Windows: unsigned, on purpose
- Azure Artifact Signing (`AZURE_*`, `ARTIFACT_SIGNING_*`) stays supported in `plan.ts` and is simply left unset. If the owner changes their mind, adding those secrets signs the next build with no code change.
- The Windows build is labelled `unsigned` today (`UNSIGNED_` file names). M17 phase B changes the release tooling so that **Windows unsigned is an accepted state for publishing** (label `unsigned-authenticode`, still updater-signed), while an unsigned macOS build or a test updater key still blocks publishing.
- SmartScreen reputation never builds without a certificate, so the warning stays. That is documented, not hidden.

### Linux
- AppImage and `.deb` are the documented downloads; `.rpm` keeps building. GPG for the AppImage is optional and free (`APPIMAGE_GPG_PRIVATE_KEY`, `APPIMAGE_SIGN_KEY`, `APPIMAGETOOL_SIGN_PASSPHRASE`).


## 2026-10-31: automatic tag publication

The owner requested automated building and publishing. Version-tag pushes now promote the verified artifacts to the private releases bucket and publish the GitHub draft. This supersedes the earlier manual-publication requirement. Manual workflow dispatch remains a dry run. The production updater key is mandatory, stable code-signing requirements remain enforced, and beta may retain labelled unsigned OS installers. The dedicated GitHub OIDC publisher is restricted to this repository's release-tag workflow. Installers arrive before the generation-guarded channel manifest; the legacy bridge manifest is never changed. See `docs/OPS.md` section 10 for one-time configuration and retry behavior.
