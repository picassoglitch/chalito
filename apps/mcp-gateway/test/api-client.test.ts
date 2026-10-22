import { describe, expect, it } from "vitest";
import { GatewayApi, GatewayApiError } from "../src/api-client.js";

const api = (status: number, body: string) =>
  new GatewayApi("https://api.test", "svc", (async () => new Response(body, { status })) as typeof fetch);

describe("GatewayApi error bodies", () => {
  it("a non-JSON error page (Cloud Run 502) is a GatewayApiError with a code, not a SyntaxError", async () => {
    const err = await api(502, "<html>Bad Gateway</html>")
      .audit("tok", { tool: "list_pending" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayApiError);
    expect(err).toMatchObject({ status: 502, code: "upstream_502" });
  });

  it("a JSON error keeps the api's code", async () => {
    await expect(
      api(403, JSON.stringify({ error: "scope_missing" })).audit("tok", { tool: "list_pending" }),
    ).rejects.toMatchObject({
      code: "scope_missing",
    });
  });
});
