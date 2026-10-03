# ADR 0014: Desktop distribution, signing and updates

- Status: Proposed (M0); built in M14

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
- **Updates:** Tauri updater with a **static `latest.json`** per channel (`stable`, `beta`) in the private `releases` bucket.
  - The app fetches it through `api` (`GET /releases/{channel}/latest.json`), which returns short-lived **signed URLs**. There are no public buckets.
  - The updater public key is in `tauri.conf.json`. The private key and password live only in GitHub Actions secrets.
- **CI:** a matrix on ubuntu/windows/macos runners.
  - PRs build unsigned artifacts.
  - Tags build signed **draft** releases, when the secrets exist.
  - Publishing (promoting the draft and updating `latest.json`) needs the owner's go.

## Consequences
- Linux Wayland: click-through polling needs `cursorPosition()`, which returns (0,0) on native Wayland. The app sets `GDK_BACKEND=x11` (XWayland) for the pet window, and native Wayland is best effort (D-006).
- First Windows downloads will show SmartScreen warnings until reputation accrues. This is documented on `/descargar`.
