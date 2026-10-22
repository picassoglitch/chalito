import { connect as netConnect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { LocalEvent } from "./events.js";

// ADR 0031 §1: `chalito code <agent> [--workspace <label>] [--mode …] [prompt…]`, a Claude Code-like
// prompt at the computer for a session that is also live on the phone.

export const AGENT_ALIASES: Readonly<Record<string, string>> = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini",
  grok: "grok",
};

const T = {
  es: {
    usage:
      "Uso: chalito code <claude|codex|gemini|grok|app> [--workspace <nombre>] [--mode default|plan|acceptEdits] [instrucción]\n",
    inSession: "chalito code no se puede usar dentro de una sesión de Chalito.\n",
    notRunning: "Chalito no está corriendo en esta computadora. Ábrelo (o `chalito run`) y vuelve a intentar.\n",
    windows: "En Windows, empieza la sesión desde el panel de Chalito (Sesiones → Nueva sesión).\n",
    unknownApp: (a: string, apps: string[]) =>
      `La IA «${a}» no está lista aquí. Listas: ${apps.length ? apps.join(", ") : "ninguna (conéctala en Chalito)"}.\n`,
    noWorkspace: (ws: string[]) =>
      `Esta carpeta no está en tus carpetas de Chalito. Usa --workspace con una de: ${ws.join(", ") || "(ninguna)"}.\n`,
    ask: "> ",
    started: (sid: string, app: string, ws: string) =>
      `Sesión ${sid.slice(0, 8)} · ${app} · ${ws}. También está en tu teléfono. Ctrl-C detiene · /salir sale.\n`,
    refused: (r: string) => `Chalito no la aceptó (${r}).\n`,
    phone: "teléfono",
    here: "panel de esta computadora",
    agent: "otro agente",
    needApproval: (risk: string, s: string) =>
      `Aprobación ${risk}: ${s}\n  Apruébala en el panel de Chalito o en tu teléfono.\n`,
    approved: "  aprobado\n",
    denied: (r: string) => `  rechazado (${r})\n`,
    stopped: "\n[detenido]\n",
    failed: "\n[la sesión falló]\n",
    error: (c: string) => `\n[error: ${c}]\n`,
    left: "La sesión sigue en tu teléfono.\n",
    answerElsewhere: "\nLa IA te hizo una pregunta. Contéstala en el panel o en tu teléfono.\n",
    disconnected: "\nSe perdió la conexión con Chalito en esta computadora. La sesión sigue en tu teléfono.\n",
  },
  en: {
    usage:
      "Usage: chalito code <claude|codex|gemini|grok|app> [--workspace <name>] [--mode default|plan|acceptEdits] [prompt]\n",
    inSession: "chalito code can't be used inside a Chalito session.\n",
    notRunning: "Chalito isn't running on this computer. Open it (or `chalito run`) and try again.\n",
    windows: "On Windows, start the session from the Chalito panel (Sessions → New session).\n",
    unknownApp: (a: string, apps: string[]) =>
      `“${a}” isn't ready here. Ready: ${apps.length ? apps.join(", ") : "none (connect one in Chalito)"}.\n`,
    noWorkspace: (ws: string[]) =>
      `This folder isn't one of your Chalito folders. Use --workspace with one of: ${ws.join(", ") || "(none)"}.\n`,
    ask: "> ",
    started: (sid: string, app: string, ws: string) =>
      `Session ${sid.slice(0, 8)} · ${app} · ${ws}. It's on your phone too. Ctrl-C stops · /exit leaves.\n`,
    refused: (r: string) => `Chalito refused it (${r}).\n`,
    phone: "phone",
    here: "this computer's panel",
    agent: "another agent",
    needApproval: (risk: string, s: string) =>
      `${risk} approval: ${s}\n  Approve it in the Chalito panel or on your phone.\n`,
    approved: "  approved\n",
    denied: (r: string) => `  denied (${r})\n`,
    stopped: "\n[stopped]\n",
    failed: "\n[the session failed]\n",
    error: (c: string) => `\n[error: ${c}]\n`,
    left: "The session stays on your phone.\n",
    answerElsewhere: "\nThe AI asked you a question. Answer it in the panel or on your phone.\n",
    disconnected: "\nLost the connection to Chalito on this computer. The session stays on your phone.\n",
  },
} as const;

export interface CodeCliIo {
  input: NodeJS.ReadableStream;
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Ctrl-C; returns the unsubscribe. */
  onSigint?: (fn: () => void) => () => void;
  connect?: (path: string) => Socket;
}

interface Rpc {
  call(method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  close(): void;
}

const openRpc = (sock: Socket, onPush: (e: LocalEvent & { sid: string }) => void, onClose: () => void): Rpc => {
  let n = 0;
  const waits = new Map<number, (r: { ok: boolean; result?: unknown; error?: string }) => void>();
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: LocalEvent & { sid: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (msg.event) onPush(msg.event);
      else if (typeof msg.id === "number") {
        waits.get(msg.id)?.({ ok: msg.ok === true, result: msg.result, ...(msg.error ? { error: msg.error } : {}) });
        waits.delete(msg.id);
      }
    }
  });
  sock.on("close", () => {
    for (const w of waits.values()) w({ ok: false, error: "closed" });
    waits.clear();
    onClose();
  });
  return {
    call: (method, params) =>
      new Promise((resolve) => {
        const id = ++n;
        waits.set(id, resolve);
        sock.write(`${JSON.stringify({ id, method, params })}\n`);
      }),
    close: () => sock.end(),
  };
};

const connectTo = (io: CodeCliIo, path: string): Promise<Socket | null> =>
  new Promise((resolve) => {
    const sock = (io.connect ?? netConnect)(path);
    sock.once("connect", () => resolve(sock));
    sock.once("error", () => resolve(null));
  });

const parseArgs = (args: string[]) => {
  const flags: { workspace?: string; mode?: string } = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--workspace" || a === "--mode") {
      const v = args[++i];
      if (v === undefined) return null;
      flags[a === "--workspace" ? "workspace" : "mode"] = v;
    } else if (a.startsWith("--workspace=")) flags.workspace = a.slice(12);
    else if (a.startsWith("--mode=")) flags.mode = a.slice(7);
    else rest.push(a);
  }
  if (flags.mode !== undefined && !["default", "plan", "acceptEdits"].includes(flags.mode)) return null;
  return { agent: rest[0], prompt: rest.slice(1).join(" ").trim(), flags };
};

// Model text reaches a real terminal: drop ESC/CSI sequences and C0/C1 controls, keep \n and \t.
/* eslint-disable no-control-regex -- matching control characters is the point */
const CONTROL =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])|\u009b[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/* eslint-enable no-control-regex */
export const clean = (s: string): string => s.replace(CONTROL, "");

const IDLE = new Set(["idle", "completed", "failed", "interrupted"]);
// Nothing more happens here until someone acts (a question is answered in the panel or on the phone).
const SETTLED = new Set([...IDLE, "waiting_input"]);

export const runCode = async (
  io: CodeCliIo,
  path: string | null,
  args: string[],
  locale: "es" | "en",
): Promise<number> => {
  const t = T[locale];
  if (io.env.CHALITO_SESSION !== undefined) return (io.err(t.inSession), 1);
  if (path === null) return (io.err(t.windows), 1);
  const a = parseArgs(args);
  if (!a?.agent) return (io.err(t.usage), 1);
  const appId = AGENT_ALIASES[a.agent] ?? a.agent;

  const lines = createInterface({ input: io.input, terminal: false });
  const queue: string[] = [];
  let lineWait: ((l: string | null) => void) | null = null;
  let eof = false;
  lines.on("line", (l) => (lineWait ? (lineWait(l), (lineWait = null)) : queue.push(l)));
  lines.on("close", () => {
    eof = true;
    lineWait?.(null);
    lineWait = null;
  });
  const nextLine = () =>
    queue.length
      ? Promise.resolve(queue.shift()!)
      : eof
        ? Promise.resolve(null)
        : new Promise<string | null>((r) => (lineWait = r));

  const sock = await connectTo(io, path);
  if (!sock) return (lines.close(), io.err(t.notRunning), 1);

  let sid: string | null = null;
  let state = "starting";
  let streamed = false;
  let ownLocal = 0;
  let idleWaits: (() => void)[] = [];
  const finished = () => {
    for (const w of idleWaits) w();
    idleWaits = [];
  };
  const nextIdle = () => new Promise<void>((r) => idleWaits.push(r));
  let closed = false;

  const render = (e: LocalEvent & { sid: string }) => {
    if (e.sid !== sid && sid !== null) return;
    switch (e.type) {
      case "user":
        // This terminal's own prompts are `local:cli`; the panel's are `local`.
        if (e.origin === "local:cli" && ownLocal > 0) ownLocal--;
        else
          io.out(
            `\n[${e.origin === "local" ? t.here : e.origin.startsWith("client:") ? t.phone : t.agent}] ${clean(e.text)}\n`,
          );
        return;
      case "delta":
        streamed = true;
        return io.out(clean(e.text));
      case "assistant":
        io.out(streamed ? "\n" : `${clean(e.text)}\n`);
        streamed = false;
        return;
      case "tool":
        return io.out(`  · ${clean(e.category)} ${clean(e.summary)}\n`);
      case "tool_done":
        return e.ok ? undefined : io.out("  ✗\n");
      case "approval":
        return io.out(t.needApproval(clean(e.risk), clean(e.summary)));
      case "approval_done":
        return io.out(e.allow ? t.approved : t.denied(clean(e.reason)));
      case "state":
        state = e.state;
        if (e.state === "interrupted") io.out(t.stopped);
        if (e.state === "failed") io.out(t.failed);
        if (e.state === "waiting_input") io.out(t.answerElsewhere);
        if (SETTLED.has(e.state)) {
          finished();
          if (!eof) io.out(t.ask);
        }
        return;
      case "error":
        return io.out(t.error(clean(e.code)));
    }
  };
  const rpc = openRpc(sock, render, () => {
    closed = true;
    finished();
    // Wake the prompt loop so it leaves now, not at the next line typed.
    lineWait?.(null);
    lineWait = null;
  });

  const apps = (await rpc.call("apps")).result as { apps: string[]; workspaces: string[] } | undefined;
  if (!apps) return (lines.close(), rpc.close(), io.err(t.notRunning), 1);
  if (!apps.apps.includes(appId)) return (lines.close(), rpc.close(), io.err(t.unknownApp(appId, apps.apps)), 1);
  const ws =
    a.flags.workspace ??
    ((await rpc.call("workspaceFor", { cwd: io.cwd })).result as { label: string | null } | undefined)?.label ??
    null;
  if (!ws || !apps.workspaces.includes(ws))
    return (lines.close(), rpc.close(), io.err(t.noWorkspace(apps.workspaces)), 1);

  let first = a.prompt;
  while (!first) {
    io.out(t.ask);
    const l = await nextLine();
    if (l === null) return (lines.close(), rpc.close(), 0);
    first = l.trim();
  }
  ownLocal++;
  const started = await rpc.call("start", {
    appId,
    workspaceLabel: ws,
    prompt: first,
    ...(a.flags.mode ? { permissionMode: a.flags.mode } : {}),
  });
  if (!started.ok) return (lines.close(), rpc.close(), io.err(t.refused(started.error ?? "internal")), 1);
  sid = (started.result as { sid: string }).sid;
  io.out(t.started(sid, clean(appId), clean(ws)));

  let lastSigint = 0;
  let leave = false;
  const unsig = io.onSigint?.(() => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      leave = true;
      lineWait?.(null);
      lineWait = null;
      return;
    }
    lastSigint = now;
    void rpc.call("stop", { sid });
  });

  try {
    for (;;) {
      const l = await nextLine();
      if (leave || closed) break;
      if (l === null) {
        // Piped input ran out: wait for the turn to end, then leave.
        if (!SETTLED.has(state) && !closed) await nextIdle();
        break;
      }
      const text = l.trim();
      if (!text) continue;
      if (text === "/salir" || text === "/exit") break;
      if (text === "/stop") {
        await rpc.call("stop", { sid });
        continue;
      }
      ownLocal++;
      state = "running";
      const r = await rpc.call("prompt", { sid, text });
      if (!r.ok) {
        ownLocal = Math.max(0, ownLocal - 1);
        state = "idle";
        io.err(t.refused(r.error ?? "internal"));
      }
    }
  } finally {
    unsig?.();
    lines.close();
    rpc.close();
  }
  if (closed && !leave) return (io.err(t.disconnected), 1);
  io.out(t.left);
  return 0;
};
