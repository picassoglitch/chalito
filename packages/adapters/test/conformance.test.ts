import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAdapter } from "../src/acp/index.js";
import { ClaudeCodeAdapter } from "../src/claude-code/index.js";
import { APPROVAL_POLICY, CodexAdapter } from "../src/codex/index.js";
import { fakeClaudeCode, fakeCodex, type FakeCodexStep, type FakeStep } from "../src/testing.js";
import { runConformance, runResumeConformance, type ConformanceStep } from "./conformance.js";

const target = (input: Record<string, unknown>) => String(input.command ?? input.file_path ?? "");

runConformance("claude-code", (turns) => {
  const toClaude = (s: ConformanceStep): FakeStep => {
    if ("say" in s) return s;
    if ("bash" in s) return { tool: "Bash", input: { command: s.bash } };
    if ("edit" in s) return { tool: "Edit", input: { file_path: s.edit, old_string: "a", new_string: "b" } };
    return {
      tool: "AskUserQuestion",
      input: { questions: [{ question: s.ask.question, options: s.ask.options.map((label) => ({ label })) }] },
    };
  };
  const fake = fakeClaudeCode(turns.map((t) => t.map(toClaude)));
  const tools = (list: { tool: string; input: Record<string, unknown> }[]) =>
    list.filter((r) => r.tool !== "AskUserQuestion").map((r) => ({ tool: r.tool, target: target(r.input) }));
  return {
    adapter: new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }),
    ran: () => tools(fake.run.ran),
    // The Claude fake records refusals without their input; they are the attempted steps that didn't run.
    refused: () => {
      const ran = tools(fake.run.ran).map((r) => `${r.tool}:${r.target}`);
      return turns
        .flat()
        .flatMap((s) =>
          "bash" in s ? [{ tool: "Bash", target: s.bash }] : "edit" in s ? [{ tool: "Edit", target: s.edit }] : [],
        )
        .filter((r) => {
          const i = ran.indexOf(`${r.tool}:${r.target}`);
          if (i === -1) return true;
          ran.splice(i, 1);
          return false;
        })
        .slice(0, fake.run.refused.filter((r) => r.tool !== "AskUserQuestion").length);
    },
    answers: () =>
      fake.run.ran
        .filter((r) => r.tool === "AskUserQuestion")
        .flatMap((r) => Object.values(r.input.answers as Record<string, string | string[]>))
        .map((a) => (Array.isArray(a) ? a : [a])),
    interrupts: () => fake.run.interrupted,
    appliedModes: () => fake.run.modes,
    isFullAccess: (m) => m === "bypassPermissions",
    // PreToolUse gates every tool; canUseTool denies anything the hook didn't approve.
    escalatesEveryTool: () =>
      (fake.run.options?.hooks?.PreToolUse?.length ?? 0) > 0 &&
      fake.run.options?.allowDangerouslySkipPermissions === false &&
      typeof fake.run.options?.canUseTool === "function",
    violations: () => [],
  };
});

runConformance("codex", (turns) => {
  const toCodex = (s: ConformanceStep, i: number): FakeCodexStep => {
    if ("say" in s) return s;
    if ("bash" in s) return { command: s.bash };
    if ("edit" in s) return { edit: s.edit };
    return { ask: [{ id: `q${i}`, question: s.ask.question, options: s.ask.options }] };
  };
  const fake = fakeCodex(turns.map((t) => t.map(toCodex)));
  return {
    adapter: new CodexAdapter({ apiKey: "sk-test", spawn: fake.spawn, env: {} }),
    ran: () => fake.run.ran.map((r) => ({ tool: r.tool, target: target(r.input) })),
    refused: () => fake.run.refused.map((r) => ({ tool: r.tool, target: target(r.input) })),
    answers: () => fake.run.answers.flatMap((a) => Object.values(a).map((x) => x.answers)),
    interrupts: () => fake.run.interrupted,
    appliedModes: () => fake.run.sandboxes.map((s) => (typeof s === "string" ? s : (s as { type: string }).type)),
    isFullAccess: (m) => m === "danger-full-access" || m === "dangerFullAccess",
    // "untrusted" prompts for every command and patch (see APPROVAL_POLICY); the fake flags any
    // other policy and a thread/start cwd (project auto-trust) as violations.
    escalatesEveryTool: () =>
      fake.run.policies.length > 0 &&
      fake.run.policies.every((p) => p === APPROVAL_POLICY) &&
      !fake.run.violations.some((v) => v.startsWith("thread/start with cwd")),
    violations: () => fake.run.violations,
  };
});

// ---- M16 A: resume and partial streaming, for all three protocol families ----

runResumeConformance("claude-code", (turns) => {
  const fake = fakeClaudeCode(
    turns.map((t) => t.flatMap((s) => ("say" in s ? [s] : []))),
    { ran: [], refused: [], modes: [], interrupted: 0 },
  );
  return {
    adapter: new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }),
    resumedFrom: () => (fake.run.resumed ?? []).map((r) => r ?? null),
    turns: () => fake.run.turns ?? 0,
  };
});

runResumeConformance("codex", (turns) => {
  const fake = fakeCodex(turns.map((t) => t.flatMap((s) => ("say" in s ? [s] : []))));
  const sent = (method: string) => fake.run.received.filter((m) => m.method === method);
  return {
    adapter: new CodexAdapter({ apiKey: "sk-test", spawn: fake.spawn, env: {} }),
    resumedFrom: () =>
      fake.run.received
        .filter((m) => m.method === "thread/start" || m.method === "thread/resume")
        .map((m) => (m.method === "thread/resume" ? String(m.params?.threadId) : null)),
    turns: () => sent("turn/start").length,
  };
});

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
chmodSync(FAKE_ACP, 0o755);

for (const variant of [
  { name: "acp (session/resume advertised)", script: { resumeSession: true } },
  { name: "acp (session/load only)", script: { loadSession: true } },
]) {
  runResumeConformance(variant.name, (turns) => {
    const ws = mkdtempSync(join(tmpdir(), "chalito-acp-conf-"));
    const home = mkdtempSync(join(tmpdir(), "chalito-acp-conf-home-"));
    writeFileSync(
      join(ws, ".fake-acp.json"),
      JSON.stringify({ ...variant.script, turns: turns.map((t) => t.flatMap((s) => ("say" in s ? [s] : []))) }),
    );
    const received = () =>
      existsSync(join(ws, ".fake-acp.log.jsonl"))
        ? readFileSync(join(ws, ".fake-acp.log.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { in?: { method?: string; params?: Record<string, unknown> } })
            .flatMap((e) => (e.in?.method ? [e.in] : []))
        : [];
    return {
      adapter: new AcpAdapter("grok", {
        binPath: FAKE_ACP,
        home,
        apiKey: "k",
        startTimeoutMs: 10_000,
        env: { PATH: process.env.PATH, HOME: ws },
      }),
      cwd: ws,
      resumedFrom: () =>
        received()
          .filter((m) => ["session/new", "session/load", "session/resume"].includes(m.method!))
          .map((m) => (m.method === "session/new" ? null : String(m.params?.sessionId))),
      turns: () => received().filter((m) => m.method === "session/prompt").length,
    };
  });
}
