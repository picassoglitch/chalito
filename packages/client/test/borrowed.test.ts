import { describe, expect, it } from "vitest";
import { BROWSER_SESSION_KEY, createBorrowedSupabase, memoryStorage, storedAccessToken } from "../src/auth.js";

describe("borrowed session (secondary windows)", () => {
  it("reads the access token the owning client keeps in the shared storage", async () => {
    const storage = memoryStorage();
    const token = storedAccessToken(storage);
    expect(await token()).toBeNull();
    await storage.setItem(BROWSER_SESSION_KEY, JSON.stringify({ access_token: "at1", refresh_token: "rt" }));
    expect(await token()).toBe("at1");
    // The owner refreshed: the next read sees the new token (nothing is cached here).
    await storage.setItem(BROWSER_SESSION_KEY, JSON.stringify({ access_token: "at2" }));
    expect(await token()).toBe("at2");
    await storage.setItem(BROWSER_SESSION_KEY, "not json");
    expect(await token()).toBeNull();
  });

  it("the borrowed client has no auth module of its own (it can't sign in or refresh)", () => {
    const sb = createBorrowedSupabase("http://127.0.0.1:54321", "pk", async () => "at") as unknown as {
      auth: { getSession(): unknown };
    };
    expect(() => sb.auth.getSession()).toThrow(/accessToken/);
  });
});
