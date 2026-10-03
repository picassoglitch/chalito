# ADR 0015: Region, web hosting and custom domain

- Status: Proposed (M0); owner decision #22 (domain) and #25 (front door)

## Verified context (2026-10-03)
- **Region:**
  - Cloud Tasks and Vertex generative AI are **not available in `northamerica-south1`**.
  - Cloud Run domain mapping is **Preview** and exists in `us-central1` but **not** in `us-south1` or `northamerica-south1`.
  - Firebase App Hosting regions include `us-central1` but not `us-south1`.
  - Firebase Hosting → Cloud Run rewrites work in `us-central1`/`us-south1` with a **60 s request cap**.
- **Cheap model:** `gemini-3.1-flash-lite` is offered only on the **global** endpoint and the `us`/`eu` multi-regions. Non-global costs +10% for Gemini 3+ since 2026-07-01. `gemini-2.5-flash-lite` retires 2026-10-20.

## Decision
- **Single region `us-central1`** for Cloud Run, Cloud Tasks, Pub/Sub, GCS and BigQuery (`US` multi-region dataset is acceptable). **Firestore location: `us-central1`** (same region, cheapest), chosen once by the owner during bootstrap (OPS). `nam5` (US multi-region) is the alternative if higher availability is worth the higher Firestore prices.
- **Vertex calls use the `global` endpoint** (`models.yaml: vertex.location: global`).
- **Front door for beta: Firebase Hosting** on the custom domain.
  - It serves `web` (Next.js on Cloud Run via a rewrite) and `/api/**` → `api`, with a free managed TLS certificate and CDN.
  - **Webhooks and `mcp-gateway`** use their own subdomains (`api.`, `mcp.`) via **Cloud Run domain mapping** (Preview, us-central1). That avoids the 60 s cap for MCP streams and keeps webhook URLs stable.
  - Moving to a **global external Application Load Balancer** (serverless NEGs, Cloud Armor) is the prod path when traffic justifies the ~$18/mo forwarding-rule cost. Terraform keeps both behind a variable.
- **Domain:** to be registered by the owner (OPS). Placeholder `chalito.app` in docs only; nothing hardcoded in code. The variable is `domain`.
- Next.js 16 uses `proxy.ts` (formerly `middleware.ts`). next-intl 4.x uses `localePrefix: 'as-needed'`, `defaultLocale: 'es'` and `localeDetection: false`, so ES is always the bare `/` and the locale comes from the URL only.

## Consequences
- Preview domain mapping carries a pre-GA risk. If it breaks, the ALB variable switches all hosts to the load balancer.
- Realtime voice and WebRTC go directly to OpenAI, so the front door never carries long-lived media.
