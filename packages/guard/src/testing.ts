import type { Hono } from "hono";
import type { RouteTable } from "./index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono's generics vary per app
type AnyHono = Hono<any, any, any>;

const norm = (p: string) => (p.length > 1 ? p.replace(/\/$/, "") : p);

/**
 * Every `"METHOD /path"` an app serves, from Hono's router. Middleware shows up as method ALL:
 * an ALL entry counts as a route only when nothing else is registered at its path and the path
 * has no wildcard (app.all(path, handler), as the MCP endpoint does).
 */
export const servedRoutes = (app: AnyHono): string[] => {
  const all = app.routes.map((r) => ({ method: r.method, path: norm(r.path) }));
  const specific = new Set(all.filter((r) => r.method !== "ALL").map((r) => r.path));
  return [
    ...new Set(
      all
        .filter((r) => r.method !== "ALL" || (!r.path.includes("*") && !specific.has(r.path)))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
};

export const tableRoutes = (table: RouteTable) => Object.keys(table).sort();

const concrete = (path: string) =>
  path
    .split("/")
    .map((s) => (s.startsWith(":") ? "x1" : s === "*" ? "x" : s))
    .join("/");

/**
 * Drives every table entry through the app from its own client IP: `capacity` requests pass the
 * limiter (whatever the handler then answers), the next one is 429; and a body one byte over the
 * cap is 413 before any handler runs. Returns the routes that misbehave (empty = all good).
 */
export const probeLimits = async (app: AnyHono, table: RouteTable): Promise<string[]> => {
  const bad: string[] = [];
  let ip = 0;
  for (const [route, limit] of Object.entries(table)) {
    const [m, path] = route.split(" ") as [string, string];
    const method = m === "ALL" ? "POST" : m;
    const url = `http://local${concrete(path)}`;
    ip += 1;
    const from = `10.9.${Math.floor(ip / 250)}.${ip % 250}`;
    const hasBody = method !== "GET" && method !== "DELETE";
    const send = (headers: Record<string, string> = {}, body?: string) =>
      app.request(url, {
        method,
        headers: { "x-forwarded-for": from, "content-type": "application/json", ...headers },
        ...(hasBody ? { body: body ?? "{}" } : {}),
      });
    for (let i = 0; i < limit.capacity; i++) {
      const r = await send();
      if (r.status === 429) {
        bad.push(`${route}: limited after ${i} of ${limit.capacity}`);
        break;
      }
    }
    if ((await send()).status !== 429) bad.push(`${route}: request ${limit.capacity + 1} wasn't limited`);
    if (hasBody) {
      const big = "x".repeat(limit.bodyBytes + 1);
      const r = await app.request(url, {
        method,
        headers: { "x-forwarded-for": `${from}0`, "content-type": "application/json" },
        body: big,
      });
      if (r.status !== 413) bad.push(`${route}: a ${limit.bodyBytes + 1}-byte body got ${r.status}, not 413`);
    }
  }
  return bad;
};
