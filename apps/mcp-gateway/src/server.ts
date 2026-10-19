import { installConsoleRedaction } from "@chalito/redact";
import { checkRole } from "@chalito/config";
import { serve } from "@hono/node-server";
import { GatewayApi } from "./api-client.js";
import { createGateway } from "./app.js";
import { PostgresGatewayReader, gatewaySql } from "./postgres-reader.js";

// Every stray console call is redacted (R-M9).
installConsoleRedaction();
const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

// DATABASE_URL: a login that acts as chalito_gateway (read-only): through the transaction pooler a
// login member whose default role is chalito_gateway; elsewhere one that holds it with SET.
const role = process.env.DATABASE_ROLE ?? "chalito_gateway";
const sql = gatewaySql(env("DATABASE_URL"), { role });
await checkRole(sql, role);

const app = createGateway({
  reader: new PostgresGatewayReader(sql),
  api: new GatewayApi(env("CHALITO_API_URL"), env("CHALITO_GATEWAY_TOKEN")),
  cfg: {
    resource: process.env.CHALITO_MCP_RESOURCE ?? "https://mcp.chalito.chalyb.com/mcp",
    issuer: process.env.CHALITO_API_ISSUER ?? "https://api.chalito.chalyb.com",
    // The A2A server: off unless both are set (no default URL; its domain is owner decision #36).
    ...(process.env.CHALITO_A2A_ENABLED === "1" && process.env.CHALITO_A2A_RESOURCE
      ? { a2aResource: process.env.CHALITO_A2A_RESOURCE }
      : {}),
  },
  now: Date.now,
});

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port });
process.stdout.write(`[mcp-gateway] listening on :${port}\n`);
