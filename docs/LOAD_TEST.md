# Load test (M15)

`supabase/scripts/load-test.mjs` drives Supabase Realtime with real GoTrue device sessions (supabase-js), the way the apps use it.

**Scenarios:**
- **Devices with listener churn.** Each simulated owner has an agent subscribed to `chalito:device:<id>` and a phone.
  - Phones insert commands through the Data API, so RLS and the per-device rate buckets apply.
  - A share of the agents (`CHURN`) keeps leaving and rejoining while the rest receive.
  - Realtime has no replay (clients resync by `rev`), so only stable agents count toward delivery.
- **Room fan-out.** Family rooms (5 members) and office rooms (20) are subscribed on `chalito:room:<id>` by each member's phone. The server posts through `chalito_private.room_post`, as the api does.
- **Isolation under load.** No command or room event may reach another device or room.

**Pass criteria:**
- every message delivered to every stable subscriber;
- no leaks;
- p95 delivery under `P95_LIMIT_MS` (default 2000) for commands and for room fan-out.

**Output:** join, command, rejoin and per-room-type percentiles, printed and written to `LOADTEST_OUT` as JSON. Fixtures and auth users are deleted at the end.

**Why not k6 or autocannon:** the load that matters here is Realtime's authorized private channels over GoTrue sessions. supabase-js speaks that protocol; k6 or autocannon would need it re-implemented. The HTTP routes' limits are covered by the per-app route-table tests (`@chalito/guard`).

## CI scale (runs on every PR)

The `supabase` job runs it against the local stack (`supabase start`) after `realtime-latency.mjs`, with the defaults:

| Knob | Default |
|---|---|
| owners | 25 (50 devices) |
| family rooms | 2 |
| office rooms | 1 |
| commands per agent | 5 |
| posts per room | 5 |
| churn | 20% |

The results file is uploaded as the `load-test` artifact.

To run it locally you need Docker for `supabase start`:

```sh
supabase start -x studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,storage-api
npm install --no-save --no-package-lock --prefix supabase/scripts @supabase/supabase-js@2.117.2 postgres@3.4.9
node supabase/scripts/load-test.mjs
```

## The 1k-device run (owner-approved, not run yet)

This run targets a real dev Supabase project, so it costs money and needs the owner's go (docs/OPS.md). The script refuses a remote target without `CHALITO_LOADTEST_APPROVED=yes`.

```sh
LOADTEST_TARGET=remote CHALITO_LOADTEST_APPROVED=yes \
LOADTEST_API_URL=https://<dev-ref>.supabase.co LOADTEST_DB_URL='postgresql://…' \
LOADTEST_ANON_KEY=… LOADTEST_SERVICE_ROLE_KEY=… \
OWNERS=500 FAMILY_ROOMS=50 OFFICE_ROOMS=5 OFFICE_SIZE=50 COMMANDS=10 ROOM_POSTS=20 CHURN=0.2 \
CONCURRENCY=25 LOADTEST_OUT=load-1k.json node supabase/scripts/load-test.mjs
```

That's 1,000 devices: 500 agents and 500 phones. It also creates 50 family rooms and 5 office rooms of 50.

**Before:**
- Check the project's Realtime quotas: concurrent connections, and messages per second.
- Check the GoTrue rate limits. The run creates 1,000 auth users, and an admin key is exempt from the signup limit.
- Run off-peak.

**During:** watch the dashboard's Realtime and Postgres CPU graphs.

**After:**
- Record the results here: date, project tier, the JSON summary, and anything throttled.
- Confirm the fixtures are gone. Owners are prefixed `lt<run>`, and their auth users have emails `lt…@devices.chalito.invalid`.
