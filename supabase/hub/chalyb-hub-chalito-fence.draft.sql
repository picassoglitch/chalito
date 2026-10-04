-- =====================================================================
-- DRAFT for the Chalyb hub repo (project nexo-ai). NOT applied by Chalito's migrations, NOT a
-- Chalito migration: copy into a Chalyb migration (next free number) with the owner's go.
--
-- Context: Chalito devices are Supabase Auth users of the hub project, marked by
-- raw_app_meta_data.chalito = {owner, device_id, role} (set server-side by Chalito's API through
-- the Admin API, never by the device). ADR 0017 §Security review fixes, review S1/S5.
-- Written against ~/chalyb supabase/migrations 0001_profiles.sql and 0006_first_user_root.sql
-- (read-only, 2026-10-03). Re-check before applying: a later migration may redefine the function.
-- =====================================================================

-- (a) Device users are not hub people: no profile row, no role, no org, no tier. Without this, a
--     device user created first on a fresh project would even become SUPER_ADMIN (0006).
--     Body = 0006's tg_handle_new_user with one guard added at the top.
create or replace function public.tg_handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_existing_count int;
  v_role user_role;
  v_super_admin_emails text;
  v_email_in_allowlist boolean := false;
begin
  -- Chalito device / pairing-watch users: never a hub profile.
  if new.raw_app_meta_data ? 'chalito' then
    return new;
  end if;

  select count(*) into v_existing_count from public.profiles;

  if v_existing_count = 0 then
    v_role := 'SUPER_ADMIN';
  else
    v_role := 'VIEWER';
  end if;

  insert into public.profiles (id, email, full_name, avatar_url, role, org_id, tier)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url',
    v_role,
    '00000000-0000-0000-0000-000000000001'::uuid,
    'FREE'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
-- The trigger trg_on_auth_user_created (0001/0006) already points at this function; no rebind needed.

-- (b) Template: fence every hub table in an exposed schema so a Chalito device token can't use
--     hub policies that only check "authenticated" (review S1). RESTRICTIVE, so it ANDs with the
--     hub's existing permissive policies and changes nothing for real hub users.
--     Repeat per table (public.profiles shown); a DO loop over the exposed tables is fine too.
create policy chalito_device_fence on public.profiles
  as restrictive
  for all
  to authenticated
  using (not coalesce(auth.jwt() -> 'app_metadata' ? 'chalito', false))
  with check (not coalesce(auth.jwt() -> 'app_metadata' ? 'chalito', false));
-- Also review exposed `security definer` RPCs in the hub's public schema: any that only check
-- auth.uid() / "is authenticated" should start with the same test and refuse device users.

-- (c) realtime.messages compatibility (no SQL needed for the hub's current usage):
--   * The hub uses postgres_changes on public.profiles (migration 0007); those are authorized by
--     the table's RLS, so (b) also keeps device users out of profile change feeds.
--   * Chalito adds, on realtime.messages: a permissive SELECT policy for its own topics and a
--     RESTRICTIVE policy (chalito_topics_guard) that applies only to topics starting with
--     `chalito:`. Hub topics are untouched (tested in Chalito's pgTAP 05 with a permissive
--     `using (true)` hub-style policy present). Hub channels should not use the `chalito:` prefix.
--   * Enforcing private channels needs "Allow public access" off in Realtime settings
--     (project-wide). Hub public broadcast channels, if any, must move to private first.
