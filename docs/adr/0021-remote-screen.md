# ADR 0021: Remote screen (view / control) and AI-driven apps

- Status: Proposed (engine contract 2026-10-06, SCREEN builder); builds on computer control (#31)
- Protocol: `v` stays 1. New commands `screen.open` / `screen.close` / `screen.signal`, events
  `screen.state` / `screen.signal` / `screen.changed`, approval kinds `remote_view`,
  `remote_control`, `app_control` (+ `terminal` for the terminal builder), signing context
  `chalito.screen-signal.v1`, MCP tools `list_apps` / `launch_app` / `open_web_app`.

## Context
Owner decisions (2026-10-06): Chalito is a remote desktop for a person's AIs. Apps without a
protocol (desktop AI apps, AI websites) can be seen and used remotely, and an AI agent may drive
them, always with a per-session passkey approval, a visible indicator, a kill switch and a
metadata-only audit. Frames, keys and prompts must be end to end; the cloud only relays.

## Decision

### 1. Capture and streaming stack: the agent, in Node (werift + node-screenshots + robotjs)
Options weighed:

| | Tauri/Rust webrtc-rs + xcap | Desktop webview `getDisplayMedia` | **Agent: werift + node-screenshots + robotjs** |
|---|---|---|---|
| macOS | works; needs Screen Recording | WKWebView: `getDisplayMedia` only recently and not in every embedding; system picker each time | works; same Screen Recording + Accessibility grants as #31 |
| Windows | works | WebView2 (Chromium): full support, but a picker every session | works |
| Linux X11 | works | WebKitGTK: WebRTC off in most distro builds | works |
| Linux Wayland | needs the portal (PipeWire), not in xcap's simple path | portal picker | refused, same as #31 (clear message) |
| Unattended (person away) | yes | **no**: the picker needs a click on the device | yes |
| Where policy, grants, kill switch, audit live | would need a second copy in Rust | webview JS (weakest place) | **already in the agent (#31)** |
| Video encoder | must ship libvpx/openh264 per platform | browser's | none needed (JPEG over a data channel) |

`getDisplayMedia` fails the core use case (the person is usually away from the computer and the
picker needs a local click) and WebKitGTK has no WebRTC. A Rust stack would duplicate #31's
policy/grant/kill/audit logic in a second process and ship native video encoders. The agent
already owns all of that, already loads the capture (`node-screenshots`, napi-rs over `xcap`) and
input (`@jitsi/robotjs`) layers, and ships as one `bun build --compile` binary, so the WebRTC
stack must be pure TypeScript: **werift** (ICE, DTLS, SCTP data channels; no prebuilds).

Frames are JPEG (`jpeg-js`, pure JS), downscaled to fit 1600×1000, sent in ≤ 60 KiB chunks on an
**unordered, no-retransmit data channel** (a late frame is dropped, the next replaces it; a slow
link drops frames instead of queueing). Input is JSON on a second, reliable channel that exists
only in control mode. Trade-off: more bandwidth than VP8/H.264 at the same quality (≈100–200 KB
per frame at 5 fps). Upgrade path, later: an RTP video track (werift supports it) fed by an OS
hardware encoder; the signaling, approvals and channels stay as they are.

### 2. Signaling over the existing relay, sealed and signed
- The browser sends `screen.open {mode, display?, appId?}` as a signed command. The agent checks
  the local enable, the origin (`client:` only), the desktop app's heartbeat, a capturable screen,
  rate limits (6 opens / 10 min, 2 sessions), then asks a `remote_view` / `remote_control`
  approval (HIGH, passkey step-up) and returns the `sid` at once.
- After an allow, the agent creates the peer and **both data channels itself**, gathers ICE
  (non-trickle, ≤ 5 s) and sends the offer as a `screen.signal` event whose `ct` is sealed to
  **the requesting client and the agent only** (aad `screen:<sid>`) and opens to a
  `chalito.screen-signal.v1` envelope signed by the agent. The browser verifies it against the
  agent's `pubSign` from its local trust before using the SDP (its DTLS fingerprint pins the
  device), so the relay can neither read nor forge it.
- The browser's answer (and optional ICE) comes back as a signed `screen.signal` command with the
  SDP sealed to the device. Only the opener's origin is accepted; a browser offer is refused; any
  data channel the browser opens is closed and audited.

### 3. Gating (same as #31)
- Local-only enable: `chalito screen enable [view|control]` or the desktop panel (OS auth, two
  confirmations, typed phrase), stored in the signed policy (`policy.screen`). `control` implies
  `view`. `policy.tighten` and `chalito policy edit` can only lower it.
- Indicator: the desktop poller's `computerStatus` (with `indicatorShown`) now lists screen
  sessions too, so the same always-on-top indicator shows and the same Ctrl+Alt+Esc / tray
  "Detener control" / indicator button / panel kill switch ends them (`computerKill` kills both).
  Every frame and every input needs a fresh heartbeat saying the indicator is shown; after 3 s
  without it the session ends.
- Input: validated (`ScreenInput`), normalised coordinates mapped per display, clicks/keys/text
  rate limited (`maxInputsPerMinute`, default 600), pointer moves coalesced (≤ 1 / 15 ms); text is
  typed in 16-char chunks so a kill stops it mid-text; held buttons are released on end.
- Session limits: `maxSessionMinutes` (default 60), 60 s to connect after the approval.
- Audit: `screen.requested|granted|denied|live|ended|killed|rate_limited|channel_refused|app_focus`
  with counts and reasons only.

### 4. Managed AI windows
- `web-app` recipes: the system's Chrome, Edge or Chromium with `--user-data-dir=~/.chalito/browsers/<appId>`
  (one profile per app, 0700), `--app=<url>`. The person signs in on the real site there; cookies
  never leave that profile. Chalito opens only URLs on the recipe's `allowedOrigins` (https; http
  only for localhost). The browser itself is not locked to those origins (Chrome has no
  per-profile URL allowlist without machine-wide enterprise policy, and `--load-extension` is gone
  from branded Chrome): links the person follows are theirs.
- `desktop-app` recipes: `open -a/-b` (macOS), `explorer.exe shell:AppsFolder\<AUMID>` or the exe
  (Windows), the recipe's launch command (Linux). Absolute paths, argument lists, no shell.
- Both register behind `registerDriver("web-app" | "desktop-app", factory)`
  (`apps/agent/src/drivers/registry.ts`), which the engine's `app.launch` executor uses.

### 5. AI driving apps (`app_control`)
The computer MCP gains `list_apps`, `launch_app {appId}`, `open_web_app {appId, url?}`, scoped to
the person's recipes. Each app asks its own `app_control` approval (HIGH, passkey) in the session;
approving it also grants that session computer control (one prompt to drive one app). Every #31
gate still applies (local enable, signed origin, desktop heartbeat, indicator, rate limit, kill
switch, audit with `appId` and the URL's origin only).

## Owner actions (not done here)
- **TURN**: peer-to-peer with public STUN (`stun:stun.l.google.com:19302`) works on most home and
  office networks; symmetric NATs / strict firewalls need a relay. Run coturn (or a managed TURN)
  with TLS on 443 and short-lived REST credentials (`use-auth-secret`), then hand agents and
  browsers the ICE servers (agents read `CHALITO_ICE_SERVERS`, a JSON array; the hub needs the
  same list, ideally minted per session by the api). A TURN server only relays DTLS-encrypted
  packets: it never sees frames or keys. Budget: relayed sessions cost bandwidth
  (≈ 0.5–1 MB/s per live session at 5 fps).
- Pick a non-Google STUN if preferred (any RFC 5389 server).

## Not verified
- Real WebRTC interop between werift's offer and Chrome/Safari/Firefox answers (only a werift↔werift
  loopback was run); data channel message size limits per browser (chunks kept at 60 KiB).
- Capture/input on real macOS/Windows/X11 (the build host runs Wayland; nothing touched the live
  screen). werift under `bun build --compile`.
- Chrome `--app` with a fresh `--user-data-dir` on each OS; Store-app AUMIDs for the curated recipes.
