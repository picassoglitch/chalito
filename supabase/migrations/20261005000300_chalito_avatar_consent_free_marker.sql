-- Custom companions from a photo: consent, the once-per-person free creation, and onboarding.
-- (Owner decisions 2026-10-05; apps/api src/avatar, docs/RUNBOOK.md 6.6, docs/LEGAL_CHECKLIST.md 5.4.)
--
-- 1. Self-attestation. Every creation records what the person confirmed when they started it: the
--    photo is of themselves, their age band (13–17 or 18+; under 13 can't create) and, for 13–17,
--    that a parent or guardian allows it. No birth date is collected (Chalito stores no age). New
--    rows must carry a valid attestation; rows from before this migration are left as they are.
--
-- 2. The free creation is once per person, not once per account. A free success leaves markers in
--    chalito_private.avatar_free_markers: HMAC-SHA256 under a server key (AVATAR_FREE_MARKER_KEY) of
--    the hub user id and of the hub account's email, lowercased. Only the hash is kept: no email, no
--    id, no owner column, no link to the creation. Account deletion (chalito_private.delete_account)
--    does NOT remove them: they only stop a deleted-and-recreated account (same hub user, or a new
--    hub user with the same email) from getting a second free creation. The api computes the
--    markers at start and stores them on the creation row (free_markers); this trigger copies them
--    to the marker table when that creation succeeds, so a failed free attempt still gives the
--    free credit back.
--
-- 3. Onboarding: use_when_ready. The person can start a creation in onboarding and carry on while
--    it's drawn. When it succeeds, the same transaction points their companion at the new card
--    (companions.asset_id / expression_map), exactly like POST /v1/avatar/use.

alter table chalito.avatar_creations
  add column attest_own_photo boolean,
  add column attest_age_band text check (attest_age_band in ('13_17', '18_plus')),
  add column attest_guardian boolean,
  add column attested_at timestamptz,
  add column use_when_ready boolean not null default false,
  add column free_markers text[]
    check (free_markers is null or (
      free and cardinality(free_markers) between 1 and 4
      and array_to_string(free_markers, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'
    ));

-- New creations need the attestation; NOT VALID leaves rows from before it alone.
alter table chalito.avatar_creations
  add constraint avatar_creations_attested check (
    attested_at is not null
    and attest_own_photo is true
    and attest_age_band is not null
    and (attest_age_band = '18_plus' or attest_guardian is true)
  ) not valid;

-- ================================================================ the free-creation markers
create table chalito_private.avatar_free_markers (
  marker text primary key check (marker ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
comment on table chalito_private.avatar_free_markers is
  'Keyed hashes (HMAC-SHA256) of the hub user id and email of everyone who used their free custom companion. '
  'Not personal data in the clear, no owner link. Kept after account deletion on purpose: it only prevents a '
  'second free creation. See migration 20261005000200 and docs/RUNBOOK.md 6.6.';

alter table chalito_private.avatar_free_markers enable row level security;
revoke all on chalito_private.avatar_free_markers from public, anon, authenticated, service_role;
-- The api reads them (is the free creation still available?); only the trigger below writes them.
grant select on chalito_private.avatar_free_markers to chalito_server;
create policy server_read on chalito_private.avatar_free_markers for select to chalito_server using (true);

-- ================================================================ on success
create or replace function chalito_private.avatar_creation_succeeded()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'succeeded' then
    return null;
  end if;
  if new.free and new.free_markers is not null then
    insert into chalito_private.avatar_free_markers (marker)
    select distinct m from unnest(new.free_markers) as m
    on conflict (marker) do nothing;
  end if;
  if new.use_when_ready then
    -- Never fail the success over this: the card is kept and the person can still pick it.
    begin
      update chalito.companions
      set asset_id = new.asset_id, expression_map = new.manifest -> 'emotions'
      where owner = new.owner;
    exception when others then
      raise warning 'chalito: use_when_ready for % not applied: %', new.creation_id, sqlerrm;
    end;
  end if;
  return null;
end
$$;

create trigger avatar_creations_succeeded
  after insert or update of status on chalito.avatar_creations
  for each row when (new.status = 'succeeded')
  execute function chalito_private.avatar_creation_succeeded();

revoke all on function chalito_private.avatar_creation_succeeded() from public, anon, authenticated, service_role;

comment on function chalito_private.delete_account(text) is
  'Deletes the owner''s Chalito data (migration 20261004003030). Deliberately keeps '
  'chalito_private.avatar_free_markers (keyed hashes, no owner link): they only stop a second free custom companion.';
