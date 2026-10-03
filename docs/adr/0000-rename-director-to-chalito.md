# ADR 0000: Rename "Director" → "Chalito"

- Status: Accepted (M0, 2026-10-03)
- Supersedes: the "Director" brief and the "Chalyb Partner" label

## Context
Earlier planning used the codename **Director**, and some material called the companion **Chalyb Partner**. The product is now **Chalito**, its own monorepo, separate from both Chalyb and Wayak.

## Decision
| Thing | Old | New |
|---|---|---|
| Product / user-facing name | Director, Chalyb Partner | **Chalito** |
| Device daemon (package + binary) | `director-agent` | **`chalito-agent`** |
| CLI | `director` | **`chalito`** |
| Local state dir | `~/.director/` | **`~/.chalito/`** (`policy.yaml`, `audit/`, trusted-client list) |
| npm scope | `@director/*` | **`@chalito/*`** |
| Companion credit line | n/a | **`<Name> · powered by Chalito Bot`**; un-renamed companion is just **"Chalito"** |
| Signing contexts | n/a | `chalito.<purpose>.v1` (see `packages/protocol/src/crypto.ts`) |
| WhatsApp templates | n/a | `chalito_*` |

- `packages/brand` (M1) exports `PRODUCT_NAME`, `CREDIT_SUFFIX` and `formatCompanionTitle()`. The brand lint fails CI on `Director`, `Chalyb Partner`, or a provider name used as a product/plan/cosmetic name outside the allowlisted integration-description namespace.
- The Spanish credit line keeps the exact English phrase "powered by Chalito Bot" (owner decision #11, default).

## Consequences
- No code or config references the old names. The only exceptions are this ADR and `DEVIATIONS.md`.
- Logged in `DEVIATIONS.md` (D-001).
