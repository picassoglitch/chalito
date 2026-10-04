# Hub-side drafts (Chalyb, project nexo-ai)

These files are **drafts for the Chalyb hub repository**. Chalito's migrations never apply them, and the Supabase CLI doesn't read this folder. Each one goes into a Chalyb migration through a Chalyb PR, with the owner's go.

- `chalyb-hub-chalito-fence.draft.sql`:
  - (a) Device users get no hub profile (guard in `tg_handle_new_user`).
  - (b) A restrictive fence template for hub tables.
  - (c) Realtime compatibility notes.

  Background: ADR 0017, §Security review fixes.
