/**
 * Public keys that may sign the curated recipe catalog (`GET /v1/recipes/catalog`), by keyId,
 * as unpadded base64url Ed25519 public keys. Compiled into the agent: a catalog the api serves
 * is used only if one of these verifies it, so a compromised api or bucket can't add or change a
 * recipe (which decides what the agent installs and runs).
 *
 * EMPTY until the owner creates the production catalog key (owner action, docs/OPS.md
 * "Recipe catalog signing key"): until then agents use only the catalog built into them
 * (recipes/catalog.json) and ignore the remote one. The dev/test key pair in
 * recipes/test-fixtures/ is NEVER listed here; tests pass it explicitly.
 */
export const CATALOG_KEYS: Readonly<Record<string, string>> = Object.freeze({});
