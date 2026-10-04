import { afterEach, describe, expect, it, vi } from "vitest";
import { httpMcp, safeOAuthRedirect } from "@/lib/mcp";

afterEach(() => vi.unstubAllGlobals());
const respond = (status: number, body?: unknown) =>
  vi.fn(async () => ({ ok: status < 300, status, json: async () => body ?? {} }) as Response);

describe("MCP connectors api", () => {
  it("follows only https (or loopback) redirects after consent", () => {
    expect(safeOAuthRedirect("https://claude.ai/api/mcp/auth_callback?code=x")).toBe(
      "https://claude.ai/api/mcp/auth_callback?code=x",
    );
    expect(safeOAuthRedirect("http://127.0.0.1:33418/callback")).toBe("http://127.0.0.1:33418/callback");
    for (const bad of ["http://evil.example/cb", "javascript:alert(1)", "data:text/html,x", "/relative", "not a url"])
      expect(safeOAuthRedirect(bad), bad).toBeNull();
  });

  it("maps the api's answers", async () => {
    const api = httpMcp("https://api.example", async () => "tok");
    vi.stubGlobal("fetch", respond(404, { error: "not_found" }));
    expect(await api.getRequest("r1")).toBe("not_found");
    vi.stubGlobal("fetch", respond(409, { error: "no_passkey" }));
    expect(await api.approve("r1", ["mcp:read"], {})).toBe("no_passkey");
    vi.stubGlobal("fetch", respond(403, { error: "forbidden" }));
    expect(await api.setSharing({ sessionId: "s1", enabled: true, plaintextAck: true })).toBe("forbidden");
    const f = respond(204);
    vi.stubGlobal("fetch", f);
    expect(await api.revoke("con_1")).toBe(true);
    expect(f).toHaveBeenCalledWith(
      "https://api.example/v1/connectors/con_1/revoke",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer tok" }) }),
    );
    vi.stubGlobal("fetch", respond(200, { connectors: [{ cid: "c" }] }));
    expect(await api.listConnectors()).toEqual([{ cid: "c" }]);
  });
});
