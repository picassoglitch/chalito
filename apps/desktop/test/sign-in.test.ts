import { describe, expect, it, vi } from "vitest";
import { SignInController, type SignInDeps } from "../src/lib/sign-in.js";
import { SsoFlow } from "../src/lib/sso.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";

const setup = (over: Partial<SignInDeps> = {}) => {
  const flow = new SsoFlow("https://chalyb.com/engines/chalito/launch");
  const opened: string[] = [];
  const deps: SignInDeps = {
    flow,
    openUrl: async (u) => void opened.push(u),
    exchange: vi.fn(async () => ({ ok: true as const, owner: OWNER })),
    enroll: vi.fn(async (_o: string) => {
      return {
        ok: true as const,
        deviceId: "dev1",
        customToken: "h",
        passkey: "unavailable" as const,
        credential: null,
        agents: [],
      };
    }),
    ...over,
  };
  const c = new SignInController(deps);
  const steps: string[] = [];
  c.subscribe(() => steps.push(c.getSnapshot().step));
  const stateOf = () => new URL(opened.at(-1)!).searchParams.get("state")!;
  const link = (q: Record<string, string>) => `chalito://auth/sso?${new URLSearchParams(q)}`;
  return { c, deps, opened, steps, stateOf, link };
};

describe("desktop sign-in controller", () => {
  it("browser → callback → exchange → the sign-in enrols this computer → ready, no code shown", async () => {
    const t = setup();
    await t.c.start();
    expect(t.opened).toHaveLength(1);
    expect(new URL(t.opened[0]!).searchParams.get("redirect_uri")).toBe("chalito://auth/sso");
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.deps.exchange).toHaveBeenCalledWith("tok");
    expect(t.steps).toEqual(["browser", "exchanging", "enrolling", "ready"]);
    expect(t.deps.enroll).toHaveBeenCalledWith(OWNER);
    expect(t.c.getSnapshot()).toEqual({ step: "ready", owner: OWNER, deviceId: "dev1", passkey: "unavailable" });
  });

  it("debug builds redirect to the loopback bound to the same state", async () => {
    const devRedirect = vi.fn(async (state: string) => `http://127.0.0.1:4321/auth/sso#${state.length}`);
    const t = setup({ devRedirect });
    await t.c.start();
    const u = new URL(t.opened[0]!);
    expect(devRedirect).toHaveBeenCalledWith(u.searchParams.get("state"));
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4321/auth/sso#43");
  });

  it("a forged or stray link is ignored: the real one still completes", async () => {
    const t = setup();
    await t.c.start();
    await t.c.handleUrl(t.link({ token: "evil", state: "f".repeat(43) }));
    await t.c.handleUrl("chalito://elsewhere/x");
    expect(t.c.getSnapshot().step).toBe("browser");
    expect(t.c.lastIgnored).toBe("wrong_target");
    expect(t.deps.exchange).not.toHaveBeenCalled();
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.c.getSnapshot().step).toBe("ready");
  });

  it("a link with no sign-in in progress (app restarted) says so instead of staying silent", async () => {
    const t = setup();
    await t.c.handleUrl(t.link({ token: "tok", state: "s".repeat(43) }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason: "no_pending" });
    expect(t.deps.exchange).not.toHaveBeenCalled();
    // Retrying from the panel starts a sign-in this launch can finish.
    await t.c.start();
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.c.getSnapshot().step).toBe("ready");
  });

  it("the same link twice (double click on 'Abrir Chalito') while exchanging: no error, ends ready", async () => {
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const t = setup({
      exchange: vi.fn(async () => {
        await held;
        return { ok: true as const, owner: OWNER };
      }),
    });
    await t.c.start();
    const link = t.link({ token: "tok", state: t.stateOf() });
    const first = t.c.handleUrl(link);
    await t.c.handleUrl(link);
    release();
    await first;
    expect(t.steps).not.toContain("error");
    expect(t.c.getSnapshot().step).toBe("ready");
  });

  it("Sign in clicked twice, the first tab finishes: a hint, and the newest tab still completes", async () => {
    const t = setup();
    await t.c.start();
    const first = t.stateOf();
    await t.c.start();
    await t.c.handleUrl(t.link({ token: "old", state: first }));
    expect(t.c.getSnapshot()).toEqual({ step: "browser", stale: true });
    expect(t.deps.exchange).not.toHaveBeenCalled();
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.c.getSnapshot().step).toBe("ready");
  });

  it("a stray link doesn't replace a real error on screen", async () => {
    const t = setup({ exchange: async () => ({ ok: false as const, reason: "token_replayed" as const }) });
    await t.c.start();
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    await t.c.handleUrl(t.link({ token: "tok", state: "s".repeat(43) }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason: "token_replayed" });
  });

  it("a stray link after signing in leaves the session alone", async () => {
    const t = setup();
    await t.c.start();
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    await t.c.handleUrl(t.link({ token: "old", state: "s".repeat(43) }));
    expect(t.c.getSnapshot().step).toBe("ready");
    expect(t.c.lastIgnored).toBe("no_pending");
  });

  it.each([
    [
      "exchange refused",
      { exchange: async () => ({ ok: false as const, reason: "token_replayed" as const }) },
      "token_replayed",
    ],
    ["sign-in refused", { enroll: async () => ({ ok: false as const, reason: "rejected" as const }) }, "rejected"],
    [
      "api without the sign-in route",
      { enroll: async () => ({ ok: false as const, reason: "unsupported" as const }) },
      "unsupported",
    ],
    ["browser didn't open", { openUrl: () => Promise.reject(new Error("no browser")) }, "open_failed"],
  ] as const)("%s → error", async (_n, over, reason) => {
    const t = setup(over as Partial<SignInDeps>);
    await t.c.start();
    if (reason !== "open_failed") await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason });
  });

  it("an enrolment that throws (keychain, storage) is an error, never stuck on enrolling", async () => {
    const t = setup({ enroll: () => Promise.reject(new Error("keychain")) });
    await t.c.start();
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason: "failed" });
  });

  it("a link without a token ends the attempt", async () => {
    const t = setup();
    await t.c.start();
    await t.c.handleUrl(t.link({ state: t.stateOf() }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason: "missing_token" });
  });

  it("cancel while enrolling returns to signed out, and a late result is ignored", async () => {
    let finish: (r: Awaited<ReturnType<SignInDeps["enroll"]>>) => void = () => undefined;
    const t = setup({ enroll: () => new Promise((resolve) => (finish = resolve)) });
    await t.c.start();
    const done = t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    await Promise.resolve();
    await Promise.resolve();
    t.c.cancel();
    finish({ ok: true, deviceId: "dev1", customToken: "h", passkey: "unavailable", credential: null, agents: [] });
    await done;
    expect(t.c.getSnapshot().step).toBe("signed_out");
  });
});
