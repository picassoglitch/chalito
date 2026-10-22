import { describe, expect, it } from "vitest";
import {
  AgentEvent,
  CommandBody,
  CommandRejectReason,
  RelayedCommand,
  Origin,
  isSignedOrigin,
  RouteRules,
  SessionTransfer,
  SessionTransferAck,
  normalizeRemote,
  resolveRoute,
  type RouteComputer,
} from "../src/index.js";

const now = 1_000_000;
const cmd = (payload: unknown, origin = "client:phone1") => ({
  v: 1,
  cid: "c1",
  uid: "u1",
  targetDeviceId: "devA",
  origin,
  nonce: "n".repeat(22),
  issuedAt: now,
  expiresAt: now + 60_000,
  payload,
});

describe("session.transfer (ADR 0031 §4)", () => {
  it("is a client command with a session and a target computer", () => {
    const r = CommandBody.safeParse(cmd({ type: "session.transfer", sid: "s1", toDeviceId: "devB" }));
    expect(r.success).toBe(true);
    expect(CommandBody.safeParse(cmd({ type: "session.transfer", sid: "s1" })).success).toBe(false);
  });

  it("can't be relayed by any cloud surface or another agent", () => {
    for (const [relayedBy, origin] of [
      ["mcp-gateway", "mcp:claude"],
      ["notifier", "call:CA" + "0".repeat(32)],
      ["a2a-server", "a2a:x1"],
    ] as const) {
      const env = { relayedBy, body: cmd({ type: "session.transfer", sid: "s1", toDeviceId: "devB" }, origin) };
      expect(RelayedCommand.safeParse(env).success).toBe(false);
    }
    // An agent origin carries only link payloads: the body itself is refused.
    expect(
      CommandBody.safeParse(cmd({ type: "session.transfer", sid: "s1", toDeviceId: "d" }, "agent:s9")).success,
    ).toBe(false);
  });

  it("names its refusals in the closed reject set", () => {
    for (const r of ["session_busy", "transfer_dirty", "transfer_unpushed", "no_link"])
      expect(CommandRejectReason.safeParse(r).success).toBe(true);
  });

  it("emits session.transferred with closed stages and reasons", () => {
    const e = {
      v: 1,
      eid: "e1",
      sid: "s1",
      deviceId: "devA",
      seq: 3,
      t: now,
      type: "session.transferred",
      direction: "out",
      stage: "refused",
      peerDeviceId: "devB",
      reason: "offline",
    };
    expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(AgentEvent.safeParse({ ...e, reason: "disk full at /home/aldo" }).success).toBe(false);
    expect(AgentEvent.safeParse({ ...e, stage: "moving" }).success).toBe(false);
    expect(
      AgentEvent.safeParse({ ...e, stage: "sent", reason: undefined, branch: "chalito/move-0a1b2c3d" }).success,
    ).toBe(true);
    expect(AgentEvent.safeParse({ ...e, stage: "sent", reason: undefined, branch: "--force" }).success).toBe(false);
    for (const reason of [
      "busy",
      "no_link",
      "dirty",
      "unpushed",
      "wrong_repo",
      "link_refused",
      "start_failed",
      "push_auth",
      "push_failed",
    ])
      expect(AgentEvent.safeParse({ ...e, reason }).success).toBe(true);
  });

  it("carries the brief, the app and the repo, nothing else", () => {
    const t = {
      v: 1,
      kind: "chalito.transfer.v1",
      fromSid: "s1",
      appId: "claude-code",
      permissionMode: "plan",
      title: "Arreglar login",
      brief: "Tú: arregla el login\nIA: listo",
      repo: { remote: "github.com/picassoglitch/chalito", branch: "fix/login", head: "a".repeat(40) },
    };
    expect(SessionTransfer.safeParse(t).success).toBe(true);
    expect(SessionTransfer.safeParse({ ...t, cwd: "/home/aldo/code" }).success).toBe(false);
    expect(SessionTransfer.safeParse({ ...t, permissionMode: "bypassPermissions" }).success).toBe(false);
    expect(SessionTransfer.safeParse({ ...t, repo: { ...t.repo, branch: "--upload-pack=x" } }).success).toBe(false);
    expect(SessionTransfer.safeParse({ ...t, brief: "x".repeat(32_001) }).success).toBe(false);
    expect(SessionTransferAck.safeParse({ v: 1, kind: "chalito.transfer.ack.v1", sid: "s2" }).success).toBe(true);
  });
});

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:picassoglitch/chalito.git", "github.com/picassoglitch/chalito"],
    ["https://github.com/picassoglitch/chalito.git", "github.com/picassoglitch/chalito"],
    ["https://aldo:ghp_secret@GitHub.com/picassoglitch/chalito/", "github.com/picassoglitch/chalito"],
    ["ssh://git@github.com:22/picassoglitch/chalito", "github.com/picassoglitch/chalito"],
  ])("%s → %s", (url, want) => expect(normalizeRemote(url)).toBe(want));

  it("never keeps credentials, and refuses local paths and odd schemes", () => {
    expect(normalizeRemote("https://aldo:ghp_secret@github.com/o/r")).not.toContain("ghp_");
    expect(normalizeRemote("/srv/git/repo.git")).toBeNull();
    expect(normalizeRemote("https://github.com/o/%E0%A4%A.git")).toBeNull();
    expect(normalizeRemote("file:///srv/git/repo.git")).toBeNull();
    expect(normalizeRemote("ext::sh -c touch% /tmp/pwned")).toBeNull();
    expect(normalizeRemote("https://github.com/o/../../etc")).not.toContain("..");
    expect(normalizeRemote("git@github.com:o/../../etc")).toBeNull();
  });
});

describe("routing rules (ADR 0031 §5)", () => {
  const pc = (deviceId: string, o: Partial<RouteComputer> = {}): RouteComputer => ({
    deviceId,
    online: true,
    adapters: ["claude-code", "codex"],
    labels: ["chalito", "taquito"],
    workspaces: 2,
    ...o,
  });
  const rules = (r: unknown) => RouteRules.parse(r);

  it("caps the size so it fits in the owner's settings", () => {
    const big = { v: 1, rules: [], fallback: Array.from({ length: 6 }, (_, i) => `d${i}`) };
    expect(RouteRules.safeParse(big).success).toBe(true);
    const many = {
      v: 1,
      rules: Array.from({ length: 8 }, () => ({
        workspaceLabel: "w".repeat(60),
        appId: "a".repeat(41),
        devices: ["x".repeat(128), "y".repeat(128), "z".repeat(128)],
      })),
      fallback: [],
    };
    expect(RouteRules.safeParse(many).success).toBe(false);
    expect(RouteRules.safeParse({ ...big, rules: Array(9).fill({ devices: ["a"] }) }).success).toBe(false);
  });

  it("follows the first rule that applies, to its first able computer", () => {
    const r = rules({
      v: 1,
      rules: [
        { workspaceLabel: "taquito", devices: ["home"] },
        { workspaceLabel: "chalito", devices: ["office", "home"] },
      ],
      fallback: [],
    });
    expect(resolveRoute(r, { workspaceLabel: "chalito", appId: "codex" }, [pc("home"), pc("office")])).toEqual({
      ok: true,
      deviceId: "office",
      appId: "codex",
      workspaceLabel: "chalito",
      via: "rule",
      rule: 1,
    });
  });

  it("skips an offline computer, then one without the app, and moves on to the next rule", () => {
    const r = rules({
      v: 1,
      rules: [{ workspaceLabel: "chalito", devices: ["office", "laptop"] }, { devices: ["home"] }],
      fallback: [],
    });
    const got = resolveRoute(r, { workspaceLabel: "chalito", appId: "codex" }, [
      pc("office", { online: false }),
      pc("laptop", { adapters: ["claude-code"] }),
      pc("home"),
    ]);
    expect(got).toMatchObject({ ok: true, deviceId: "home", via: "rule", rule: 1 });
  });

  it("lets a rule fill the AI the owner left open, but never override one they chose", () => {
    const r = rules({ v: 1, rules: [{ workspaceLabel: "chalito", appId: "codex", devices: ["home"] }], fallback: [] });
    expect(resolveRoute(r, { workspaceLabel: "chalito" }, [pc("home")])).toMatchObject({
      ok: true,
      appId: "codex",
      via: "rule",
    });
    // The owner chose Claude: the Codex rule doesn't apply; any able computer runs it.
    expect(resolveRoute(r, { workspaceLabel: "chalito", appId: "claude-code" }, [pc("home")])).toMatchObject({
      ok: true,
      appId: "claude-code",
      via: "any",
    });
  });

  it("uses the fallback order, then any able computer, then says none", () => {
    const r = rules({ v: 1, rules: [], fallback: ["b", "a"] });
    expect(resolveRoute(r, { workspaceLabel: "chalito" }, [pc("a"), pc("b")])).toMatchObject({
      deviceId: "b",
      via: "fallback",
      appId: "claude-code",
    });
    expect(
      resolveRoute(r, { workspaceLabel: "chalito" }, [pc("a"), pc("b", { online: false }), pc("c")]),
    ).toMatchObject({ deviceId: "a", via: "fallback" });
    expect(resolveRoute(null, { workspaceLabel: "chalito" }, [pc("c")])).toMatchObject({ deviceId: "c", via: "any" });
    expect(resolveRoute(r, { workspaceLabel: "otro" }, [pc("a"), pc("b")])).toEqual({
      ok: false,
      reason: "no_computer",
    });
    expect(resolveRoute(r, { workspaceLabel: "chalito" }, [])).toEqual({ ok: false, reason: "no_computer" });
  });

  it("needs a workspace unless the computer has only one, and trusts a cut label list", () => {
    expect(resolveRoute(null, {}, [pc("a")])).toEqual({ ok: false, reason: "no_computer" });
    expect(resolveRoute(null, {}, [pc("a", { labels: ["solo"], workspaces: 1 })])).toMatchObject({
      workspaceLabel: "solo",
    });
    // 25 workspaces, 20 labels reported: "w24" may well be there; the computer has the last word.
    const labels = Array.from({ length: 20 }, (_, i) => `w${i}`);
    expect(resolveRoute(null, { workspaceLabel: "w24" }, [pc("a", { labels, workspaces: 25 })])).toMatchObject({
      ok: true,
    });
    expect(resolveRoute(null, { workspaceLabel: "w24" }, [pc("a", { labels, workspaces: 20 })]).ok).toBe(false);
  });
});

describe("the terminal origin (ADR 0031 §1)", () => {
  it("parses, and is never a signed origin", () => {
    expect(Origin.safeParse("local:cli").success).toBe(true);
    expect(isSignedOrigin("local:cli")).toBe(false);
    expect(isSignedOrigin("local")).toBe(true);
    expect(Origin.safeParse("local:panel").success).toBe(false);
  });
});
