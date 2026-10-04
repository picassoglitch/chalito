# Hub-side drafts (Chalyb, project nexo-ai)

These files are **drafts for the Chalyb hub repository**. Chalito's migrations never apply them, and the Supabase CLI doesn't read this folder. Each one goes into a Chalyb migration through a Chalyb PR, with the owner's go.

- `chalyb-hub-chalito-fence.draft.sql`:
  - (a) Device users get no hub profile (guard in `tg_handle_new_user`).
  - (b) A restrictive fence template for hub tables.
  - (c) Realtime compatibility notes.

  Background: ADR 0017, §Security review fixes.

## Hub sign-off items in Chalito's own migrations

These run on the **shared** project, so the hub owner signs off before they're applied there:
- `20261004000900_chalito_pairing_watchers.sql` schedules the pg_cron job `chalito-pairing-watchers` (hourly at :23). It **deletes from `auth.users`**, but only users with all three:
  - an email in the reserved domain `@pairing.chalito.invalid`;
  - `app_metadata.chalito.role = 'pairing'`;
  - an age over 1 hour.
  pgTAP `06_pairing_watchers` proves that hub users (even in that domain) and device users are untouched.
- The other pg_cron jobs (`chalito-purge-expired`, `chalito-flush-coalesced`, `chalito-cron-history`) touch only Chalito's schemas and the history of Chalito's own jobs.
- Exposing `chalito` in the Data API and turning off Realtime public access (ADR 0017 §Risks).
