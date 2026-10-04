# @chalito/orchestrator

The Mesa and companion turn loop (brief §5 M9) on Cloud Run. Billing goes through the Chalyb hub (ADR 0013/0016,
`@chalito/billing`).

| Provider | API | Notes |
|---|---|---|
| Anthropic | Messages API (`@anthropic-ai/sdk`) | Persona prefix with `cache_control`; 5-minute and 1-hour cache writes priced separately. |
| OpenAI | Responses API (`openai` SDK) | `prompt_cache_key`; ordinary input = input − cached − written. |
| xAI | Responses API at `https://api.x.ai/v1` (`openai` SDK) | Cached tokens are a subset of input. |
| Google | Gemini via `@google/genai` on Vertex, `global` endpoint | Thinking tokens billed as output. |

Every provider answers through one forced function, `respond` (`ParticipantOutput`). The shapes are in
`docs/VERIFIED_APIS.md` ("Brain APIs for the Mesa"). Participants map to providers and models through `models.yaml`
for the person's efficiency profile. A provider without a configured key is skipped before anything is admitted.

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
   - Choose who pays:
     - **BYO**, when the person stored a key for that provider and opted in to cloud turns. No admission and no
       billable event (`usageEvent` returns null), but the budget caps still apply.
     - **Managed** otherwise. The default `standard` profile is `claude-sonnet-5-5`. A managed model missing from
       `prices.yaml` is skipped (fail closed) before any spend.
   - Build the brief: the cached persona prefix (`cache_control`), goal ≤60 tokens, card ≤300 tokens, last ≤3 turns,
     the input, all kept under the profile's brief budget.
   - Check the per-Mesa and per-participant token caps (runaway-loop guard).
   - Managed only: **`admitManaged`** with the hub before any call.
   - Call Claude with a single forced tool, `respond` (`ParticipantOutput`). Invalid output is replaced by bounded
     text.
   - In **one transaction**: write the sealed reply, its `llm.tokens` usage event in the outbox (cost from
     `prices.yaml`, including cache reads and 5-minute/1-hour cache writes) and the Mesa's token counters. Then settle
     the reservation. A provider error or a failed write settles it as `failed`, with no charge.
4. **Decisions.** When a participant fills `decision_needed`, the orchestrator creates a pending `kind=decision`
   approval:
   - device `orchestrator`, origin `client:<the device that took the turn>`;
   - details sealed to the person's clients (`aad approval:<aid>`).

   The person decides with the normal signed Decision. A database trigger records the first signed answer for a
   Mesa decision (migration 002300). The orchestrator has no grant and no code path to resolve one.
5. **Out of energy.** When the hub says `no_tokens`, the balance is 0, or there's no managed allowance (trial,
   free_min), managed speakers finish on `free_min`. The companion turn carries the recharge line from
   `copy/recharge.*.yaml`, the `tired` emotion and animation, and an inline "¿Por qué?" chip to `/creditos`. No LLM
   call and no charge. BYO speakers in the same round still talk. Other refusals stop managed speakers without a
   recharge line.
6. **Card merge.** Proposals, objections and decision questions become open points, and the card stays ≤300 tokens.
   The updated card is returned to the client.

## Session participants

A Mesa can reference live Claude Code or Codex sessions (`{kind: "session", sid}`, at most 2). The client sends their
cards, which it can open, with the turn. They go into briefs as quoted data under "Sessions (status only; you can't
prompt them)". A session never speaks, is never addressed, and is never prompted from here: the orchestrator has no
command path. Prompting a session takes the person's own signed command, as always.

## BYO brain keys

`PUT /v1/brain-keys/:provider` takes `{sealedCt, cloud, key?, hint?}`:

- `sealedCt` is the key sealed by the client to the person's own devices (`aad brainkey:<owner>:<provider>`).
- With `cloud: true`, the plaintext `key` is sent once. It is wrapped with Cloud KMS immediately (AAD bound to owner
  and provider) and stored in `chalito_private.brain_key_wrapped`, readable only by the orchestrator.
- With `cloud: false`, there is no server copy; turning cloud off deletes the wrapped copy.

`DELETE /v1/brain-keys/:provider` removes both copies. Clients read their sealed rows under RLS; the MCP gateway
can't read either table.

## Usage read API (for the usage page)

`GET /v1/usage/daily?days=1..31` (client device token) returns:

```ts
{
  days: { day: "YYYY-MM-DD";
          managed: { work: { tokens, costUsdMicros }; comms: { tokens, costUsdMicros } };
          byo: { tokens, estCostUsdMicros } }[];        // oldest first, UTC days, zero-filled
  totals: { managedTokens, managedCostUsdMicros, commsCostUsdMicros, byoTokens };
  commsOverheadRatio: number | null;                   // comms ÷ all managed cost; null if nothing spent
  target: 0.1;
}
```

- Managed figures come from the usage outbox: every metered kind (LLM, voice, calls, WhatsApp, SMS), with `purpose`
  from the event.
- BYO figures come from Mesa turns, with an estimated cost from `prices.yaml`; they are never billed.

## Prompt-injection hygiene

- Everything that isn't the person's own words goes into the brief as quoted data: MCP and room text, other
  participants' replies, session cards, and the Mesa card. It is JSON-encoded inside a `<data source="…">` element that can't be closed
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

- **Trial state.** The hub (chalyb `a5733df`) doesn't expose it on balance or admit, so `hubTrialActive` is `false`.
- **The usage page UI** (web).

## Environment

| Variable | |
|---|---|
| `DATABASE_URL`, `DATABASE_ROLE` | Postgres as `chalito_server` (`DATABASE_ROLE` when the login only holds it with SET). |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Device token verification. |
| `CHALYB_BASE_URL`, `CHALITO_ADMIN_TOKEN` | Hub admit/settle/balance. |
| `ANTHROPIC_API_KEY` | Chalito's managed Claude key, from Secret Manager. |
| `OPENAI_API_KEY`, `XAI_API_KEY` | Optional managed keys; without one, that provider's participants are skipped. |
| `GOOGLE_CLOUD_PROJECT` | Gemini on Vertex (`global`, ADC); without it, the low profile's companion uses Claude. |
| `BRAIN_KEYS_KMS_KEY` | Cloud KMS key (`projects/…/cryptoKeys/…`) that wraps BYO keys for cloud turns. |
| `OWNER_UIDS` | Comped owners. |
| `PORT` | Default 8080. |

Tests mock all four provider APIs and the hub with msw, and use a local AES-GCM wrapper in place of KMS (no cloud) (`pnpm --filter @chalito/orchestrator test`). The Postgres store test
runs against `DATABASE_URL` (`test:pg`).
