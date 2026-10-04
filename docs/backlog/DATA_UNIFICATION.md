# Backlog: data store cleanup and unification (Chalyb + Chalito)

- Status: **not started**. Parked by the owner on 2026-10-03 for a future session.
- Owner's words: "we have gcp buckets, sql, supabase. we eventually need to make a db cleanup and unification. but for later."

## Why
Data is spread across several systems:
- Supabase (the hub's Postgres + auth);
- GCP Cloud SQL, per the owner (instance and purpose not yet inventoried);
- GCS buckets;
- BigQuery, which Chalito had planned;
- Firestore, Chalito's original design. It is being replaced by the hub's Supabase (ADR 0017, in progress) and must be removed afterwards.

Each extra store costs money, needs backups, access rules and secrets, and makes a full picture of user data (privacy, export, deletion) harder.

## Scope for the session that picks this up
1. **Inventory, read-only first.** For each store, record: project or instance, region, owner, which app reads or writes it, size, monthly cost, backups/PITR, who has access, and whether anything still uses it. Known starting points:
   - Supabase project `uqcbziwdgbnzehipzjxp` (hub; ChalyClip and ChalyOBS tables live there too; ChalyCrypto expects schema `chalybcrypto` but prod has `nexocrypto`).
   - Cloud SQL: the owner mentioned "sql". Find the instance(s) in Chalyb's GCP project and what uses them.
   - GCS buckets in Chalyb's project, including Chalito's planned `*-chalito-{assets,records,releases,showcase}`.
   - Chalyb Terraform: local state at `~/chalyb/infra/terraform/terraform.tfstate`.
   - Chalito Terraform: `infra/terraform` (Firestore, BigQuery and Pub/Sub modules to revisit after ADR 0017).
2. **Target picture (proposal for the owner):** one Postgres (Supabase) for relational and realtime data, with a schema per app (`public`/hub, `chalito`, `chalybclip`, …); GCS only for blobs; analytics either in Postgres or exported to BigQuery on purpose, not by default. Remove unused stores.
3. **Migration plan per store:** data moves, downtime, a rollback plan, and checks that row counts and money totals match.
4. **Cleanup:** delete only after the owner approves each deletion, in writing, store by store. Take backups first.

## Rules
- Nothing destructive without the owner's explicit go for that specific resource.
- No Wayak resources are involved; never touch them.
- Chalyb changes go through Chalyb's own repo and PRs.
