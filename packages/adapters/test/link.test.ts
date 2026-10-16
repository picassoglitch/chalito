import { describe, expect, it } from "vitest";
import { LinkStreamResponse, LinkTask, LinkUpdate } from "@chalito/protocol";
import type { AdapterEvent } from "../src/core.js";
import { HARDENING_OVERRIDES, API_KEY_OVERRIDES, CodexAdapter } from "../src/codex/index.js";
import { LinkProjector } from "../src/link.js";
import { waitFor } from "./conformance.js";
import { loadTranscript, replay } from "./replay.js";

// The recorded (SYNTHETIC, see codex.test.ts) Codex app-server transcript, driven through the
// real Codex adapter; its AdapterEvents are projected live onto LinkTask updates.
const transcript = loadTranscript(new URL("./fixtures/codex-transcript.synthetic.jsonl", import.meta.url));

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const projector = () => {
  let n = 0;
  let t = T0;
  return new LinkProjector({ contextId: "s1", newId: () => `id-${++n}`, now: () => (t += 1000) });
};

const states = (out: LinkStreamResponse[]) =>
  out.flatMap((u) => ("statusUpdate" in u ? [u.statusUpdate.status.state] : "task" in u ? [u.task.status.state] : []));

describe("LinkProjector: Codex transcript", () => {
  it("one context per session, one task per prompt, A2A-valid updates", async () => {
    const r = replay(transcript);
    const p = projector();
    const out: LinkStreamResponse[] = [];
    const tasks: LinkTask[] = [];
    out.push(...p.prompt("Arregla el test que falla"));
    const h = await new CodexAdapter({
      apiKey: "sk-test-fixture",
      clientVersion: "0.1.0",
      spawn: r.spawn,
      env: {},
    }).start({
      sid: "s1",
      cwd: "/ws",
      prompt: "Arregla el test que falla",
      origin: "client:phone1",
      permissionMode: "default",
      gate: async (c, signal) => {
        if (c.input.command === "git push")
          return new Promise((res) => signal.addEventListener("abort", () => res({ allow: true })));
        return c.input.file_path !== "/ws/.env" ? { allow: true } : { allow: false, reason: "policy_block" };
      },
      askUser: async (q) => ({ [q.questions[0]!.question]: q.questions[0]!.options[0]!.label }),
      onEvent: (e: AdapterEvent) => out.push(...p.push(e)),
    });
    await waitFor(() => p.task?.status.state === "TASK_STATE_COMPLETED");
    tasks.push(p.task!);
    await h.setPermissionMode("plan");
    out.push(...p.prompt("Sube los cambios"));
    h.prompt("Sube los cambios", "mcp:chatgpt");
    await waitFor(() => JSON.stringify(out).includes('"toolUseId":"item_8"'));
    await h.interrupt();
    await waitFor(() => r.finished());
    h.close();
    await h.done;
    tasks.push(p.task!);

    expect(r.state.mismatches).toEqual([]);
    expect(r.state.spawned?.args).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      ...HARDENING_OVERRIDES.flatMap((o) => ["-c", o]),
      ...API_KEY_OVERRIDES.flatMap((o) => ["-c", o]),
    ]);

    // Every update is a valid A2A StreamResponse and fits Chalito's v1 container.
    for (const u of out) {
      expect(LinkStreamResponse.safeParse(u).success).toBe(true);
      expect(LinkUpdate.safeParse({ v: 1, update: u }).success).toBe(true);
    }
    const taskIdOf = (u: LinkStreamResponse) =>
      "task" in u
        ? u.task.id
        : "statusUpdate" in u
          ? u.statusUpdate.taskId
          : "artifactUpdate" in u
            ? u.artifactUpdate.taskId
            : u.message.taskId;
    // One context, two tasks.
    expect(new Set(tasks.map((t) => t.contextId))).toEqual(new Set(["s1"]));
    expect(tasks[0]!.id).toBe("id-1");
    expect(tasks[1]!.id).not.toBe("id-1");
    expect(new Set(out.map(taskIdOf))).toEqual(new Set(["id-1", tasks[1]!.id]));

    const first = out.filter((u) => taskIdOf(u) === "id-1");
    expect(states(first)).toEqual([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_WORKING",
      "TASK_STATE_WORKING",
      "TASK_STATE_WORKING",
      "TASK_STATE_WORKING",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
    ]);
    expect(tasks[0]).toEqual({
      id: "id-1",
      contextId: "s1",
      status: { state: "TASK_STATE_COMPLETED", timestamp: expect.any(String) },
      history: [
        {
          messageId: "id-2",
          contextId: "s1",
          taskId: "id-1",
          role: "ROLE_USER",
          parts: [{ text: "Arregla el test que falla" }],
        },
      ],
      artifacts: [
        {
          artifactId: "id-1:reply",
          name: "reply",
          parts: [{ text: "Voy a correr los tests." }, { text: "Usaré Postgres." }],
        },
      ],
      metadata: { usage: { tokIn: 1000, tokOut: 150, tokCacheRead: 1600, tokCacheWrite: 0 } },
    });
    const done = out.find((u) => "statusUpdate" in u && u.statusUpdate.status.state === "TASK_STATE_COMPLETED");
    expect(done).toMatchObject({ statusUpdate: { metadata: { usage: { tokIn: 1000, tokOut: 150 } } } });

    // Reply chunks: first creates the artifact, later ones append.
    const chunks = out.flatMap((u) => ("artifactUpdate" in u ? [u.artifactUpdate] : []));
    expect(chunks.map((c) => [c.artifact.parts[0]!.text, c.append])).toEqual([
      ["Voy a correr los tests.", undefined],
      ["Usaré Postgres.", true],
    ]);

    // Tool messages name the tool and never carry its input (no commands or paths cross a link).
    const toolParts = out.flatMap((u) => ("statusUpdate" in u ? (u.statusUpdate.status.message?.parts ?? []) : []));
    expect(toolParts.map((p) => p.data)).toContainEqual({
      tool: { toolUseId: "item_3", toolName: "Bash", status: "started" },
    });
    expect(toolParts.map((p) => p.data)).toContainEqual({ tool: { toolUseId: "item_4", status: "failed" } });
    expect(JSON.stringify(out)).not.toContain("pnpm test");
    expect(JSON.stringify(out)).not.toContain("/ws");

    // Second prompt: interrupted → CANCELED; the later tool_finished/completed change nothing.
    expect(tasks[1]!.status.state).toBe("TASK_STATE_CANCELED");
    expect(tasks[1]!.history![0]!.parts).toEqual([{ text: "Sube los cambios" }]);
    expect(out.at(-1)).toMatchObject({
      statusUpdate: { taskId: tasks[1]!.id, status: { state: "TASK_STATE_CANCELED" } },
    });
  });
});

describe("LinkProjector: mapping", () => {
  it("nothing before a prompt or after a terminal state", () => {
    const p = projector();
    expect(p.push({ type: "state", state: "running" })).toEqual([]);
    p.prompt("hola");
    expect(states(p.push({ type: "state", state: "idle" }))).toEqual(["TASK_STATE_COMPLETED"]);
    expect(p.push({ type: "assistant_text", text: "tarde" })).toEqual([]);
    expect(p.push({ type: "state", state: "running" })).toEqual([]);
  });

  it("repeated states send nothing; approval waits stay WORKING", () => {
    const p = projector();
    p.prompt("hola");
    expect(states(p.push({ type: "state", state: "running" }))).toEqual(["TASK_STATE_WORKING"]);
    expect(p.push({ type: "state", state: "running" })).toEqual([]);
    expect(p.push({ type: "state", state: "waiting_approval" })).toEqual([]);
    expect(p.push({ type: "state", state: "starting" })).toEqual([]);
    expect(p.push({ type: "started", providerSessionId: "x" })).toEqual([]);
  });

  it("errors: auth_required interrupts, anything else fails; failed state fails", () => {
    const auth = projector();
    auth.prompt("hola");
    const a = auth.push({ type: "error", code: "auth_required", message: "secret detail" });
    expect(states(a)).toEqual(["TASK_STATE_AUTH_REQUIRED"]);
    expect(JSON.stringify(a)).not.toContain("secret detail");
    // Interrupted, not terminal: work can resume.
    expect(states(auth.push({ type: "state", state: "running" }))).toEqual(["TASK_STATE_WORKING"]);

    for (const code of ["adapter_crash", "rate_limited", "quota_exhausted", "internal"] as const) {
      const p = projector();
      p.prompt("hola");
      const out = p.push({ type: "error", code });
      expect(states(out)).toEqual(["TASK_STATE_FAILED"]);
      expect(out[0]).toMatchObject({
        statusUpdate: { status: { message: { role: "ROLE_AGENT", parts: [{ data: { error: { code } } }] } } },
      });
    }
    const f = projector();
    f.prompt("hola");
    expect(states(f.push({ type: "state", state: "failed" }))).toEqual(["TASK_STATE_FAILED"]);
  });

  it("a new prompt opens a new task in the same context and resets usage", () => {
    const p = projector();
    p.prompt("uno");
    p.push({ type: "usage", tokIn: 5, tokOut: 1, tokCacheRead: 0, tokCacheWrite: 0 });
    p.push({ type: "state", state: "idle" });
    const [u] = p.prompt("dos");
    expect(u).toMatchObject({ task: { contextId: "s1", status: { state: "TASK_STATE_SUBMITTED" } } });
    expect(p.task!.metadata).toBeUndefined();
    expect(LinkTask.safeParse(p.task).success).toBe(true);
  });
});
