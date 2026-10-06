# Store (M8): API contract for the web UI

The store page is `apps/web/src/app/[locale]/tienda/page.tsx` (`/tienda`, `/en/tienda`). It is owned by the web app's owner and uses these api routes.

**Auth:** a `user` or `client` bearer. Agents get 403.

**Prices:** prices are billable hub tokens (`priceTokens`), never currency strings. Show them as tokens, like the rest of the credits UI.

| Route | Body | Answer |
|---|---|---|
| `GET /v1/store/catalog` | none | `{ items: [{ id, name: {es, en}, slot, free, priceTokens?, art, card: {width, pivot}, owned }] }`; a skin has `slot: "skin"` and `skin: <effect>` instead of `art` and `card` |
| `POST /v1/store/purchase` | `{ cosmeticId, purchaseId }` | `200 { status: "owned", cosmeticId, charged, replay? }` |
| `POST /v1/store/equip` | `{ companionId, slot, cosmeticId \| null }` | `200 { ok: true, slot, cosmeticId }` |

**Purchase:**
- `purchaseId` is 16–64 characters from `[A-Za-z0-9_-]`. Make one per buy tap and reuse it on retries: a retry never charges twice.
- `402 { error: "no_tokens", chips: [{ label, href: "/creditos" }] }` means not enough balance. Show the chip inline, never as a modal.
- `503 hub_unavailable` means try later.
- Free items return `charged: 0` and never touch the hub.

**Equip:**
- `null` takes the slot off.
- `403 not_owned`, `400 wrong_slot`, `404 unknown_companion`.
- Clients can't write `companions.equipped` directly (RLS).

**Art and placement:** use `@chalito/roster`:
- `cosmetics/<id>.webp` for items;
- `assets/<roster id>/card.json` plus the layers for companions;
- `placeOnCard(card.anchors[slot], item.card, itemAspect, cardAspect)` for where an item goes (negative `z` is behind the body);
- `VRM_BONE` maps slots to M7's VRM renderer.

**Skins:** `slot: "skin"` items are a material effect over the whole companion (`gold`, `galaxy`, `neon`, `crystal`, `holo`, `shadow`, `pixel`), drawn by the card renderer's shader (`@chalito/avatar-three` `card.setSkin(effect)`, animated by `card.tick(seconds)`), so one skin fits every roster character with no new art. One slot, so one skin at a time; equipping another replaces it. The equipped skin's id travels like any equipped id (`companions.equipped.skin`, `companion_directory.equipped`), and room peers and the desktop pet map it to its effect through the catalog. The web store previews skins with `@chalito/scene` `CardPreview` (the same renderer) and a CSS swatch per tile. Clients skip effects they don't know (an older build against a newer catalog).

**Cosmetics never change what a companion can do.** A property test drives these routes and asserts entitlements, the model profile and safety are unchanged (`apps/api/test/pay-to-win.test.ts`).

## Swapping in the roster (D-057), for the web app's owner

- **Companion list:** replace `COMPANIONS` in `packages/ui/src/companions.ts` (`chalito`, `luna`, `tito`) with `ROSTER_IDS` from `@chalito/roster` (`chalito`, `bruno`, `luna`, `tito`, `canela`, `nube`).
- **Names:** the names in `messages/{es,en}.json` can come from `ROSTER[i].name`.
- **Expressions:** map emotions with `EMOTION_DRAWING`.
- **PWA icons:** `apps/web/public/icons/icon-192.png`, `icon-512.png` and `icon-maskable-512.png` get replaced by `@chalito/roster/icons/*`. Those also include `apple-touch-icon.png` (180) and `favicon-32.png`. Point `src/app/manifest.ts` at them.
