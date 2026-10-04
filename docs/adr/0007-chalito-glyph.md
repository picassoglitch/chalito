# ADR 0007: Chalito Glyph (animated image transmission; replaces QR)

- Status: Accepted (M0); implemented in `packages/glyph` (M2)

## Decision
The Chalito Glyph is an **animated ring of coloured segments** around the companion's silhouette. It carries a `GlyphPayload` (see `packages/protocol/src/glyph.ts`) from a screen to a camera. It is a **transport, not a security boundary**.

### Payload
`{ v, purpose, codeId, issuerPubSign, issuerPubBox?, label, issuedAt, expiresAt, nonce } + Ed25519 sig`.
CBOR-encoded, this is ~180–220 bytes.

### Encoding (as built in M2)
- **Payload.** A compact binary form of `GlyphPayload` (~200 bytes; `packages/glyph/src/codec.ts`).
- **Symbols.** **Two concentric rings** of 48 segments each. Each data segment is one of 8 hues, 45° apart (3 bits). Segments 0/12/24/36 of each ring are **finders**: white, white, black, black. This pattern is unique under rotation, so it gives orientation.
- **Frames.** 2 rings × 44 data segments × 3 bits = 264 bits = one 33-byte frame: `[seq][k][29 data bytes][CRC-16/CCITT]`.
- **Error handling.** The **CRC turns any symbol error into an erasure**, and a systematic **fountain code** fills erasures: k data frames plus max(2, ⌈k/2⌉) parity frames per loop, each parity frame the XOR of 2–4 chunks chosen from its sequence number, decoded by peeling. The stream loops, so the camera can start anywhere. A ~200-byte payload is 8 data + 4 parity frames, so one loop is about 1.2 s at 10 fps. There is no separate Reed–Solomon layer (D-033).
- **Tested** (property test): render → noise (±50/255 per channel) → any rotation → 120–320 px → decode, plus recovery with 30% of frames dropped.
- **Checksum.** The final integrity check is the Ed25519 signature over the decoded body. The fingerprint shown to the human is derived from `issuerPubSign`.
- **Accessibility.** The `XXXX-XXXX` short code is always shown next to it. It resolves server-side to the same payload, is rate-limited, and is single-claim.
- **Motion.** `prefers-reduced-motion` slows the animation but keeps the same frames. The ring stays decodable at ≥ 6 fps.

### Security equivalence with QR
| Property | QR | Glyph |
|---|---|---|
| Binds code to issuer keys | via payload | same payload, signed |
| Expiry / single claim | server | server (TTL 5 min pairing, invites per rooms.yaml) |
| Human verification | fingerprint | fingerprint (identical) |
| Shoulder-surf / screenshot replay | possible within TTL | same; mitigated by single claim + fingerprint + 5-min TTL |
| Tamper | signature | signature |

There is no security claim beyond QR. The design goal is brand and delight with **equal** security.

## Tests (M2)
- Property test: encode → render frames → add noise, blur, scale and rotation → decode round-trip.
- A tampered or expired payload is rejected.
- Short-code equivalence.
