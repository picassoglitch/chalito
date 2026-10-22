// Manual check, not in CI (needs `codex` on PATH and DATABASE_URL): the real Codex CLI → this gateway → a fake
// OpenAI, then the usage in the outbox. Run: DATABASE_URL=… pnpm --filter @chalito/ai-gateway exec tsx test/live-codex.manual.ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { CodingMeter, HubClient, PostgresCodingStore } from "@chalito/billing";
import { FakeHub } from "@chalito/billing/testing";
import { loadPrices, loadProviders } from "@chalito/config";
import { managedOverrides, MANAGED_TOKEN_ENV } from "../../../packages/adapters/src/codex/adapter.js";
import { createGateway } from "../src/app.js";
import { FakeProviders } from "./fake-providers.js";

const url = process.env.DATABASE_URL!;
const admin = postgres(url, { onnotice: () => {} });
const gw = postgres(url, { onnotice: () => {}, connection: { role: "chalito_ai_gateway" } });
const providers = loadProviders();
const hub = new FakeHub();
const fakes = new FakeProviders();
const up = await fakes.start();
fakes.behaviour = {
  kind: "responses",
  usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 50, total_tokens: 5050 },
  text: "hola",
};
const owner = `live-${randomUUID()}`;
const device = `desk_${randomBytes(6).toString("hex")}`;
await admin`insert into chalito.tenants (id) values (${owner})`;
await admin`insert into chalito.users (id, tenant_id, tier, tz) values (${owner}, ${owner}, 'Pro', 'America/Mexico_City')`;
await admin`insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint, enrolled_via, auth_user_id, revoked)
  values (${owner}, ${device}, 'agent', 'desktop', 'linux', 'Desk', 'pk', 'p', 'f', 'pairing', ${randomUUID()}, false)`;
const id = `cc_${randomBytes(16).toString("hex")}`;
const token = `chc_${randomBytes(32).toString("base64url")}`;
await admin`insert into chalito_private.coding_credentials (id, token_hash, owner, device_id, sid, agent, provider, models, expires_at)
  values (${id}, ${createHash("sha256").update(token).digest("hex")}, ${owner}, ${device}, 's', 'codex', 'openai', ${["gpt-5.6-luna"]}, ${new Date(Date.now() + 3600_000)})`;
hub.setUser(owner, 50_000_000);
const hc = new HubClient({ baseUrl: "https://www.chalyb.com", token: "t", fetch: hub.fetch });
const store = new PostgresCodingStore(gw);
const app = createGateway({
  store,
  meter: new CodingMeter({
    store,
    hub: hc,
    prices: loadPrices(),
    cfg: providers.codingManaged,
    reserveBasis: "pre_margin",
    now: Date.now,
  }),
  providers,
  upstreams: { openai: { baseUrl: `${up}/openai/v1`, apiKey: "sk-ours" }, xai: null, google: null },
  enabled: () => true,
  now: Date.now,
});
const server = serve({ fetch: app.fetch, port: 0 });
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const home = mkdtempSync(join(tmpdir(), "codex-home-"));
let out: string;
const t0 = Date.now();
try {
  const p = run(
    "codex",
    [
      "exec",
      "--skip-git-repo-check",
      ...managedOverrides(base).flatMap((o) => ["-c", o]),
      "-c",
      'model="gpt-5.6-luna"',
      "di hola",
    ],
    {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, [MANAGED_TOKEN_ENV]: token },
      cwd: home,
      timeout: 60_000,
      encoding: "utf8",
    },
  );
  p.child.stdin?.end();
  const r = await p;
  out = r.stdout + r.stderr;
} catch (err) {
  out =
    String((err as { stdout?: string; stderr?: string }).stdout ?? "") +
    String((err as { stderr?: string }).stderr ?? "");
}
await new Promise((r) => setTimeout(r, 3000));
const seen = fakes.seen.map((s) => ({
  path: s.path,
  auth: s.headers.authorization,
  model: s.body?.model,
  max: s.body?.max_output_tokens,
}));
const rows =
  await admin`select source_id, event -> 'cost_usd_micros' as cost from chalito_private.usage_outbox where owner = ${owner}`;
process.stdout.write(`${JSON.stringify({ ms: Date.now() - t0, seen, rows, out: out.slice(-1500) }, null, 2)}\n`);
server.close();
await fakes.stop();
await admin.end();
await gw.end();
