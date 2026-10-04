#!/usr/bin/env bash
# GO_LIVE 2.2: dry run of Chalito's migrations on a disposable Supabase branch of nexo-ai.
#
#   NEXO_AI_REF=<main project ref> scripts/nexo-ai-dryrun.sh            # plan: prints the steps, runs nothing
#   NEXO_AI_REF=<main project ref> scripts/nexo-ai-dryrun.sh --yes      # creates a branch [cost], runs, deletes it
#
# Steps with --yes:
#   1. create branch $BRANCH from $NEXO_AI_REF and wait until it has a database;
#   2. refuse unless every URL it got points at the branch, never at $NEXO_AI_REF;
#   3. optional: the hub's migrations first (HUB_DIR = an export of picassoglitch/chalyb, e.g.
#      `git -C ~/chalyb archive d467b02 | tar -x -C /tmp/hub`), so hub tables and its ledger exist;
#   4. Chalito's migrations, by --method:
#        hub   (GO_LIVE 2.4, recommended) copied into a temporary copy of HUB_DIR and pushed with the
#              hub's, one push, one ledger; needs HUB_DIR;
#        push  `supabase db push` from this repo;
#        psql  each file in its own transaction, no ledger;
#   5. pgTAP (`supabase test db`) and the beta rehearsal (apps/rehearsal) against the branch;
#   6. a pass/fail table; the branch is deleted unless --keep.
#
# Ledger: nexo-ai's supabase_migrations ledger holds the hub's versions (Chalyb docs/infra/supabase.md).
# `supabase db push` refuses when the database has versions the local folder doesn't, so with
# HUB_DIR set, --method push is expected to fail the way GO_LIVE 2.4 describes; --method hub is the
# recommended path.
#
# Never targets the main project: every command gets the branch's own URL, checked first.
# Needs: supabase CLI (2.119+), jq, pnpm; psql for --method psql.
set -euo pipefail

usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

YES=0 KEEP=0 METHOD=push
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --keep) KEEP=1 ;;
    --method) METHOD="${2:-}"; shift ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
case "$METHOD" in hub | push | psql) ;; *) echo "--method must be hub, push or psql" >&2; exit 2 ;; esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_REF="${NEXO_AI_REF:-}"
BRANCH="${BRANCH:-chalito-dryrun-$(date -u +%Y%m%d%H%M)}"
HUB_DIR="${HUB_DIR:-}"
REF_RE='^[a-z0-9]{20}$'

if ! [[ "$MAIN_REF" =~ $REF_RE ]]; then
  echo "NEXO_AI_REF must be the main project's ref (20 lowercase letters/digits), the project to branch FROM" >&2
  exit 2
fi
if ! [[ "$BRANCH" =~ ^[a-z0-9-]{3,40}$ ]]; then echo "BRANCH must be 3-40 of [a-z0-9-]" >&2; exit 2; fi
if [ "$METHOD" = hub ] && [ -z "$HUB_DIR" ]; then echo "--method hub needs HUB_DIR" >&2; exit 2; fi
if [ -n "$HUB_DIR" ] && [ ! -d "$HUB_DIR/supabase/migrations" ]; then
  echo "HUB_DIR has no supabase/migrations: $HUB_DIR" >&2; exit 2
fi

plan() {
  cat <<EOF
Plan (nothing has run; add --yes to run it):
  project      $MAIN_REF (branched from, never a target)
  branch       $BRANCH  [cost: a Supabase branch is billed while it exists]
  hub          ${HUB_DIR:-<not seeded>}
  migrations   $(ls "$ROOT"/supabase/migrations/*.sql | wc -l | tr -d ' ') Chalito files, method: $METHOD
  tests        $(ls "$ROOT"/supabase/tests/database/*.sql | wc -l | tr -d ' ') pgTAP files; the beta rehearsal
  afterwards   $([ "$KEEP" = 1 ] && echo "branch kept (delete it: supabase branches delete $BRANCH --project-ref $MAIN_REF)" || echo "branch deleted")
EOF
}

if [ "$YES" != 1 ]; then plan; exit 0; fi

for bin in supabase jq pnpm; do command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 2; }; done
if [ "$METHOD" = psql ]; then command -v psql >/dev/null || { echo "missing: psql (--method psql)" >&2; exit 2; }; fi

plan
echo

declare -a RESULTS=()
FAILED=0
record() { RESULTS+=("$(printf '%-28s %s' "$1" "$2")"); [ "$2" = PASS ] || [ "$2" = SKIP ] || FAILED=1; }

CREATED=0
cleanup() {
  if [ "$CREATED" = 1 ] && [ "$KEEP" != 1 ]; then
    echo "deleting branch $BRANCH"
    supabase branches delete "$BRANCH" --project-ref "$MAIN_REF" --yes >/dev/null 2>&1 ||
      echo "could not delete $BRANCH: supabase branches delete $BRANCH --project-ref $MAIN_REF" >&2
  fi
}
trap cleanup EXIT

echo "== 1. create branch $BRANCH"
supabase branches create "$BRANCH" --project-ref "$MAIN_REF"
CREATED=1

# `branches get -o env` prints the branch's connection settings once it's provisioned.
get_env() { supabase branches get "$BRANCH" --project-ref "$MAIN_REF" -o env 2>/dev/null || true; }
pick() { printf '%s\n' "$ENV_OUT" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" | head -1; }
ENV_OUT=""
for _ in $(seq 1 60); do
  ENV_OUT="$(get_env)"
  if printf '%s' "$ENV_OUT" | grep -q '^POSTGRES_URL'; then break; fi
  sleep 10
done
DB_URL="$(pick POSTGRES_URL_NON_POOLING)"; DB_URL="${DB_URL:-$(pick POSTGRES_URL)}"
API_URL="$(pick SUPABASE_URL)"
ANON="$(pick SUPABASE_ANON_KEY)"; ANON="${ANON:-$(pick SUPABASE_PUBLISHABLE_KEY)}"
SERVICE="$(pick SUPABASE_SERVICE_ROLE_KEY)"; SERVICE="${SERVICE:-$(pick SUPABASE_SECRET_KEY)}"
if [ -z "$DB_URL" ] || [ -z "$API_URL" ] || [ -z "$ANON" ] || [ -z "$SERVICE" ]; then
  echo "the branch's settings are incomplete after 10 minutes (check: supabase branches get --help)" >&2
  record "branch ready" FAIL; printf '%s\n' "${RESULTS[@]}"; exit 1
fi

echo "== 2. refuse the main project"
BRANCH_REF="$(printf '%s' "$API_URL" | sed -n 's#^https://\([a-z0-9]\{20\}\)\.supabase\.co/\{0,1\}$#\1#p')"
if ! [[ "$BRANCH_REF" =~ $REF_RE ]] || [ "$BRANCH_REF" = "$MAIN_REF" ]; then
  echo "refusing: the branch URL $API_URL is not a separate project" >&2; exit 1
fi
case "$DB_URL" in
  *"$MAIN_REF"*) echo "refusing: the database URL names the main project" >&2; exit 1 ;;
  *"$BRANCH_REF"*) ;;
  *) echo "refusing: the database URL doesn't name the branch ($BRANCH_REF)" >&2; exit 1 ;;
esac
record "branch $BRANCH_REF" PASS

if [ "$METHOD" = hub ]; then
  echo "== 3+4. hub and Chalito migrations in one push (a temporary copy of $HUB_DIR)"
  WORK="$(mktemp -d)"
  cp -R "$HUB_DIR/." "$WORK/"
  cp "$ROOT"/supabase/migrations/*.sql "$WORK/supabase/migrations/"
  if (cd "$WORK" && supabase db push --db-url "$DB_URL" --include-all --yes); then
    record "hub + chalito migrations" PASS
  else
    record "hub + chalito migrations" FAIL
  fi
  rm -rf "$WORK"
elif [ -n "$HUB_DIR" ]; then
  echo "== 3. hub migrations ($HUB_DIR)"
  if (cd "$HUB_DIR" && supabase db push --db-url "$DB_URL" --yes); then record "hub migrations" PASS; else record "hub migrations" FAIL; fi
else
  record "hub migrations" SKIP
fi

if [ "$METHOD" = hub ]; then
  :
elif [ "$METHOD" = push ]; then
  echo "== 4. Chalito migrations (push)"
  if (cd "$ROOT" && supabase db push --db-url "$DB_URL" --yes); then
    record "chalito migrations (push)" PASS
  else
    record "chalito migrations (push)" FAIL
    echo "hint: if the push refused remote versions it doesn't have, that is the shared ledger (see the header)." >&2
  fi
else
  echo "== 4. Chalito migrations (psql)"
  ok=PASS
  for f in "$ROOT"/supabase/migrations/*.sql; do
    psql "$DB_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f" >/dev/null || { echo "failed: $f" >&2; ok=FAIL; break; }
  done
  record "chalito migrations (psql)" "$ok"
fi

echo "== 5. pgTAP and the rehearsal"
if (cd "$ROOT" && supabase test db --db-url "$DB_URL"); then record "pgTAP" PASS; else record "pgTAP" FAIL; fi
if (cd "$ROOT" && DATABASE_URL="$DB_URL" SUPABASE_AUTH_URL="${API_URL%/}/auth/v1" SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  SUPABASE_ANON_KEY="$ANON" CHALITO_DB_ROLE=chalito_server CHALITO_REHEARSAL_BRANCH_REF="$BRANCH_REF" \
  CHALITO_REHEARSAL_MAIN_REF="$MAIN_REF" pnpm --filter @chalito/rehearsal test:rehearsal); then
  record "rehearsal" PASS
else
  record "rehearsal" FAIL
fi

echo
echo "== results ($BRANCH, $BRANCH_REF)"
printf '%s\n' "${RESULTS[@]}"
exit "$FAILED"
