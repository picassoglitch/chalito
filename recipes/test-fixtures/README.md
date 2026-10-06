# Recipe catalog: DEV/TEST signing key

`dev-catalog-key.json` is a throwaway Ed25519 key pair (keyId `dev-test-2026-10`) checked in on
purpose so tests and a local api can sign and serve a catalog. It is **public, so it proves
nothing**: it is never listed in `apps/agent/src/apps/catalog-keys.ts`, and no release agent trusts
it. `catalog.dev.signed.json` is `recipes/catalog.json` signed with it (the api serves it locally
with `CHALITO_RECIPE_CATALOG_FILE`); regenerate it after `pnpm recipes build`:

    pnpm recipes sign --key recipes/test-fixtures/dev-catalog-key.json --out recipes/test-fixtures/catalog.dev.signed.json

The production key is an owner action (docs/OPS.md, "Recipe catalog signing key").
