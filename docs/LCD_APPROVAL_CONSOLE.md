# LCD approval console

The small LCD shows and answers session approvals across computers, like the phone, within the limits below.

`ApprovalConsole` in `packages/client` provides the shared LCD approval queue. `attachApprovalDisplay` binds it to an explicitly connected local display transport. Frames identify the computer, actual agent recipe, action summary, risk and expiry. Each press includes a one-use ticket for the exact displayed approval. Changed details, an answer from the phone, expiry, disconnect or revocation invalidate that ticket. Decisions go through the same `ClientActions.decide` signing path as the phone and are still verified by the receiving agent.

The display can deny a pending action. Approving an action that requires a passkey, has unverified details, or needs more text than the screen can show remains on the phone. The LCD must not replace a passkey check with a button press. Mesa choices also stay on the phone.

The transport sends a frame every second. Firmware must disable and clear approval controls after losing that heartbeat (recommended timeout: three missed frames). The binding retains at most the newest unsent frame and stops accepting input on disconnect. It is a local accessory interface, not an unauthenticated HTTP approval endpoint.

Physical ESP32 transport and controls are **not wired or flashed** (firmware lives on its own branch). Button versus touch input and the board pinout must be confirmed before that hardware work is done. The controller integration test verifies a real signed decision from the LCD protocol through ClientActions to AgentCore on the selected PC; it does not claim physical hardware validation.

The host passes `onClose(reason)` to learn when the binding stops (`closed`, `disconnected`, `write_failed`); a throwing `onResult` callback no longer drops the display.
