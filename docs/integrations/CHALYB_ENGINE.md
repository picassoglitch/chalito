# Chalito as a Chalyb engine: Chalyb-side changes

These changes are needed in the **Chalyb repo** (`picassoglitch/chalyb`). They go on their own branch and PR there, **only with the owner's go**. Nothing in this document has been applied. See ADR 0016 for the design. The contract was read from Chalyb at `4ed57c9`.

## 1. Engine definition (hub code)
Append to `src/lib/engines/integrations/definitions.ts`:

```ts
createEngineIntegration({
  slug: 'chalito',
  displayName: 'Chalito',
  postSsoPath: '/',
}),
```

## 2. Migration (ships `coming_soon`)
Run `node scripts/new-engine.mjs chalito "Chalito" --icon 🐻 --tier PRO`, which writes `supabase/migrations/00NN_register_chalito_engine.sql`, then edit the description:

> Tu compañero animado: dirige a tu equipo de IA, te avisa por voz, push, WhatsApp o llamada, y conoce a los compañeros de tu familia y equipo.

## 3. Infrastructure entry
Add to `infra/terraform/terraform.tfvars` in Chalyb:

```hcl
chalito = {
  display_name = "Chalito"
}
```

The engine module creates the `chalito` service account, three secrets, the public scale-to-zero Cloud Run service (Chalito's `api`) and the `chalito.chalyb.com` domain mapping.

**Two Chalito-specific adjustments to discuss:**
- **Domain.** `chalito.chalyb.com` must point at **Vercel** (the web/PWA, which is the engine's `external_url`). Chalito's `api` gets `api.chalito.chalyb.com`. The module's default mapping of `<slug>.chalyb.com` to Cloud Run needs an override for this engine, or the mapping is created as `api.chalito.chalyb.com`.
- **Engine `admin_api_base`** = `https://api.chalito.chalyb.com`, **`external_url`** = `https://chalito.chalyb.com`.

After apply, pass the output `api` service-account email to Chalito's Terraform as `api_service_account`. That grants it the Chalito-database Firestore role, token signing and its secrets.

## 4. Secrets
- `chalito-sso-secret` = Vercel `CHALITO_SSO_SECRET`. The hub signs launch tokens with it; Chalito's `api` verifies them.
- `chalito-admin-token` = Vercel `CHALITO_ADMIN_TOKEN`. The hub uses it for `/tenants*`, and Chalito uses the same bearer for `/api/engines/chalito/usage*`.
- Chalito's `orchestrator` and `notifier` service accounts need **read access to `chalito-admin-token`** (they report usage). Grant this in Chalyb's Terraform or by a one-line IAM binding.

## 5. Meter kinds (consumption contract)
Chalito will send these kinds to `POST /api/engines/chalito/usage`, each with `cost_usd_micros`:

| kind | provider | billed as |
|---|---|---|
| `llm.tokens` | anthropic, openai, xai, google | standard (cost × (1 + margin)) |
| `voice.seconds` | openai | standard |
| `call.seconds` | twilio | standard |
| `whatsapp.messages` | meta | standard |
| `sms.segments` | twilio | standard |
| `compute.seconds` | gcp | standard |
| **`store.purchase`** | chalito | **already a price**, like `boost.fee`: `ceil(cost_usd_micros / 4)` |

Please confirm the hub accepts the new kinds (the `/usage` route and any `kind` enum), and add `store.purchase` to the "already a price" branch of the billing formula (D-030).

## 6. Solo Chalito plans (decision #31)
Solo tiers (`plans.yaml`: Lite $10, Starter $20, Standard $30, Plus $100, Heavy $300; bundles ~$8 and ~$40) need **owner-set MXN amounts** in the hub's pricing config before the hub can sell them through Mercado Pago. Until then Chalito shows "Disponible pronto".

## 7. Supabase on the hub project nexo-ai (ADR 0017, supersedes the Firebase plan)
Chalito's tables live in schemas `chalito` and `chalito_private` on the hub's Supabase project **nexo-ai**. Firebase isn't used (D-052, D-053). These touch the shared project and need the hub owner's sign-off (`docs/reviews/supabase-review.md`, S1, S2, S4, S5, S7 and S10):
- **Device users in `auth.users`:** each paired device is a Supabase Auth user with `app_metadata.chalito = {owner, device_id, role}`. The hub's `auth.users` triggers and policies must ignore these users (a guard on `app_metadata ? 'chalito'`), and hub policies keyed on `auth.uid()` must not match them.
- **`service_role`:** revoked from the Chalito schemas. Chalito's servers use the `chalito_server` role.
- **Realtime:** Chalito's `realtime.messages` policies are scoped to `chalito:*` topics. Confirm that the hub's own policies don't grant those topics, and that the quota is shared.
- **Exposed schemas:** add `chalito` to the Data API's exposed schemas (not `chalito_private`), and keep it out of pg_graphql introspection.
- **Realtime "Allow public access" off:** Chalito's topics are private. Check that no hub feature relies on public channels before turning it off.
- **pg_cron and pgcrypto:** Chalito's migrations create the extensions if missing and schedule `chalito-*` jobs (TTL purge, room purge, rate-limit buckets).
- **Applying the migrations** (`supabase/migrations/2026100400*`) to nexo-ai is an owner action, after a dry run on a branch.

## 7b. Consumption routes must be on hub main
`/usage/admit` and `/usage/settle` (and `reserved` in the balance) come from hub commit `a5733df` ("tier caps, job admission, boost lane"), which is on unmerged branches (`claude/consumption-caps`, `claude/rebuild-p6-*`), not on chalyb `main` as of 2026-10-04. Chalito's billing calls them, and treats a 404 from admit as "hub unavailable" → free_min. They must ship on the hub before Chalito goes live with managed AI.

## 8. Engine launch: forward `next` (nice to have)
`/auth/launch/<slug>` and `getEngineLaunchUrl` ignore a `next` path. Notification links (`/n/<nid>`) need to land on the right screen after sign-in. Chalito works around this with a first-party cookie it sets before redirecting to the hub. A native `next` (validated as a same-engine relative path and carried in the SSO token's `next`) would remove that.

## 9. Going live (owner)
1. Chalito: create the state bucket, then `terraform apply` in `infra/terraform/envs/dev` (Chalito-only resources).
2. Chalyb PR: items 1–5 and 7 (8 optional), `terraform apply` in Chalyb, secret values, Vercel env.
3. Apply Chalito's migrations to nexo-ai (item 7), then deploy Chalito `api` and `notifier` (Cloud Run) and `web` (Vercel at chalito.chalyb.com).
4. Flip the engine row to `active` and run `reconcileEngineLinks('chalito')` (dry run first).
