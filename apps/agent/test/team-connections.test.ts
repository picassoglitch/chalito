import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TeamConnections } from "../src/team/connections.js";
import { TeamHub } from "../src/team/hub.js";
import { ipcHandlers, type IpcDeps } from "../src/ipc-handlers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const rig = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chalito-team-trust-")));
  roots.push(root);
  const dir = join(root, ".chalito"),
    project = join(root, "project"),
    other = join(root, "other");
  for (const p of [dir, project, other]) mkdirSync(p);
  let workspaces = [
    { label: "project", path: project },
    { label: "other", path: other },
  ];
  const workspaceFor = (cwd: string) => workspaces.find((w) => w.path === cwd)?.label ?? null;
  const deps = {
    dir,
    home: root,
    workspaces: () => workspaces,
    workspaceFor,
    launch: { command: "/app/chalito", args: [] as string[] },
    connected: (provider: string, workspace: string) =>
      hub.members().some((p) => p.provider === provider && p.workspace === workspace),
  };
  const connections: TeamConnections = new TeamConnections(deps);
  const hub: TeamHub = new TeamHub(workspaceFor, Date.now, (provider, cwd) => connections.trusted(provider, cwd), {
    rejected: (provider, cwd) => connections.requested(provider, cwd),
  });
  return {
    dir,
    project,
    other,
    connections,
    hub,
    reload: () => new TeamConnections(deps),
    replacePath: () => {
      workspaces = [{ label: "project", path: other }];
    },
  };
};

it("enforces per-AI, per-folder trust, persists it, and revokes active memberships", () => {
  const s = rig(),
    a = new AbortController(),
    b = new AbortController();
  expect(s.hub.call(a.signal, "team_join", { provider: "claude", cwd: s.project })).toMatchObject({
    error: "not_trusted",
  });
  s.connections.set("claude", "project", true);
  expect(s.hub.call(a.signal, "team_join", { provider: "claude", cwd: s.project }).ok).toBe(true);
  expect(s.hub.call(b.signal, "team_join", { provider: "codex", cwd: s.project }).ok).toBe(false);
  expect(s.connections.trusted("claude", s.other)).toBe(false);
  expect(s.reload().trusted("claude", s.project)).toBe(true);
  expect(s.connections.view().workspaces[0]!.connections[0]).toMatchObject({ trusted: true, connected: true });
  expect(statSync(join(s.dir, "team-trust.json")).mode & 0o777).toBe(0o600);
  s.connections.set("claude", "project", false);
  expect(s.hub.members()).toEqual([]);
  expect(s.hub.call(a.signal, "team_send", { text: "after revocation" }).ok).toBe(false);
  expect(s.reload().trusted("claude", s.project)).toBe(false);
  s.connections.set("claude", "project", true);
  s.replacePath();
  expect(s.connections.trusted("claude", s.other)).toBe(false);
  a.abort();
  b.abort();
});

it("requires the desktop OS check to enable trust and permits revocation without it", async () => {
  const s = rig();
  const verify = vi.fn().mockResolvedValue(false),
    audit = vi.fn();
  const handlers = ipcHandlers({
    teamConnections: s.connections,
    osAuth: () => ({ verify }),
    audit,
  } as unknown as IpcDeps);
  const params = { provider: "grok", workspace: "project", workspacePath: s.project, trusted: true };
  await expect(handlers.setTeamTrust!(params)).rejects.toThrow("os_auth_failed");
  expect(s.connections.trusted("grok", s.project)).toBe(false);
  verify.mockResolvedValue(true);
  await handlers.setTeamTrust!(params);
  expect(s.connections.trusted("grok", s.project)).toBe(true);
  await handlers.setTeamTrust!({ ...params, trusted: false });
  expect(verify).toHaveBeenCalledTimes(2);
  expect(s.connections.trusted("grok", s.project)).toBe(false);
  expect(audit).toHaveBeenLastCalledWith("team.trust_changed", {
    provider: "grok",
    workspace: "project",
    trusted: false,
  });
  await expect(handlers.setTeamTrust!({ ...params, provider: "Gmail!" })).rejects.toThrow("bad_params");
  verify.mockImplementation(async () => {
    s.replacePath();
    return true;
  });
  await expect(handlers.setTeamTrust!(params)).rejects.toThrow("workspace_changed");
  expect(s.connections.trusted("grok", s.other)).toBe(false);
});

it("does not grant trust from corrupt saved settings", () => {
  const s = rig();
  s.connections.set("cursor", "project", true);
  expect(readFileSync(join(s.dir, "team-trust.json"), "utf8")).toContain("cursor");
  writeFileSync(join(s.dir, "team-trust.json"), "broken");
  expect(s.reload().trusted("cursor", s.project)).toBe(false);
});

it("expands a ~ workspace path for trust and for the launch arguments MCP clients run without a shell", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "chalito-team-home-")));
  roots.push(home);
  const dir = join(home, ".chalito"),
    project = join(home, "code");
  for (const p of [dir, project]) mkdirSync(p);
  const connections = new TeamConnections({
    dir,
    home,
    workspaces: () => [{ label: "code", path: "~/code" }],
    workspaceFor: (cwd) => (cwd === project ? "code" : null),
    launch: { command: "/app/chalito", args: [] },
    connected: () => false,
  });
  connections.set("codex", "code", true, project);
  expect(connections.trusted("codex", project)).toBe(true);
  const view = connections.view().workspaces[0]!;
  expect(view.path).toBe(project);
  expect(view.connections.find((c) => c.provider === "codex")).toMatchObject({
    trusted: true,
    args: ["team", "mcp", "codex", project],
  });
});

it("lists any app id that tried to join so it can be trusted, and never trusts it by asking", () => {
  const s = rig(),
    a = new AbortController();
  const rows = () => s.connections.view().workspaces.find((w) => w.label === "project")!.connections;
  expect(rows().map((c) => c.provider)).toEqual(["claude", "codex", "grok", "cursor"]);
  expect(s.hub.call(a.signal, "team_join", { provider: "gemini", cwd: s.project })).toMatchObject({
    error: "not_trusted",
  });
  expect(s.hub.call(a.signal, "team_join", { provider: "Gemini CLI", cwd: s.project })).toMatchObject({
    error: "bad_params",
  });
  expect(rows().find((c) => c.provider === "gemini")).toMatchObject({ known: false, trusted: false });
  expect(s.connections.view().workspaces.find((w) => w.label === "other")!.connections).toHaveLength(4);
  expect(rows().find((c) => c.provider === "claude")).toMatchObject({ known: true });
  s.connections.set("gemini", "project", true);
  expect(s.hub.call(a.signal, "team_join", { provider: "gemini", cwd: s.project }).ok).toBe(true);
  // Trust is saved per id and folder; a reload lists the trusted id without a new join attempt.
  expect(
    s
      .reload()
      .view()
      .workspaces.find((w) => w.label === "project")!
      .connections.find((c) => c.provider === "gemini"),
  ).toMatchObject({ trusted: true, args: ["team", "mcp", "gemini", s.project] });
  for (let n = 0; n < 40; n++) s.connections.requested(`spam${n}`, s.project);
  expect(rows().length).toBeLessThanOrEqual(4 + 16);
  a.abort();
});
