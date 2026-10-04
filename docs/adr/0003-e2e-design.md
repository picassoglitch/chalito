# ADR 0003: End-to-end encryption design

- Status: Accepted (M0); implemented in `packages/crypto` (M1)

## Goals
1. **A cloud compromise must not become code execution on a device.**
2. It must not add an approver.
3. It must not enable Developer mode.
4. In Private mode the cloud stores only ciphertext for content.

## Keys
| Holder | Keys | Storage |
|---|---|---|
| Device agent | Ed25519 (sign) + X25519 (box) | OS keychain (`@napi-rs/keyring`) |
| Phone / browser client | Ed25519 + X25519 | Non-extractable WebCrypto where possible (Ed25519/X25519 in WebCrypto), else libsodium keys wrapped by a non-extractable AES-GCM key in IndexedDB. Step-up via WebAuthn. |
| Room | 32-byte symmetric key per **epoch** | Wrapped (sealed box) to each member client device |

Library: libsodium (`libsodium-wrappers`, wasm/pure JS in every runtime, so there are no per-platform native crypto builds).

## Wire formats (fixed in `packages/protocol/src/crypto.ts`)
- **`SealedEnvelope`** (multi-recipient). XChaCha20-Poly1305 encrypts the content with a random content key. The content key is wrapped to each recipient device with `crypto_box_seal`. Used for session events, approvals, prompts, Mesa turns and cards. The AEAD's associated data binds each ciphertext to its document (e.g. `approval:<aid>`), so a sealed blob can't be moved to another document.
- **`RoomSealed`**. XChaCha20-Poly1305 with the room key of `epoch`, with associated data `chalito.room.v1:<roomId>:<epoch>`.
- **Signatures.** Ed25519 over `utf8(ctx) ‖ 0x00 ‖ JCS(body)` (RFC 8785 canonical JSON) with a closed set of domain-separation contexts (`chalito.decision.v1`, `chalito.command.v1`, …). A signature for one purpose can't be replayed for another.

## Trust anchors live on the device, not in the cloud
- Each agent keeps a **local trusted-client list** (ADR 0006). The cloud's `devices` collection is a directory, not an authority. A key the server adds but the agent never confirmed is ignored (approver-injection test, M2).
- Decisions, client commands, endorsements and Developer-mode-off are **signed by a client key** and verified **on the agent**. The cloud only relays them.
- Relayed (unsigned) commands from `mcp:*` / `call:*` origins can only prompt or answer (schema-enforced, `RelayedCommand`). They never qualify for Developer-mode auto-approve. Their resulting tool calls still need signed approvals at MED+.

## Recipient sets and rotation
- Senders seal to the **agent's view** of trusted clients: the agent publishes its trusted-client set, signed with its own key. Clients seal to `{agent} ∪ trusted clients`.
- **Revocation** removes the key from every recipient set immediately. Rooms rotate to a new epoch. A revoked key can't decrypt new content (M2 test). Old content it already had is out of scope (documented).

## Plaintext exceptions (explicit opt-ins, each disclosed)
1. MCP card sharing (`cardMcpPlain`), per session/device, default off. Turning it off deletes the plaintext copy.
2. Call-briefing `callLines` (≤1 sentence, TTL, deleted at call end). Default on for new users with disclosure (owner decision #10).
3. Metadata needed for routing: counts, enums, urgency, labels the user typed (device/session labels, Mesa title).

`cloud_assist` privacy mode, which lets cloud brains see content, also requires sealing to a server KMS-backed key. It is a later, explicit opt-in; beta defaults to `private`.

## Server-run brains (companion, Mesa) vs E2E
Managed brains run in `orchestrator` and must see Mesa/companion text to call LLM APIs. So:
- Mesa and companion conversations run **client-side** (desktop/PWA), calling `api` as a thin metered proxy that forwards to the provider and doesn't persist plaintext.
- Or they run in `cloud_assist` mode.
- Beta default: the client composes briefs and `api`/`orchestrator` proxy them without storing content. Stored turns are sealed. Documented as a residual risk in the THREAT_MODEL ("transient plaintext in proxy memory"). See D-007.
