# Chalito

An animated, lifelike AI companion. It runs your AI team (Claude Code, Codex, API brains), talks to you by voice, escalates urgent things to push, WhatsApp and phone calls, and meets other people's companions in shared rooms.

Chalito is a [Chalyb](https://www.chalyb.com) engine: accounts, plans and payments come from the Chalyb hub.

## From zero to running locally

Target: a fresh clone gets to green checks and a running web app in under 30 minutes. Part 1 doesn't need Docker. Part 2 needs Docker for the local Supabase stack.

**How this was verified (2026-10-03):**
- Part 1 was followed literally in a clean clone on Linux (Node 22.23, pnpm 10.15). It took about 80 s from `git clone` to the desktop build, with a warm pnpm store; a first install also downloads the dependencies.
- Part 2 needs Docker, which that machine didn't have. CI's `supabase` job runs the same commands on every PR (`.github/workflows/ci.yml`).
- Parts 3 and 4 were not run.

### Part 1: clone, install, check, run the web app

**Prerequisites:**
- git;
- Node **22.12 or newer** (`node -v`);
- pnpm 10 through Corepack, which ships with Node.

```sh
git clone https://github.com/picassoglitch/chalito.git
cd chalito
corepack enable
pnpm install --frozen-lockfile
```

**Run every check CI runs in its `node` job:**

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

`pnpm test` runs every package's unit tests. Every external service is mocked at the HTTP layer, so nothing real is called and no keys are needed.

**Run the web app (PWA):**

```sh
pnpm --filter @chalito/web dev
```

Open http://localhost:3000 (Spanish) or http://localhost:3000/en. With no environment it runs signed out, and the hub links are hidden. Stop it with Ctrl-C.

**Try the agent CLI** (`chalito`, the computer-side agent):

```sh
pnpm --filter @chalito/agent exec tsx src/cli.ts help
```

**Build the desktop app's UI** (the web part of the Tauri app):

```sh
pnpm --filter @chalito/desktop build
```

### Part 2: the local Supabase stack (needs Docker)

The api, notifier, orchestrator and MCP gateway need Postgres with Chalito's migrations, plus Supabase Auth and Realtime.

**Prerequisites:**
- Docker;
- the [Supabase CLI](https://supabase.com/docs/guides/local-development) 2.119 or newer.

**Start the stack and run the database tests:**

```sh
supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,storage-api
supabase test db
```

`supabase start` applies `supabase/migrations`. The second command runs the pgTAP tests in `supabase/tests/database`.

**Point the contract tests at the stack.** Run these from the repo root, in the shell you'll test from:

```sh
eval "$(supabase status -o env)"
export DATABASE_URL=$DB_URL CHALITO_DB_ROLE=chalito_server
export SUPABASE_AUTH_URL=$API_URL/auth/v1 SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY SUPABASE_ANON_KEY=$ANON_KEY
```

**Run the contract tests:**

```sh
pnpm --filter @chalito/api test:pg
pnpm --filter @chalito/notifier test:pg
pnpm --filter @chalito/billing test:pg
pnpm --filter @chalito/orchestrator test:pg
pnpm --filter @chalito/guard test:pg
```

**Realtime delivery check and the load harness at CI scale** (`docs/LOAD_TEST.md`):

```sh
npm install --no-save --no-package-lock --prefix supabase/scripts @supabase/supabase-js@2.117.2 postgres@3.4.9
node supabase/scripts/realtime-latency.mjs
node supabase/scripts/load-test.mjs
```

**Run the api against the stack.** Use the same shell as the contract tests:

```sh
export SUPABASE_URL=$API_URL SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY DATABASE_ROLE=chalito_server
export CHALITO_SSO_SECRET=local-sso-secret CHALITO_ADMIN_TOKEN=local-admin-token
pnpm --filter @chalito/api dev
```

Check it with `curl localhost:8787/healthz`, which should answer `{"ok":true}`.

Optional features turn on when their keys are set:
- `CHALYB_BASE_URL` for the store and billing;
- `OPENAI_API_KEY` for voice;
- `TWILIO_*` for phone verification.

See `.env.example` and `docs/OPS.md` §5.

**Pair a computer** against the local api: `scripts/e2e-claude.md`, steps 1–2. It covers the agent, the test phone (`scripts/e2e-phone.ts`) and pairing.

**Stop the stack:**

```sh
supabase stop --no-backup
```

### Part 3: desktop bundles (needs Rust)

The Tauri app needs:
- a Rust toolchain;
- Tauri 2's system dependencies (see the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/));
- bun, to compile the agent sidecar.

Release builds, signing and the updater are in `docs/OPS.md` §10 (M14).

### Part 4: the cloud

All of this needs the owner's go. Everything lives in Chalyb's GCP project and the hub's Supabase (ADR 0016, ADR 0017).

| Task | Where |
|---|---|
| GCP bootstrap, Terraform state, `terraform plan` (`terraform apply` only with the owner's go) | `infra/terraform/envs/dev/README.md` |
| Secrets to create, and every owner task | `docs/OPS.md` |
| Deploy, rollback, key rotation, revocation, incidents | `docs/RUNBOOK.md` |
| The hub side | `docs/integrations/CHALYB_ENGINE.md`, `docs/integrations/CHALYB_HANDOFF.md` |

## Repository map

| Path | What |
|---|---|
| `apps/api` | Control plane (Hono on Cloud Run): hub contract, devices, pairing, recovery, OAuth for MCP, rooms, store, voice, phone |
| `apps/notifier` | Escalation ladders: push, WhatsApp, calls, SMS |
| `apps/orchestrator` | Mesa and companion turns |
| `apps/mcp-gateway` | MCP server for ChatGPT and Claude connectors |
| `apps/avatar-jobs` | Upload → 2.5D card job, plus the roster pipeline |
| `apps/agent` | The computer-side agent (`chalito` CLI) |
| `apps/desktop` | Tauri desktop app (pet, panel, rooms) |
| `apps/web` | Next.js PWA |
| `packages/*` | `protocol` (wire schemas), `config` (plans, prices, catalog), `billing`, `guard` (rate limits), `crypto`, `ui`, `roster`, … |
| `supabase/` | Migrations, pgTAP tests, Realtime and load scripts |
| `infra/terraform` | Chalito-only GCP resources |

## Docs

| Doc | What |
|---|---|
| [`docs/PLAN.md`](docs/PLAN.md) | Plan and milestones |
| [`docs/adr/`](docs/adr/) | Architecture decisions |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | Threat model |
| [`docs/SECURITY_EVENTS.md`](docs/SECURITY_EVENTS.md) | Security events and the owner-readable audit views |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Operations |
| [`docs/OPS.md`](docs/OPS.md) | Owner tasks |
| [`docs/LEGAL_CHECKLIST.md`](docs/LEGAL_CHECKLIST.md) | Legal checklist (for counsel) |
| [`docs/LOAD_TEST.md`](docs/LOAD_TEST.md) | Load test |
| [`docs/VERIFIED_APIS.md`](docs/VERIFIED_APIS.md) | Verified third-party APIs |
| [`docs/ASSET_PROVENANCE.md`](docs/ASSET_PROVENANCE.md) | Asset provenance |
| [`DEVIATIONS.md`](DEVIATIONS.md) | Deviations from the brief |
