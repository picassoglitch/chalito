# ADR 0001: HTTP framework for Cloud Run services: Hono

- Status: Accepted (M0)

## Options (versions checked 2026-10-03)
- **Hono** 4.13 + `@hono/node-server` 2.1 (Node ≥20) + `@hono/zod-validator` (Zod 4).
- **Fastify** 5.12 (v6 in alpha) + `fastify-type-provider-zod` 7.

## Decision: Hono on `@hono/node-server`
- **Web-standard Request/Response.** Handlers are unit-tested with `app.request()`, with no server and no port. The same code runs in emulator integration tests.
- **Raw body for webhooks** via `c.req.arrayBuffer()`. Stripe, Twilio, Meta and Mercado Pago signatures need the unmodified body.
- **Small footprint and fast cold start** for min-instances-0 services.
- **Official MCP TS SDK v2 adapter** (`@modelcontextprotocol/hono`) for `mcp-gateway`.
- zod schemas from `packages/protocol` plug straight into `zValidator`.

## Consequences
- Every service binds `process.env.PORT` and handles SIGTERM itself (graceful drain ≤10 s).
- We give up Fastify's plugin ecosystem and its JSON-schema serializers. Neither matters at beta scale.
- Pub/Sub push endpoints verify the OIDC JWT. Cloud Run IAM does it when `--no-allow-unauthenticated`. Public endpoints are limited to signature-checked webhooks and `web` (documented per endpoint, M2).
