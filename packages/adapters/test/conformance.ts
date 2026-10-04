import { describe, expect, it } from "vitest";
import type { Origin, RemotePermissionMode } from "@chalito/protocol";
import type { AdapterEvent, SessionAdapter, ToolCall } from "../src/core.js";

/**
 * The SessionAdapter conformance suite. Every adapter runs it against its own fake, through a
 * harness that translates these adapter-neutral steps into the fake's script.
 */
export type ConformanceStep =
  { say: string } | { bash: string } | { edit: string } | { ask: { question: string; options: string[] } };

export interface ConformanceHarness {
  adapter: SessionAdapter;
  /** Tool names that actually ran, and what each ran ("Bash" → command, "Edit" → path). */
  ran(): { tool: string; target: string }[];
  refused(): { tool: string; target: string }[];
  /** Labels the agent received back for each question it asked. */
  answers(): string[][];
  interrupts(): number;
  /** Every permission level the provider was asked to apply, in its own vocabulary. */
  appliedModes(): string[];
  /** True if any applied mode is the provider's full, unsandboxed access. */
  isFullAccess(mode: string): boolean;
  /** The provider was configured so that every tool call reaches the gate (nothing auto-runs). */
  escalatesEveryTool(): boolean;
  /** Protocol violations the fake noticed. */
  violations(): string[];
}

export const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

type Gate = (c: ToolCall, signal: AbortSignal) => Promise<boolean>;

export const runConformance = (name: string, makeHarness: (turns: ConformanceStep[][]) => ConformanceHarness) => {
  const setup = (turns: ConformanceStep[][], gate: Gate = async () => true) => {
    const h = makeHarness(turns);
    const calls: ToolCall[] = [];
    const events: AdapterEvent[] = [];
    const asked: string[] = [];
    const start = (permissionMode: RemotePermissionMode = "default", origin: Origin = "client:phone1") =>
      h.adapter.start({
        sid: "s1",
        cwd: "/ws",
        prompt: "hola",
        origin,
        permissionMode,
        gate: async (c, signal) => {
          calls.push(c);
          return (await gate(c, signal)) ? { allow: true } : { allow: false, reason: "policy_block" };
        },
        askUser: async (q) => {
          asked.push(...q.questions.map((x) => x.question));
          return Object.fromEntries(q.questions.map((x) => [x.question, x.options[0]?.label ?? ""]));
        },
        onEvent: (e) => events.push(e),
      });
    const idleCount = () => events.filter((e) => e.type === "state" && e.state === "idle").length;
    return { h, calls, events, asked, start, idleCount };
  };

  describe(`SessionAdapter conformance: ${name}`, () => {
    it("routes every tool call through the gate; denied tools never run", async () => {
      const { h, calls, start, idleCount } = setup(
        [[{ bash: "ls" }, { bash: "sudo rm -rf /" }, { edit: "/ws/a.ts" }, { say: "listo" }]],
        async (c) => !String(c.input.command ?? "").includes("rm -rf"),
      );
      const s = await start();
      await waitFor(() => idleCount() === 1);
      expect(calls.map((c) => c.toolName)).toEqual(["Bash", "Bash", "Edit"]);
      expect(calls.every((c) => c.sid === "s1")).toBe(true);
      expect(calls[2]!.input.file_path).toBe("/ws/a.ts");
      expect(h.ran()).toEqual([
        { tool: "Bash", target: "ls" },
        { tool: "Edit", target: "/ws/a.ts" },
      ]);
      expect(h.refused()).toEqual([{ tool: "Bash", target: "sudo rm -rf /" }]);
      expect(h.escalatesEveryTool()).toBe(true);
      s.close();
      await s.done;
    });

    it("surfaces agent questions to the human and returns the answers", async () => {
      const { h, asked, start, idleCount } = setup([
        [{ ask: { question: "¿Qué base?", options: ["Postgres", "SQLite"] } }, { say: "ok" }],
      ]);
      const s = await start();
      await waitFor(() => idleCount() === 1);
      expect(asked).toEqual(["¿Qué base?"]);
      expect(h.answers()).toEqual([["Postgres"]]);
      s.close();
      await s.done;
    });

    it("tags each tool call with the origin of its own turn", async () => {
      const { calls, start, idleCount } = setup([[{ bash: "ls" }], [{ bash: "pwd" }]]);
      const s = await start("default", "client:phone1");
      await waitFor(() => idleCount() === 1);
      s.prompt("sigue", "mcp:chatgpt");
      await waitFor(() => idleCount() === 2);
      expect(calls.map((c) => c.origin)).toEqual(["client:phone1", "mcp:chatgpt"]);
      s.close();
      await s.done;
    });

    it("interrupt aborts the pending gate, the tool never runs, and the state says interrupted", async () => {
      const { h, start, calls, events } = setup(
        [[{ bash: "sleep 100" }]],
        (_c, signal) => new Promise<boolean>((resolve) => signal.addEventListener("abort", () => resolve(false))),
      );
      const s = await start();
      await waitFor(() => calls.length === 1);
      await s.interrupt();
      expect(h.interrupts()).toBe(1);
      expect(events).toContainEqual({ type: "state", state: "interrupted" });
      s.close();
      await s.done;
      expect(h.ran()).toEqual([]);
    });

    it("no permission mode ever yields full, unsandboxed access", async () => {
      const turns: ConformanceStep[][] = [[{ say: "a" }], [{ say: "b" }], [{ say: "c" }], [{ say: "d" }]];
      const { h, start, idleCount } = setup(turns);
      const s = await start("plan");
      await waitFor(() => idleCount() === 1);
      for (const [i, mode] of (["default", "acceptEdits", "plan"] as const).entries()) {
        await s.setPermissionMode(mode);
        s.prompt(`turn ${i}`, "client:phone1");
        await waitFor(() => idleCount() === i + 2);
      }
      s.close();
      await s.done;
      expect(h.appliedModes().length).toBeGreaterThan(1);
      expect(h.appliedModes().filter((m) => h.isFullAccess(m))).toEqual([]);
    });

    it("emits started, text, tool, usage events and ends with state completed on close", async () => {
      const { h, events, start, idleCount } = setup([[{ say: "uno" }, { bash: "ls" }]]);
      const s = await start();
      await waitFor(() => idleCount() === 1);
      s.close();
      await s.done;
      const types = events.map((e) => e.type);
      for (const t of ["started", "assistant_text", "tool_started", "tool_finished", "usage"])
        expect(types).toContain(t);
      expect(events).toContainEqual({ type: "assistant_text", text: "uno" });
      expect(events.at(-1)).toEqual({ type: "state", state: "completed" });
      expect(h.violations()).toEqual([]);
    });
  });
};
