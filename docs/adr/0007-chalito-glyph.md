# ADR 0007: Chalito Glyph (animated image transmission; replaces QR)

- Status: Accepted (M0); implemented in `packages/glyph` (M2)

## Decision
The Chalito Glyph is an **animated ring of coloured segments** around the companion's silhouette. It carries a `GlyphPayload` (see `packages/protocol/src/glyph.ts`) from a screen to a camera. It is a **transport, not a security boundary**.

### Payload
`{ v, purpose, codeId, issuerPubSign, issuerPubBox?, label, issuedAt, expiresAt, nonce } + Ed25519 sig`.
CBOR-encoded, this is ~180–220 bytes.

### Encoding (initial design; tuned in M2)
- **Symbols.** The ring has 48 segments. Each segment is one of 8 hues (3 bits), and luminance is kept constant for robustness. Four fixed **finder segments** sit at 0°/90°/180°/270° and give orientation and white balance.
- **Frames.** Each frame carries 132 data bits (44 segments × 3). The payload is split into chunks with a frame index and a CRC-16 per frame.
- **Error correction.** Reed–Solomon over the whole payload (≥30% redundancy) plus a **fountain code** (LT/RaptorQ-style). The decoder can start at any frame and finish once it has enough distinct frames (~1.5 s at 10 fps).
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
