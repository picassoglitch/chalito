# @chalito/mcp-gateway

Chalito as a remote MCP server (Streamable HTTP, MCP 2026-07-28) for Claude and ChatGPT. ADR 0009, D-017, D-035.

- **Resource:** `https://mcp.chalito.chalyb.com/mcp` (`CHALITO_MCP_RESOURCE`)
- **Authorization server:** the Chalito api (`/.well-known/oauth-authorization-server`). OAuth 2.1 with PKCE S256 and
  public clients only. Client ID Metadata Documents are preferred; DCR is kept for clients without CIMD.
- **Discovery:** an unauthenticated call gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"` (RFC 9728). That document
  names the api as the authorization server.

## Tools and scopes

| Tool                 | Scope                | What it does                                                                                     |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `list_pending`       | `mcp:read`           | Pending approvals: metadata only. A session's card is included only if the person shared it.     |
| `get_session_card`   | `mcp:read`           | Session status. The card is returned only while sharing is on for that session or device.        |
| `post_to_mesa`       | `mesa:post`          | Seals the text to the person's client devices here, then stores the turn (origin `mcp:<provider>`). |
| `recommend_decision` | `approval:recommend` | Adds an advisory recommendation. The person still signs every decision on their phone.            |
| `prompt_session`     | `session:prompt`     | Seals the prompt to the session's agent key and queues a `RelayedCommand` (origin `mcp:<provider>`). |

`session:prompt` is a separate grant. It is never pre-checked on the consent screen, and it is only offered to Claude
and ChatGPT connectors. No scope exists for deciding approvals, device admin, policy, Developer mode, rooms or billing.

A prompt from MCP is an unsigned turn. Developer mode never auto-approves it, so any HIGH or CRITICAL action it leads
to waits for a passkey-signed decision from the phone, even with `autoApproveHigh` on.

## Security model

- Access tokens last 15 minutes. Refresh tokens rotate, and reusing an old one revokes the whole grant.
- Tokens are opaque, stored only as SHA-256 hashes, and pinned to the gateway's resource (RFC 8707).
- **Every request** looks up the token, so revoking a connector (`POST /v1/connectors/:cid/revoke`, or RFC 7009
  `/oauth/revoke`) cuts it off on the next call.
- The gateway's database role, `chalito_gateway`, is **read-only**. `supabase/tests/database/10_mcp_gateway.test.sql`
  checks that it has no write privilege on any `chalito` or `chalito_private` table. Its writes go through the api
  (`/v1/gateway/*`) with the gateway's service token **and** the caller's access token, and the api re-checks the
  grant and its scopes.
- The api and database only ever see ciphertext for Mesa posts and prompts.

### Card sharing (opt-in)

Sharing is off by default, set per session or per device on a client (`POST /v1/mcp/sharing`). Turning it on
requires `plaintextAck: true`: the person acknowledges that the session card will be stored in plaintext so MCP can
read it. While sharing is on, the agent may write `chalito.session_card_plain` (RLS only allows it then). Turning
sharing off deletes the plaintext copy (database trigger).

## Running locally

```sh
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres \
DATABASE_ROLE=chalito_gateway \
CHALITO_API_URL=http://127.0.0.1:8787 \
CHALITO_GATEWAY_TOKEN=dev-gateway-token \
CHALITO_MCP_RESOURCE=http://127.0.0.1:8788/mcp \
CHALITO_API_ISSUER=http://127.0.0.1:8787 \
pnpm --filter @chalito/mcp-gateway dev
```

Give the api the same `CHALITO_GATEWAY_TOKEN`, `CHALITO_MCP_RESOURCE` and `CHALITO_API_ISSUER`, plus
`CHALITO_WEB_ORIGIN` for the consent page (`/oauth/consent?request=…`).

## Connecting from Claude (custom connector)

1. In Claude, open **Settings → Connectors → Add custom connector**. For Team and Enterprise, an owner adds it under
   **Organization settings → Connectors**.
2. Name: `Chalito`. URL: `https://mcp.chalito.chalyb.com/mcp`. Leave the OAuth client ID and secret empty: Claude
   identifies itself with its Client ID Metadata Document. Its redirect is `https://claude.ai/api/mcp/auth_callback`.
3. Click **Connect**. Chalito's consent page opens (ES/EN):
   - sign in with your Chalyb account;
   - choose the permissions (`session:prompt` is off unless you tick it);
   - approve with your phone's passkey.
4. Your connectors are listed by `GET /v1/connectors`, and `POST /v1/connectors/:cid/revoke` removes one (the
   web/app UI for this ships separately). Revocation takes effect on the next call.

For **Claude Code**, run `claude mcp add --transport http chalito https://mcp.chalito.chalyb.com/mcp`, then `/mcp` to
authenticate. It uses a loopback redirect (`http://localhost:<port>/callback`). Loopback clients registered through
DCR are not offered `session:prompt`.

## Connecting from ChatGPT (Developer mode)

1. In ChatGPT, open **Settings → Apps & Connectors → Advanced settings** and turn on **Developer mode**. On
   Business, Enterprise and Edu, an admin must allow it first.
2. Under **Settings → Apps & Connectors → Create**:
   - Name: `Chalito`;
   - MCP server URL: `https://mcp.chalito.chalyb.com/mcp`;
   - Authentication: **OAuth**.

   ChatGPT's client ID is its CIMD URL, `https://chatgpt.com/oauth/client.json`, so no client secret is needed.
3. Approve on Chalito's consent page with your phone's passkey, as above.
4. In a chat, enable the connector from the **Developer mode** tool menu. ChatGPT asks before each write tool
   (`post_to_mesa`, `recommend_decision`, `prompt_session`). Chalito still requires your signed approval for anything
   risky a prompt leads to.
