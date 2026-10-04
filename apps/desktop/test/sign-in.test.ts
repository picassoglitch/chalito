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
    enroll: vi.fn(async (_o: string, onDisplay: (d: unknown) => void) => {
      onDisplay({ shortCode: "ABCDE" });
      return {
        ok: true as const,
        deviceId: "dev1",
        customToken: "h",
        passkey: "unavailable" as const,
        credential: null,
        agents: [],
        droppedAgents: [],
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
  it("browser → callback → exchange → endorsement → ready", async () => {
    const t = setup();
    await t.c.start();
    expect(t.opened).toHaveLength(1);
    expect(new URL(t.opened[0]!).searchParams.get("redirect_uri")).toBe("chalito://auth/sso");
    await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.deps.exchange).toHaveBeenCalledWith("tok");
    expect(t.steps).toEqual(["browser", "exchanging", "endorsing", "endorsing", "ready"]);
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

  it("a link with no sign-in in progress does nothing", async () => {
    const t = setup();
    await t.c.handleUrl(t.link({ token: "tok", state: "s".repeat(43) }));
    expect(t.c.getSnapshot().step).toBe("signed_out");
    expect(t.deps.exchange).not.toHaveBeenCalled();
  });

  it.each([
    [
      "exchange refused",
      { exchange: async () => ({ ok: false as const, reason: "token_replayed" as const }) },
      "token_replayed",
    ],
    [
      "endorsement refused",
      { enroll: async () => ({ ok: false as const, reason: "endorser_not_trusted" as const }) },
      "endorser_not_trusted",
    ],
    ["browser didn't open", { openUrl: () => Promise.reject(new Error("no browser")) }, "open_failed"],
  ] as const)("%s → error", async (_n, over, reason) => {
    const t = setup(over as Partial<SignInDeps>);
    await t.c.start();
    if (reason !== "open_failed") await t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason });
  });

  it("a link without a token ends the attempt", async () => {
    const t = setup();
    await t.c.start();
    await t.c.handleUrl(t.link({ state: t.stateOf() }));
    expect(t.c.getSnapshot()).toEqual({ step: "error", reason: "missing_token" });
  });

  it("cancel during the endorsement wait aborts it and returns to signed out", async () => {
    let signal: AbortSignal | null = null;
    const t = setup({
      enroll: (_o, _d, s) => {
        signal = s;
        return new Promise((resolve) => s.addEventListener("abort", () => resolve({ ok: false, reason: "cancelled" })));
      },
    });
    await t.c.start();
    const done = t.c.handleUrl(t.link({ token: "tok", state: t.stateOf() }));
    await Promise.resolve();
    await Promise.resolve();
    t.c.cancel();
    await done;
    expect(signal!.aborted).toBe(true);
    expect(t.c.getSnapshot().step).toBe("signed_out");
  });
});
