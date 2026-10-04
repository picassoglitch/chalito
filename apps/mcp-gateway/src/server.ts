import { serve } from "@hono/node-server";
import { GatewayApi } from "./api-client.js";
import { createGateway } from "./app.js";
import { PostgresGatewayReader, gatewaySql } from "./postgres-reader.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

// DATABASE_URL: a login that holds chalito_gateway (read-only). DATABASE_ROLE=chalito_gateway when the
// login only has it with SET (local); unset when the login inherits it (deploy).
const sql = gatewaySql(env("DATABASE_URL"), {
  role: process.env.DATABASE_ROLE ?? "chalito_gateway",
});

const app = createGateway({
  reader: new PostgresGatewayReader(sql),
  api: new GatewayApi(env("CHALITO_API_URL"), env("CHALITO_GATEWAY_TOKEN")),
  cfg: {
    resource: process.env.CHALITO_MCP_RESOURCE ?? "https://mcp.chalito.chalyb.com/mcp",
    issuer: process.env.CHALITO_API_ISSUER ?? "https://api.chalito.chalyb.com",
  },
  now: Date.now,
});

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port });
process.stdout.write(`[mcp-gateway] listening on :${port}\n`);
