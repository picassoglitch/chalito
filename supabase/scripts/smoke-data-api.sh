#!/usr/bin/env bash
# End-to-end check against the LOCAL stack only (`supabase start`): a device JWT minted with the
# local stack's signing key reads its own rows through PostgREST, a revoked device is denied on
# its next request, and the anon key gets nothing. Needs curl and jq. Never point this at a
# hosted project.
set -euo pipefail

eval "$(supabase status -o env)"
case "${API_URL:-}" in
  http://127.0.0.1:* | http://localhost:*) ;;
  *) echo "refusing to run against ${API_URL:-<unset>}: local stack only" >&2; exit 1 ;;
esac

rest() { # rest <method> <path> <bearer> [json]
  curl -sS -X "$1" "$API_URL/rest/v1/$2" \
    -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer $3" \
    -H "Accept-Profile: chalito" -H "Content-Profile: chalito" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    ${4:+--data "$4"}
}
admin() { # Server writes, as the API does them (service_role bypasses RLS).
  curl -sS -f -X "$1" "$API_URL/rest/v1/$2" \
    -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" \
    -H "Accept-Profile: chalito" -H "Content-Profile: chalito" \
    -H "Content-Type: application/json" -H "Prefer: return=minimal" \
    ${3:+--data "$3"}
}

admin POST tenants '{"id":"smoke-user"}'
admin POST users '{"id":"smoke-user","tenant_id":"smoke-user"}'
admin POST devices '{"owner":"smoke-user","device_id":"smoke-phone","role":"client","kind":"phone","platform":"ios","name":"Smoke","pub_sign":"p","pub_box":"p","fingerprint":"f","enrolled_via":"first_client"}'

# Custom claims (claim_source() = 'custom'): top level, iss = chalito.
TOKEN="$(supabase gen bearer-jwt --role authenticated --sub smoke-user --valid-for 5m \
  --payload '{"iss":"chalito","aud":"authenticated","owner":"smoke-user","device_id":"smoke-phone","chalito_role":"client"}')"
ISS="$(cut -d. -f2 <<<"$TOKEN" | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r .iss || true)"
if [ "$ISS" != "chalito" ]; then
  echo "minted token has iss=$ISS; the CLI did not keep the custom issuer (ADR 0017 §Tokens)" >&2
  exit 1
fi

n="$(rest GET 'devices?select=device_id' "$TOKEN" | jq length)"
[ "$n" = 1 ] || { echo "active device should read its own device row, got $n" >&2; exit 1; }

admin PATCH 'devices?device_id=eq.smoke-phone' '{"revoked":true}'
n="$(rest GET 'devices?select=device_id' "$TOKEN" | jq length)"
[ "$n" = 0 ] || { echo "revoked device should read nothing, got $n" >&2; exit 1; }

body="$(rest GET 'devices?select=device_id' "$ANON_KEY")"
jq -e 'type == "object" and (.code == "42501")' <<<"$body" >/dev/null \
  || { echo "anon should be denied, got: $body" >&2; exit 1; }

echo "smoke: ok"
