import { ClaudeCodeAdapter, fakeClaudeCode, type FakeStep } from "../src/claude-code/index.js";
import { APPROVAL_POLICY, CodexAdapter, fakeCodex, type FakeCodexStep } from "../src/codex/index.js";
import { runConformance, type ConformanceStep } from "./conformance.js";

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
