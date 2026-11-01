# Board link: desktop ↔ ESP32-C6 LCD over USB

Owner request (2026-10-30, Claude Code session, summary): the LCD board shows the owner's
own custom Chalito, not the roster default; the RGB LED shows moods and alerts; one click
plays a different trick each time; a double click opens pending approvals from the agents;
on the approvals screen a hold approves and a click denies. A mobile app will later drive
the board too (see the mobile ADR).

This extends the accessory rules in `docs/CENTRAL_CONNECTIONS.md`. They still apply: the
board never holds account credentials; decisions go through `ClientActions.decide` on the
desktop; passkey-gated, unverified or too-long approvals stay on the phone.

## Transport

- USB Serial/JTAG of the ESP32-C6 (CDC-ACM, VID `303a`, PID `1001`, `/dev/ttyACM*`,
  `COMx`, `/dev/cu.usbmodem*`). Baud rate is ignored by the device.
- Newline-delimited JSON, UTF-8, one message per line, at most 4096 bytes per line.
  Every message has `"v": 1` and a `type`. Unknown types are ignored, never fatal.
- Lines that do not parse as JSON (ESP-IDF log output) are ignored by the host.
- Open the port with DTR on and RTS off. RTS on while DTR is off resets the ESP32-C6
  (that is how esptool reboots it), so the order matters.
- The board answers every host `hello`, including two in a row (one per desktop window).
- Only the desktop process that owns the device session opens the port. The board is a
  local accessory, never an HTTP or network approval endpoint.

## Board → host

| type | fields | when |
| --- | --- | --- |
| `hello` | `fw` (semver), `board` (`"waveshare-esp32-c6-lcd-1.47"`), `w` 172, `h` 320, `pair` (paired key id or `null`), `card` (stored card key or `null`) | on boot and in reply to host `hello` |
| `decide` | `ApprovalConsoleCommand` plus `mac` (see Pairing). The host checks `mac`, strips it, then parses strictly | hold (approve) or click (deny) on the approvals screen |
| `next` / `previous` | exactly `ApprovalConsoleCommand`, no `mac` | double click on the approvals screen (`previous` is not sent yet) |
| `pair-ok` | `pair` (new key id) | the owner held BOOT on the pairing prompt |
| `pair-cancel` | — | a click or 60 s without input on a pairing or forget prompt (the old pairing stays) |
| `pair-cleared` | — | the owner confirmed forgetting the pairing (host `pair-reset` or the 10 s hold on the board) |
| `pet` | `trick` (id string) | a click played a trick, so the desktop pet can mirror it. Ids, in cycle order: `jump`, `giggle`, `spin`, `cheer`, `hop`, `squash`, `nod`. The desktop plays a random trick for an id it does not know |
| `card-progress` | `key`, `frame`, `offset` | after each accepted `card-chunk` (flow control). `frame` is the chunk's frame name; `offset` is the next expected byte offset in that frame (chunk offset + its length) |
| `card-ack` | `key`, `ok`, `reason?` (`"hash"`, `"size"`, `"flash"`, `"sequence"`) | after `card-end` or on a rejected upload |

## Host → board

| type | fields | notes |
| --- | --- | --- |
| `hello` | `now` (optional, epoch ms), `tz` (optional, local offset in minutes east of UTC, −720–840: `-new Date().getTimezoneOffset()`) | ask the board to identify itself. The board has no clock; with `now` it quietly turns the controls off once `expiresAt` passes. It never shows a countdown. With `now` and `tz` it knows the local hour for its idle activities; the desktop sends a fresh `hello` when its offset changes (DST, travel) |
| `approval-console` | exactly `ApprovalConsoleFrame` | sent every second; it is the heartbeat. After 3 s without one the board clears and disables approval controls and shows "sin conexión" |
| `mood` | `mood` (`neutral`, `happy`, `surprised`, `tired`, `sad`), `ms` (1–60000) | plays a face for `ms`, then returns to its own behaviour |
| `activity` | `hint` (`working`, `idle`) | what the agents are doing: `working` while any agent session is starting or running (and none waits on the person), `idle` otherwise. The board prefers its working activity while it is `working`. Sent on change and again after each hello; the board forgets it when the link drops |
| `sessions` | `items` (array, at most 24) of {`agent` (1–16, an id such as `claude-code`, `codex`, `cursor`), `computer` (0–16), `title` (0–24), `state` (`working`, `waiting`, `idle`), `since` (epoch ms the session entered that state)}; `more` (optional, 0–9999) | the active sessions for the double-click screen when nothing is pending. Lengths in UTF-16 units; the host cuts with "…" and drops items (counted in `more`) to keep the line under 4096 bytes. Names and short titles only: never paths, ids or content. Sent on change, after each hello and every 15 s; the board drops one from before a link loss. A malformed message is ignored whole |
| `alert` | `level` (`info`, `attention`, `danger`, `none`), `ms` (optional, 1–60000) | LED pattern, a slow pulse; `danger` is red. Without `ms` it stays while the reason holds: until the next `alert` (`none` clears it) or link loss. It never speeds up |
| `card-begin` | `key` (sha256 hex of all frame bytes in `frames` order), `x`, `y`, `w`, `h`, `frames` | starts a custom card upload |
| `card-chunk` | `frame` (name from `frames`, not an index), `offset` (bytes into that frame), `data` (base64, ≤ 2048 raw bytes) | in order, frames in `frames` order, offsets contiguous from 0; the host sends the next chunk only after `card-progress` |
| `card-end` | `key` | board verifies the hash, then marks the stored card valid |
| `pair-begin` | `secret` (base64 of 32 random bytes), `code` (6 digits) | shows the pairing prompt with the code; see Pairing |
| `pair-reset` | — | shows "¿Olvidar esta computadora?"; a hold clears the pairing |
| `card-reset` | — | forget the stored card, use the built-in roster chalito. No reply; the next `hello` shows `card: null` |

## Pairing

Any device with VID `303a`/PID `1001` matches (every ESP32 dev board, and the ids are easy
to fake), so the desktop pairs with one board and only trusts decisions it can verify.

- An **unpaired** board (`hello.pair` is `null`) takes only `hello`, `pair-begin` and
  `pair-reset`, and ignores every other message. The host sends it nothing else (no
  `approval-console`, card, `mood`, `activity`, `sessions` or `alert`). The pet works as usual offline: built-in
  card, its own moods and tricks.
- `pair-begin`: the board shows "¿Emparejar con esta computadora?", the code in large
  digits and "Mantén BOOT para confirmar". A 1.5 s hold that **starts after the prompt
  appears** stores the secret in NVS and replies `pair-ok` with the key id. A click, or
  60 s without input, replies `pair-cancel` and keeps the old pairing. A second
  `pair-begin` replaces the prompt.
- Key id: the first 16 hex chars of sha256(secret). The secret never leaves the board
  again and is never logged.
- `pair-reset`: the board shows "¿Olvidar esta computadora?". A hold clears NVS and
  replies `pair-cleared`; a click replies `pair-cancel`.
- On the board, holding BOOT for 10 s on the pet screen shows the same forget prompt
  (release, then hold 1.5 s to confirm), so the owner can unpair without a computer.
- `decide.mac` is the lowercase hex HMAC-SHA256(secret, `v1|decide|<aid>|<ticket>|<allow>`),
  where `<allow>` is `true` or `false`; 64 chars. `next`/`previous` carry no mac.
- A paired board accepts everything in this document.
- The secret sits in plain NVS, so anyone with physical access to the board can read it.
  Flash encryption is out of scope for the beta.

## Approval safety on the board

- A decision always uses the `aid` and `ticket` on screen. A press counts only if it
  began while that exact approval (same `aid` and `ticket`) was already shown. A hold
  approves only after 1.5 s from the press and 1.5 s from when the approval first appeared.
- A change of `aid` or `ticket`, expiry (when the host gave `now`), or 3 s without a frame
  cancels a hold and disables the controls. Expiry is never displayed. A click waits out the double-click window
  before denying, so a double click (`next`) never denies.

## Test firmware

Built with `CONFIG_CHALITO_TEST_BUTTON` (`sdkconfig.test`), the board also accepts
`{"v":1,"type":"test-button","down":bool}`, which presses BOOT for
`firmware/esp32-c6-lcd/tools/board_check.py`. Owner firmware never accepts it.

## Card frames

The host converts the card; the board only stores and draws. The layout must match
`firmware/esp32-c6-lcd/tools/make_sprites.py` exactly:

- `frames` is `["background", "neutral", "blink", "happy", "surprised", "tired"]`.
- `background` is 172×320 RGB565: cream `#FFF6E8` plus the card's floor shadow
  (`card.json` `shadow`), mapped through the same crop and scale as the sprites.
- Each other frame is `w`×`h` RGB565 drawn at (`x`, `y`). Crop is the union bounding box of
  the used layers; scale is `min(164 / cropW, 296 / cropH)`, Lanczos; `x = (172 - w) / 2`,
  `y = 320 - 12 - h`.
- Pixels are big-endian RGB565. Alpha < 20 becomes the transparent key `0x0821`; other
  pixels are blended onto the cream; a blended pixel equal to the key becomes `0x0822`.
- `blink` is neutral plus `rig-lids.webp` when the card has a rig with lids, otherwise
  neutral. A missing emotion falls back to neutral.
- Total payload is at most 1 MiB. The board stores it in its `card` flash partition and
  only marks it valid after the hash matches, so a cut upload keeps the previous card.
- `card-ack` reasons: `sequence` (chunk out of order, no `card-begin`, wrong `frames`
  list or key at `card-end`), `size` (geometry off the 172×320 screen, payload over
  1 MiB, a chunk over 2048 bytes or past its frame, or `card-end` before every byte
  arrived), `hash` (sha256 of the received bytes differs from `key`), `flash` (write or
  read-back failed). Any rejection ends the upload; start again with `card-begin`.

## Buttons and screens (firmware)

The board has one usable button, BOOT (GPIO 9). RESET reboots.

Pet screen:
- click: the next trick in a fixed cycle (a different animation each click); sends `pet`.
- double click: open the approvals screen.
- hold 10 s: offer to forget the pairing (see Pairing).
- a click while asleep wakes it instead of playing a trick.
- hold 1.5 s and release (under 10 s): play the next idle activity right away, in order
  (working, coffee, sleeping, music, reading). Owner demo; any press stops it.

Idle activities (owner, 2026-10-30, Flipper style): every 2–5 min on the pet screen, Chalito
does one thing on its own for 20–40 s, with the card's own faces plus props the firmware
draws:
- `working`: a laptop on a little desk in front, a tiny typing nod. Strongly preferred while
  the host's `activity` hint is `working`, at any hour.
- `coffee`: a mug in its hand with rising steam, a happy sip every 7 s. Mostly mornings
  (6–11 h), some afternoons, never late at night.
- `sleeping`: tired face, floating Z's, the screen gently dims (over ~2 s, and back). Mostly
  at night (23–6 h).
- `music`: floating notes, a gentle sway, happy face. Evenings.
- `reading`: an open book in front, a page turns every 6 s. Evenings.

Without `now` and `tz` the board picks without time weighting. Activities never start on the
approvals or pairing screens, over a trick or a host mood, or while approvals are pending;
leaving the pet screen ends one, and the next waits a whole new gap. Any press ends it and
keeps its usual meaning (a click during `sleeping` wakes the pet, like a click while asleep).
Nothing flashes or speeds up. The pet stands on the card's feet line: breathing stretches it
up from the feet; only jumping tricks leave the ground.

Double-click screen (owner, 2026-10-30: "make the menu better looking … if no pending
questions are there, then let's just display the active sessions and relevant information").
Every screen is drawn by `main/ui.c`; `tools/render_ui.sh` renders the same code to PNGs.

Approvals (from the latest `approval-console` frame):
- header "Aprobaciones" with "N de M pendientes"; a card with a risk chip and accent bar in
  the risk colour (green, amber, orange, red), the agent, "en <computer>" and the summary
  (up to 5 lines, cut with "…"). The footer shows the approve bar and gesture hints
  ("Mantén aprobar", "Toca negar", "2 toques siguiente") only while the controls are live;
  otherwise it says why (on the phone, unverified, no longer pending, sent). No countdown or
  timer (owner, 2026-10-30: "we can't pressure them"). An approval that expires or is answered
  elsewhere drops on the next frame with a calm "ya no está pendiente".
- hold 1.5 s with a filling bar: approve, only when `canApprove`; otherwise the screen says
  to approve on the phone and a hold does nothing.
- click: deny, when `canDeny`.
- double click: next approval.
- 10 s without input: back to the pet screen. The approval stays pending; a double click
  reopens it.
- states `offline`, `revoked`, `busy`, `phone_required`, `unverified`, no link and unpaired
  each have an icon, a title and a short line; controls are off in every state except
  `pending`.

Sessions (state `empty`, from the latest `sessions` message):
- header "Sesiones" with "N activas · W esperando"; one card per session: title, agent
  (Claude Code, Codex, Cursor…) · computer, a coloured dot and state (trabajando, esperando,
  inactiva) and how long it has been in it ("12 min", counting up; only when the host sent
  `now`). `more` shows as "+N más" at the end. No sessions, or none sent: "Todo tranquilo".
- hold, when the list is longer than the screen: scrolls down smoothly (~65 px/s), rests at
  the bottom, glides back up, and so on; releasing stops. A slim scrollbar and "Mantén
  desplazar" show then. A hold here never approves: an approval that arrives meanwhile
  replaces the list and needs a new press (the press guard above).
- click: nothing. Double click: back to the pet. 10 s without input (not counting a scroll
  hold): back to the pet.

LED (WS2812 on GPIO 8, kept dim, every pulse a calm 3 s): mood colour on the pet screen;
amber pulse while approvals are pending, stopping when none are left; red pulse while a
`HIGH`/`CRITICAL` one is pending or for `danger` alerts; amber for `attention`, blue for
`info`; steady blue on a pairing prompt; off when the desktop link is
lost. A board that never heard from a desktop keeps its mood colour.
