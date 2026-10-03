# ADR 0015: Region, hosting and domain

- Status: Accepted (owner, 2026-10-03: "vercel hosting", "a subdomain of chalyb"; backend in Chalyb's GCP project)

## Verified context (2026-10-03)
- Cloud Tasks and Vertex generative AI are not in `northamerica-south1`.
- Cloud Run domain mapping (Preview) exists in `us-central1`, which is the region Chalyb's engines already use.
- `gemini-3.1-flash-lite` runs only on the `global` endpoint and the `us`/`eu` multi-regions.
- Next.js 16 uses `proxy.ts`; next-intl 4.

## Decision
- **Web/PWA on Vercel** under the picassoglitch account, the same as the Chalyb hub, at **`chalito.chalyb.com`**.
  - That host is also the engine's `external_url`, so `/auth/sso` lives in the Next.js app.
  - Vercel commercial use needs a Pro team. Check that the hub's existing plan covers another project (OPS).
- **Backend on Cloud Run in Chalyb's GCP project, `us-central1`**, via Chalyb's engine module plus Chalito's own Terraform for Chalito-only resources (ADR 0016).
  - `api` is the engine's `admin_api_base`, at `api.chalito.chalyb.com` via Cloud Run domain mapping (the engine module creates it).
  - `mcp-gateway` is at `mcp.chalito.chalyb.com`.
  - Webhooks (Twilio, Meta, OpenAI SIP) go to `api.`.
- **Firestore:** a **named database `chalito`** in `us-central1` inside Chalyb's project. This keeps Chalito data separate from anything else there. The location is fixed at creation (decision #30, accepted).
- **Vertex calls use the `global` endpoint.**
- **Own domain later:** the owner is checking available Chalito domains (decision #22). The `domain` variable keeps hosts configurable, and nothing is hardcoded in code.
- next-intl: `localePrefix: 'as-needed'`, `defaultLocale: 'es'`, `localeDetection: false`. ES is the bare `/` and EN is under `/en`. The user's saved `locale` preference picks the route after sign-in.

## Consequences
- Firebase Hosting and a global ALB are no longer needed for beta.
- The PWA on Vercel talks to Firestore directly (Firebase JS SDK) and to `api.` for commands. CORS is pinned to `chalito.chalyb.com` (+ `/en`).
