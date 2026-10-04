# @chalito/orchestrator

The Mesa and companion turn loop (brief §5 M9) on Cloud Run. Brains are called through the Claude API (Anthropic TS
SDK); billing goes through the Chalyb hub (ADR 0013/0016, `@chalito/billing`).

## A turn

`POST /v1/mesas/:mid/turns` comes from an **active client device** of the owner (a Supabase device token).

1. **Input.** The client sends its text, or text it forwards from an MCP app or a room. With it come the parts of the
   brief only the client can read: the goal, the Mesa Card and the last ≤3 turns, all plaintext over TLS. The input
   turn is stored sealed to the owner's client devices (`aad mesa:<mid>`). A retried `tid` is refused (409) before
   anything is spent.
2. **Moderator.** Rules first (`@Name`, `Name:`, `@todos`/`@all`), then an optional cheap model; otherwise the
   companion answers. **Only addressed participants are called.** Forwarded MCP or room text reaches the companion
   only: it never fans out to every brain.
3. **Per speaker:**
   - Pick the model from `models.yaml` for the person's efficiency profile. The default `standard` profile is
     `claude-sonnet-5-5`. A model missing from `prices.yaml` fails closed before any spend.
   - Build the brief: the cached persona prefix (`cache_control`), goal ≤60 tokens, card ≤300 tokens, last ≤3 turns,
     the input, all kept under the profile's brief budget.
   - Check the per-Mesa and per-participant token caps (runaway-loop guard).
   - **`admitManaged`** with the hub before any call.
   - Call Claude with a single forced tool, `respond` (`ParticipantOutput`). Invalid output is replaced by bounded
     text.
   - In **one transaction**: write the sealed reply, its `llm.tokens` usage event in the outbox (cost from
     `prices.yaml`, including cache reads and 5-minute/1-hour cache writes) and the Mesa's token counters. Then settle
     the reservation. A provider error or a failed write settles it as `failed`, with no charge.
4. **Out of energy.** When the hub says `no_tokens`, the balance is 0, or there's no managed allowance (trial,
   free_min), the turn finishes on `free_min`. The companion turn carries the recharge line from
   `copy/recharge.*.yaml`, the `tired` emotion and animation, and an inline "¿Por qué?" chip to `/creditos`. No LLM
   call and no charge. Other refusals stop the round without a recharge line.
5. **Card merge.** Proposals, objections and decision questions become open points, and the card stays ≤300 tokens.
   The updated card is returned to the client.

## Prompt-injection hygiene

- Everything that isn't the person's own words goes into the brief as quoted data: MCP and room text, other
  participants' replies, and the card. It is JSON-encoded inside a `<data source="…">` element that can't be closed
  from inside.
- The system prompt says data is never instructions.
- The only tool is `respond`. Nothing here can approve, deny or decide: approvals are signed on the phone.

## Storage (migrations 001800/001900)

- `chalito.mesas.doc` holds metadata only: participants, budget, `used` counters and status. There is no goal, card
  or text.
- `chalito.mesa_turns.doc` holds a `MesaTurn` with `outCt` sealed to client devices, plus plaintext metadata:
  `model`, `profile`, `source`, `decisionNeeded`, and `energy` (the chip).
- Clients read both under RLS and get Realtime pointers. Only `chalito_server` writes, and on `mesas` only `doc`.

## Not yet

- **Other providers.** GPT and Grok brain participants are skipped (no adapters yet). The `low` profile's Gemini
  companion falls back to that profile's Claude model.
- **Decisions.** `decision_needed` is flagged on the turn but not yet turned into a `kind=decision` approval.
- **Session participants by reference, BYO keys for brains, and the usage/comms-overhead page.**

## Environment

| Variable | |
|---|---|
| `DATABASE_URL`, `DATABASE_ROLE` | Postgres as `chalito_server` (`DATABASE_ROLE` when the login only holds it with SET). |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Device token verification. |
| `CHALYB_BASE_URL`, `CHALITO_ADMIN_TOKEN` | Hub admit/settle/balance. |
| `ANTHROPIC_API_KEY` | Chalito's managed key, from Secret Manager. |
| `OWNER_UIDS` | Comped owners. |
| `PORT` | Default 8080. |

Tests mock the Claude API and the hub with msw (`pnpm --filter @chalito/orchestrator test`). The Postgres store test
runs against `DATABASE_URL` (`test:pg`).
