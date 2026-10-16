/**
 * The pairing loopback (ADR 0028 §4, decision #52): only the hub's origin, only on the loopback
 * Host, Private Network Access preflight answered, small bodies, rate-limited, and only a proof
 * for the code the computer is waiting on.
 */
import { createServer, request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_ORIGIN, loopbackOrigins, startPairingLoopback, type PairingLoopback } from "../src/pairing-loopback.js";

const CODE = "abcdefghijklmnopqrstuv";
const NONCE = "N".repeat(43);

const open: PairingLoopback[] = [];
afterEach(async () => {
  for (const l of open.splice(0)) await l.close();
});

/** A raw HTTP call (fetch would refuse to set Host and Origin). */
const call = (
  port: number,
  o: {
    method?: string;
    path?: string;
    origin?: string;
    host?: string;
    body?: string;
    headers?: Record<string, string>;
  },
) =>
  new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: o.method ?? "POST",
          path: o.path ?? "/pairing/proof",
          headers: {
            host: o.host ?? `127.0.0.1:${port}`,
            ...(o.origin !== undefined ? { origin: o.origin } : {}),
            "content-type": "application/json",
            ...o.headers,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += String(c)));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      if (o.body !== undefined) req.write(o.body);
      req.end();
    },
  );

const start = async (
  o: { prove?: (c: string, n: string, origin: string) => Promise<unknown | null>; perMinute?: number } = {},
) => {
  const asked: [string, string, string][] = [];
  const l = await startPairingLoopback({
    origins: new Set([HUB_ORIGIN]),
    prove: o.prove ?? (async (c, n, origin) => (asked.push([c, n, origin]), c === CODE ? { signed: c } : null)),
    ports: [0],
    ...(o.perMinute ? { perMinute: o.perMinute } : {}),
  });
  open.push(l!);
  return { l: l!, asked };
};

describe("pairing loopback", () => {
  it("answers the hub's Private Network Access preflight", async () => {
    const { l } = await start();
    const r = await call(l.port, {
      method: "OPTIONS",
      origin: HUB_ORIGIN,
      headers: { "access-control-request-method": "POST", "access-control-request-private-network": "true" },
    });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(HUB_ORIGIN);
    expect(r.headers["access-control-allow-private-network"]).toBe("true");
    expect(r.headers["access-control-allow-methods"]).toBe("POST");
  });

  it("signs a proof for the waiting code, for the hub's origin only", async () => {
    const { l, asked } = await start();
    const ok = await call(l.port, { origin: HUB_ORIGIN, body: JSON.stringify({ codeId: CODE, nonce: NONCE }) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ proof: { signed: CODE } });
    expect(asked).toEqual([[CODE, NONCE, HUB_ORIGIN]]);
    // Another code (not the one waiting): nothing signed.
    const other = await call(l.port, {
      origin: HUB_ORIGIN,
      body: JSON.stringify({ codeId: "zyxwvutsrqponmlkjihgfe", nonce: NONCE }),
    });
    expect(other.status).toBe(409);
  });

  it("refuses another origin, no origin, and a non-loopback Host (DNS rebinding)", async () => {
    const { l, asked } = await start();
    const body = JSON.stringify({ codeId: CODE, nonce: NONCE });
    for (const origin of ["https://evil.example", "https://www.chalyb.com.evil.example", "null", ""]) {
      const r = await call(l.port, { origin, body });
      expect(r.status, origin).toBe(403);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect((await call(l.port, { origin: HUB_ORIGIN, host: `evil.example:${l.port}`, body })).status).toBe(421);
    expect(asked).toEqual([]);
  });

  it("refuses bad or oversized bodies and other paths", async () => {
    const { l } = await start();
    expect((await call(l.port, { origin: HUB_ORIGIN, body: "{" })).status).toBe(400);
    expect(
      (await call(l.port, { origin: HUB_ORIGIN, body: JSON.stringify({ codeId: CODE, nonce: "short" }) })).status,
    ).toBe(400);
    expect((await call(l.port, { origin: HUB_ORIGIN, body: "x".repeat(5000) })).status).toBe(413);
    expect((await call(l.port, { origin: HUB_ORIGIN, path: "/", body: "{}" })).status).toBe(404);
    expect((await call(l.port, { origin: HUB_ORIGIN, method: "GET" })).status).toBe(405);
  });

  it("is rate-limited", async () => {
    const { l } = await start({ perMinute: 3 });
    const body = JSON.stringify({ codeId: CODE, nonce: NONCE });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await call(l.port, { origin: HUB_ORIGIN, body })).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it("takes the next port when one is busy, and gives up quietly when none is free", async () => {
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, "127.0.0.1", () => r()));
    const taken = (busy.address() as { port: number }).port;
    try {
      const l = await startPairingLoopback({
        origins: new Set([HUB_ORIGIN]),
        prove: async () => null,
        ports: [taken, 0],
      });
      open.push(l!);
      expect(l!.port).not.toBe(taken);
      expect(
        await startPairingLoopback({ origins: new Set([HUB_ORIGIN]), prove: async () => null, ports: [taken] }),
      ).toBeNull();
    } finally {
      busy.close();
    }
  });

  it("release builds accept only the production hub; dev builds also a local or preview hub", () => {
    const env = {
      CHALITO_WEB_BASE: "http://localhost:3000/app/chalito",
      CHALITO_LOOPBACK_ORIGINS: "https://x.vercel.app, bad",
    };
    expect([...loopbackOrigins(env, true)]).toEqual([HUB_ORIGIN]);
    expect([...loopbackOrigins(env, false)].sort()).toEqual(
      [HUB_ORIGIN, "http://localhost:3000", "https://x.vercel.app"].sort(),
    );
  });
});
