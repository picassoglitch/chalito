# ADR 0009: MCP gateway: auth, scopes and tools

- Status: Accepted (M0); implemented in M10

## Verified context (2026-10-03)
- The MCP spec's latest revision is **2026-07-28**. Its authorization rules:
  - OAuth 2.1 with PKCE (S256).
  - RFC 9728 Protected Resource Metadata (MUST) and an RFC 8707 `resource` parameter (MUST).
  - RFC 9207 `iss` validation.
  - **Client ID Metadata Documents are SHOULD; Dynamic Client Registration is deprecated (MAY).**
- **Claude** custom connectors accept `oauth_cimd` (preferred), `oauth_dcr` and `none`. They work on Free (1 connector), Pro, Max, Team and Enterprise. On Team/Enterprise an Owner adds them.
- **ChatGPT** Developer mode / apps: plan requirements are in VERIFIED_APIS §OpenAI.
- The TS SDK v2 (`@modelcontextprotocol/server` 2.3 + `@modelcontextprotocol/hono`) implements 2026-07-28. v1 (`@modelcontextprotocol/sdk`) is legacy.

## Decision
- **Authorization server = Chalito's own OAuth endpoints on `api`.** Sign-in goes through the Chalyb hub SSO plus the user's Chalito passkey (ADR 0016).
  - Supported metadata: CIMD (`client_id_metadata_document_supported: true`, `token_endpoint_auth_methods_supported: ["none"]`) plus DCR for backward compatibility.
  - The consent screen lists scopes in Spanish/English.
  - Access tokens last 15 min. Refresh tokens rotate. The token audience is pinned to the `mcp-gateway` resource URL.
- **Scopes.** These are the only ones that exist:
  - `mcp:read` → `list_pending` (metadata only unless shared) and `get_session_card` (plaintext only with card sharing on).
  - `mesa:post` → `post_to_mesa` (gateway seals to clients; `origin: mcp:<provider>`).
  - `approval:recommend` → `recommend_decision` (appends to `recommendations[]`, advisory only).
  - `session:prompt` → `prompt_session` (sealed to the device key; a `RelayedCommand` that can only prompt). **Separate, explicit grant, default unchecked.**
- **The gateway reads Firestore read-only** (IAM `datastore.viewer`, conditioned to the `chalito` database). Service accounts bypass security rules, so its writes (`post_to_mesa`, `recommend_decision`, `prompt_session`) go through `api`, which enforces the scope checks (D-035).
- **Never grantable:** `approval:decide`, `device:admin`, policy, Developer mode, rooms, billing. The gateway's service account has **no Firestore write access** to decisions, devices, endorsements, policy, rooms or billing docs (IAM + rules, tested). It holds **no signing key**.
- **Grants** are stored in `users/{uid}/connectors/{cid}` and can be revoked instantly. Revocation checks run on every call, not only at token refresh.
- **Approvals produced by MCP-origin turns** need a signed phone decision (biometric for HIGH), even with `autoApproveHigh` on.
- **Audit:** every MCP call and every sharing opt-in is logged.
