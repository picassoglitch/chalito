import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, SessionAdapter, SessionHandle, SessionStartOptions } from "../src/core.js";
import { BUILTIN_ACP_RECIPES, profileFor, type AcpAdapterConfig } from "../src/acp/index.js";
import { BYO_KEY_ENV, MANAGED_TOKEN_ENV, codexLaunch, managedOverrides } from "../src/codex/index.js";
import { ManagedSessionAdapter, type ManagedCredential, type ManagedSource } from "../src/managed.js";

const GW = "https://ai.chalito.chalyb.com";
const TOKEN = `chc_${"a".repeat(43)}`;

describe("IA de Chalyb: Codex points at our gateway", () => {
  it("an env-key provider on {base}/v1 with the session token in the child's env only, never a provider key", () => {
    const l = codexLaunch({
      codexPath: "/opt/codex",
      managed: { baseUrl: `${GW}/`, token: TOKEN },
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-the-users-own", [BYO_KEY_ENV]: "sk-x" },
    });
    expect(l.args).toEqual(expect.arrayContaining(managedOverrides(GW).flatMap((o) => ["-c", o])));
    expect(l.args).toContain(`model_providers.chalito_managed.base_url="${GW}/v1"`);
    expect(l.args).toContain(`model_providers.chalito_managed.env_key="${MANAGED_TOKEN_ENV}"`);
    expect(l.args).toContain('model_providers.chalito_managed.wire_api="responses"');
    expect(l.env[MANAGED_TOKEN_ENV]).toBe(TOKEN);
    expect(l.env.OPENAI_API_KEY).toBeUndefined();
    expect(l.env[BYO_KEY_ENV]).toBeUndefined();
    expect(l.args.join(" ")).not.toContain(TOKEN);
  });

  it("refuses a gateway that isn't https (plain http only on this machine)", () => {
    expect(() => codexLaunch({ managed: { baseUrl: "http://ai.example.com", token: TOKEN } })).toThrow(/https/);
    expect(codexLaunch({ managed: { baseUrl: "http://127.0.0.1:8790", token: TOKEN } }).env[MANAGED_TOKEN_ENV]).toBe(
      TOKEN,
    );
  });
});

describe("IA de Chalyb: Grok Build and Gemini CLI point at our gateway", () => {
  const launch = (id: "grok" | "gemini" | "goose", config: Partial<AcpAdapterConfig>) => {
    const home = mkdtempSync(join(tmpdir(), "chalito-managed-"));
    const p = profileFor(BUILTIN_ACP_RECIPES[id]);
    const c = { binPath: "/bin/x", home, env: { PATH: "/usr/bin", XAI_API_KEY: "xai-users-own" }, ...config };
    return { l: p.launch(c, "default"), auth: p.authenticate(c), home };
  };
  const managed = { baseUrl: GW, token: TOKEN, model: "grok-4.3" };

  it("Grok: its models endpoint is ours, the token is its XAI_API_KEY, our default model, in Chalito's own GROK_HOME", () => {
    const { l, auth, home } = launch("grok", { managed });
    expect(l.env).toMatchObject({
      GROK_MODELS_BASE_URL: `${GW}/v1`,
      XAI_API_KEY: TOKEN,
      GROK_DEFAULT_MODEL: "grok-4.3",
      GROK_HOME: home,
      GROK_TELEMETRY_ENABLED: "false",
    });
    expect(auth).toEqual({ methodId: "xai.api_key" });
  });

  it("Gemini: its base URL is ours, the model is pinned, the token goes in authenticate, never the env", () => {
    const { l, auth } = launch("gemini", { managed: { ...managed, model: "gemini-3.1-flash-lite" } });
    expect(l.env.GOOGLE_GEMINI_BASE_URL).toBe(GW);
    expect(l.args.slice(-2)).toEqual(["--model", "gemini-3.1-flash-lite"]);
    expect(Object.values(l.env)).not.toContain(TOKEN);
    expect(auth).toEqual({ methodId: "gemini-api-key", _meta: { "api-key": TOKEN } });
  });

  it("any other ACP recipe has no IA de Chalyb", () => {
    expect(() => launch("goose", { managed })).toThrow(/no IA de Chalyb/);
  });
});

class Source implements ManagedSource {
  issued: string[] = [];
  ended: string[] = [];
  blocked: "out_of_energy" | "daily_cap" | null = null;
  refuse: { blocked: "out_of_energy" | "daily_cap" | null } | null = null;
  async issue(sid: string): Promise<ManagedCredential> {
    if (this.refuse) throw Object.assign(new Error("refused"), this.refuse);
    this.issued.push(sid);
    return { id: `cc_${sid}`, token: TOKEN, baseUrl: GW, model: "gpt-5.6-luna" };
  }
  async status() {
    return { state: "active" as const, blockedReason: this.blocked };
  }
  async end(id: string) {
    this.ended.push(id);
  }
}

/** The CLI side: emits what the test tells it, ends when closed. */
const cli = (made: ManagedCredential[]) => {
  let emit: (e: AdapterEvent) => void = () => undefined;
  let finish: () => void = () => undefined;
  const make = (c: ManagedCredential): SessionAdapter => {
    made.push(c);
    return {
      kind: "codex",
      async start(o: SessionStartOptions): Promise<SessionHandle> {
        emit = o.onEvent;
        const done = new Promise<void>((r) => (finish = r));
        return {
          prompt() {},
          interrupt: async () => {},
          setPermissionMode: async () => {},
          close: () => finish(),
          done,
        };
      },
    };
  };
  return { make, emit: (e: AdapterEvent) => emit(e) };
};

const opts = (events: AdapterEvent[]): SessionStartOptions => ({
  sid: "s1",
  cwd: "/ws",
  prompt: "hola",
  origin: "local" as never,
  permissionMode: "default",
  gate: async () => ({ allow: true }),
  askUser: async () => ({}),
  onEvent: (e) => void events.push(e),
});

describe("ManagedSessionAdapter", () => {
  it("one credential per session, checked after each turn (blocked once), revoked when the session ends", async () => {
    const source = new Source();
    const made: ManagedCredential[] = [];
    const c = cli(made);
    const a = new ManagedSessionAdapter("codex", { source, make: c.make });
    const events: AdapterEvent[] = [];
    const h = await a.start(opts(events));
    expect(source.issued).toEqual(["s1"]);
    expect(made[0]).toMatchObject({ id: "cc_s1", token: TOKEN });
    c.emit({ type: "state", state: "idle" });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.filter((e) => e.type === "blocked")).toEqual([]);
    source.blocked = "out_of_energy";
    c.emit({ type: "state", state: "failed" });
    c.emit({ type: "state", state: "idle" });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.filter((e) => e.type === "blocked")).toEqual([{ type: "blocked", reason: "out_of_energy" }]);
    h.close();
    await h.done;
    await new Promise((r) => setTimeout(r, 10));
    expect(source.ended).toEqual(["cc_s1"]);
  });

  it("refused at start for tokens or the cap: the same blocked event, and no CLI starts", async () => {
    const source = new Source();
    source.refuse = { blocked: "daily_cap" };
    const made: ManagedCredential[] = [];
    const events: AdapterEvent[] = [];
    await expect(
      new ManagedSessionAdapter("codex", { source, make: cli(made).make }).start(opts(events)),
    ).rejects.toThrow();
    expect(events).toEqual([{ type: "blocked", reason: "daily_cap" }]);
    expect(made).toEqual([]);
  });
});
