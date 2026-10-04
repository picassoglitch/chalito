#!/usr/bin/env bash
# End-to-end check against the LOCAL stack only (`supabase start`):
#   * a device token (Supabase Auth user per device: sub = the device's auth user id, claims in
#     app_metadata.chalito) minted with the local stack's signing key reads its own rows through
#     PostgREST, and a revoked device is denied on its next request;
#   * the same claims on a different auth user read nothing (S5);
#   * the anon key and the hub's service_role key get nothing from the chalito schema (S2).
# Server writes go through Postgres as chalito_server, as the API does. Needs curl and jq.
# Never point this at a hosted project.
set -euo pipefail

eval "$(supabase status -o env)"
case "${API_URL:-}" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "refusing to run against ${API_URL:-<unset>}: local stack only" >&2; exit 1 ;;
esac

rest() { # rest <method> <path> <bearer>
  curl -sS -X "$1" "$API_URL/rest/v1/$2" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer $3" \
    -H "Accept-Profile: chalito" -H "Content-Profile: chalito"
}
server_sql() { supabase db query --local "set role chalito_server; $1" >/dev/null; }

DEVICE_USER="$(cat /proc/sys/kernel/random/uuid)"
server_sql "insert into chalito.tenants (id) values ('smoke-user');
  insert into chalito.users (id, tenant_id) values ('smoke-user', 'smoke-user');
  insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint,
    enrolled_via, auth_user_id)
  values ('smoke-user', 'smoke-phone', 'client', 'phone', 'ios', 'Smoke', 'p', 'p', 'f', 'first_client', '$DEVICE_USER');"

mint() { # mint <sub>
  supabase gen bearer-jwt --role authenticated --sub "$1" --valid-for 5m \
    --payload '{"aud":"authenticated","app_metadata":{"provider":"chalito","chalito":{"owner":"smoke-user","device_id":"smoke-phone","role":"client"}}}'
}
TOKEN="$(mint "$DEVICE_USER")"
OTHER="$(mint "$(cat /proc/sys/kernel/random/uuid)")"

expect_rows() { # expect_rows <n> <token> <what>
  local body n
  body="$(rest GET 'devices?select=device_id' "$2")"
  n="$(jq 'if type == "array" then length else -1 end' <<<"$body")"
  [ "$n" = "$1" ] || { echo "$3: expected $1 rows, got: $body" >&2; exit 1; }
}
expect_denied() { # expect_denied <token> <what>
  local body
  body="$(rest GET 'devices?select=device_id' "$1")"
  jq -e 'type == "object" and (.code == "42501")' <<<"$body" >/dev/null \
    || { echo "$2 should be denied, got: $body" >&2; exit 1; }
}

expect_rows 1 "$TOKEN" "the active device"
expect_rows 0 "$OTHER" "another auth user with the device's claims"
expect_denied "$ANON_KEY" "anon"
expect_denied "$SERVICE_ROLE_KEY" "the hub's service_role"

server_sql "update chalito.devices set revoked = true, revoked_at = now() where device_id = 'smoke-phone';"
expect_rows 0 "$TOKEN" "the revoked device"

echo "smoke: ok"
