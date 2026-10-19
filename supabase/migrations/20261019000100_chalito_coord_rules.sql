-- Coordinator mode (ADR 0025 §6): the owner's remembered answers ("Siempre así").
--
-- A row is a rule signed by one of the owner's trusted clients (`chalito.coordrule.v1`). The row
-- grants nothing by itself: every device verifies the signature against its LOCAL trusted list
-- before using a rule (apps/agent/src/coord/rules.ts), so the server can drop a rule but can't make
-- or widen one. The rule carries only a hash of what it matches; `label_ct` is the text the owner
-- sees in Ajustes, sealed to their clients.
--
-- Writes: the owner's active clients insert their own rules (signer = the writing device) and
-- delete any of the owner's rules. No updates: renewing a rule is a new row. At most 200 per owner.
-- Reads: the owner's active devices (agents read the rules, clients list them).

create table chalito.coord_rules (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  rule_id text not null check (rule_id ~ '^cr_[A-Za-z0-9_-]{8,64}$'),
  signer_device_id chalito.id not null,
  -- The signed envelope as the client made it (ctx, body, signerDeviceId, sig).
  rule jsonb not null check (
    jsonb_typeof(rule) = 'object'
    and octet_length(rule::text) <= 2048
    and rule ->> 'ctx' = 'chalito.coordrule.v1'
    and rule ->> 'signerDeviceId' = signer_device_id
    and rule -> 'body' ->> 'ruleId' = rule_id
    and rule -> 'body' ->> 'uid' = owner
  ),
  label_ct jsonb check (label_ct is null or (jsonb_typeof(label_ct) = 'object' and octet_length(label_ct::text) <= 4096)),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (owner, rule_id),
  foreign key (owner, signer_device_id) references chalito.devices (owner, device_id) on delete cascade
);
create index coord_rules_owner_idx on chalito.coord_rules (owner, expires_at);

-- At most 200 rules per owner (expired ones count until the owner removes them).
create or replace function chalito_private.coord_rules_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('coord_rules:' || new.owner));
  if (select count(*) from chalito.coord_rules where owner = new.owner) >= 200 then
    raise exception 'too many remembered rules' using errcode = '54000';
  end if;
  return new;
end
$$;
revoke all on function chalito_private.coord_rules_cap() from public, anon, authenticated;
create trigger coord_rules_cap before insert on chalito.coord_rules
  for each row execute function chalito_private.coord_rules_cap();

alter table chalito.coord_rules enable row level security;
create policy coord_rules_read on chalito.coord_rules for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.device_ok()));
create policy coord_rules_insert on chalito.coord_rules for insert to authenticated
  with check (
    owner = (select chalito.jwt_owner())
    and signer_device_id = (select chalito.jwt_device_id())
    and (select chalito_private.active_client())
  );
create policy coord_rules_delete on chalito.coord_rules for delete to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.active_client()));
revoke all on chalito.coord_rules from public, anon, authenticated;
grant select, insert, delete on chalito.coord_rules to authenticated;

-- Withdrawn rules (security review, 2026-10-19): a trusted client's signed `chalito.coordrule-revoke.v1`.
-- Devices keep a withdrawal they've seen as a local tombstone, so a rule re-inserted later (a replay
-- by a compromised server) is still refused. Insert-only for the owner's active clients, as
-- themselves; nobody deletes one (it cascades with the account). At most 2000 per owner.
create table chalito.coord_rule_revocations (
  owner chalito.id not null references chalito.users (id) on delete cascade,
  rule_id text not null check (rule_id ~ '^cr_[A-Za-z0-9_-]{8,64}$'),
  signer_device_id chalito.id not null,
  revoke jsonb not null check (
    jsonb_typeof(revoke) = 'object'
    and octet_length(revoke::text) <= 1024
    and revoke ->> 'ctx' = 'chalito.coordrule-revoke.v1'
    and revoke ->> 'signerDeviceId' = signer_device_id
    and revoke -> 'body' ->> 'ruleId' = rule_id
    and revoke -> 'body' ->> 'uid' = owner
  ),
  created_at timestamptz not null default now(),
  primary key (owner, rule_id),
  foreign key (owner, signer_device_id) references chalito.devices (owner, device_id) on delete cascade
);

create or replace function chalito_private.coord_rule_revocations_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('coord_rule_revocations:' || new.owner));
  if (select count(*) from chalito.coord_rule_revocations where owner = new.owner) >= 2000 then
    raise exception 'too many rule withdrawals' using errcode = '54000';
  end if;
  return new;
end
$$;
revoke all on function chalito_private.coord_rule_revocations_cap() from public, anon, authenticated;
create trigger coord_rule_revocations_cap before insert on chalito.coord_rule_revocations
  for each row execute function chalito_private.coord_rule_revocations_cap();

alter table chalito.coord_rule_revocations enable row level security;
create policy coord_rule_revocations_read on chalito.coord_rule_revocations for select to authenticated
  using (owner = (select chalito.jwt_owner()) and (select chalito_private.device_ok()));
create policy coord_rule_revocations_insert on chalito.coord_rule_revocations for insert to authenticated
  with check (
    owner = (select chalito.jwt_owner())
    and signer_device_id = (select chalito.jwt_device_id())
    and (select chalito_private.active_client())
  );
revoke all on chalito.coord_rule_revocations from public, anon, authenticated;
grant select, insert on chalito.coord_rule_revocations to authenticated;
