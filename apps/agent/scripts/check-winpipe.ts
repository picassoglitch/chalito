// Owner decision 2026-10-22: `chalito code` on Windows, checked on a real Windows runner under Bun
// (the shipped agent's runtime): the pipe is locked to this user, a squatter can't take it, and the CLI talks.
import { PassThrough, type Duplex } from "node:stream";
import { runCode } from "../src/code/cli.js";
import type { LocalEvent, LocalTap } from "../src/code/events.js";
import { startCodeServer } from "../src/code/server.js";
import type { CodeService } from "../src/code/service.js";
import { PIPE_MAX_CONNECTIONS, loadWinPipeSecurity, pipeSddl } from "../src/code/winpipe.js";

const fail = (msg: string): never => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const sec = await loadWinPipeSecurity();
if (!sec) fail("no Windows pipe security under this runtime");
console.warn(`user ${sec!.userSid}`);

let starts = 0;
const taps = new Set<LocalTap>();
const emit = (sid: string, e: LocalEvent) => {
  for (const t of taps) t(sid, e);
};
const code: CodeService = {
  apps: () => ({ apps: ["claude-code"], workspaces: ["w"] }),
  workspaceFor: () => "w",
  start: async (i) => {
    const sid = `s${++starts}`;
    if (i.prompt === "flood") {
      // 6 MB of output for a reader that never reads, in 64 KB pieces.
      let sent = 0;
      const t = setInterval(() => {
        emit(sid, { type: "delta", text: "x".repeat(65536) });
        if ((sent += 65536) > 6 * 1024 * 1024) clearInterval(t);
      }, 5);
      return { ok: true, sid };
    }
    setTimeout(() => {
      emit(sid, { type: "state", state: "running" });
      emit(sid, { type: "assistant", text: "hola desde windows" });
      emit(sid, { type: "state", state: "idle" });
    }, 50);
    return { ok: true, sid };
  },
  prompt: async () => ({ ok: true }),
  stop: async () => ({ ok: true }),
  transfer: async () => ({ ok: false, reason: "invalid" }),
  tap: (fn) => (taps.add(fn), () => void taps.delete(fn)),
} as CodeService;

const path = `\\\\.\\pipe\\chalito-code-ci-${process.pid}`;
let sddl = "";
const server = await startCodeServer({
  path,
  code,
  listen: (p, on) => {
    const l = sec!.listen(p, on);
    sddl = l.sddl;
    return l;
  },
});
console.warn(`sddl ${sddl}`);
// lockDown checked the trustees (with Windows' alias for this user); here: protected, no broad groups.
if (/;;;(WD|AN|BA|BU|AU|IU)\)/.test(sddl) || !/D:P/.test(sddl) || !/^O:/.test(sddl)) fail(`not locked down: ${sddl}`);

// A second server can't take the same name (FILE_FLAG_FIRST_PIPE_INSTANCE, and our DACL).
const squat = await startCodeServer({ path, code, listen: (p, on) => sec!.listen(p, on) }).then(
  (s) => s,
  () => null,
);
if (squat) fail("a second server took the same pipe name");

let out = "";
let err = "";
const input = new PassThrough();
setTimeout(() => input.write("/salir\n"), 1500);
const rc = await runCode(
  {
    input,
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    env: {},
    cwd: process.cwd(),
    openPipe: () => sec!.connect(path),
  },
  path,
  ["claude", "--workspace", "w", "hola"],
  "es",
);
if (rc !== 0) fail(`CLI exited ${rc}: ${err}`);
if (!out.includes("hola desde windows")) fail(`CLI didn't show the session: ${out}`);
await server.close();

// The client side can't be impersonated: a pipe server only gets an identification-level token.
const ffi = (await import("bun:" + "ffi")) as unknown as {
  dlopen(
    l: string,
    s: Record<string, { args: string[]; returns: string }>,
  ): { symbols: Record<string, (...a: unknown[]) => unknown> };
  ptr(v: ArrayBufferView): number;
};
const k = ffi.dlopen("kernel32.dll", {
  CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "u64" },
  LocalFree: { args: ["u64"], returns: "u64" },
  ConnectNamedPipe: { args: ["u64", "u64"], returns: "i32" },
  ReadFile: { args: ["u64", "ptr", "u32", "ptr", "u64"], returns: "i32" },
  WriteFile: { args: ["u64", "ptr", "u32", "ptr", "u64"], returns: "i32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "u64", "u32", "u32", "u64"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetCurrentThread: { args: [], returns: "u64" },
  DisconnectNamedPipe: { args: ["u64"], returns: "i32" },
}).symbols;
const a = ffi.dlopen("advapi32.dll", {
  ImpersonateNamedPipeClient: { args: ["u64"], returns: "i32" },
  RevertToSelf: { args: [], returns: "i32" },
  OpenThreadToken: { args: ["u64", "u32", "i32", "ptr"], returns: "i32" },
  GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "u64"], returns: "i32" },
}).symbols;
/** SECURITY_ATTRIBUTES (x64: length, pad, SD pointer, inherit, pad) for a test pipe with `sddl`. */
const attrs = (sddl: string | null): Uint8Array | null => {
  if (!sddl) return null;
  const sd = new BigUint64Array(1);
  if (!a.ConvertStringSecurityDescriptorToSecurityDescriptorW!(ffi.ptr(w(sddl)), 1, ffi.ptr(sd), 0n)) fail("test SD");
  const sa = new Uint8Array(24);
  const v = new DataView(sa.buffer);
  v.setUint32(0, 24, true);
  v.setBigUint64(8, sd[0]!, true);
  return sa;
};
const w = (x: string) => new Uint8Array(Buffer.from(`${x}\0`, "utf16le"));
/** Level a pipe server gets for a client: 1 = identification, 2 = impersonation. */
const testPipe = (sddl: string | null) => {
  const name = `\\\\.\\pipe\\chalito-sqos-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const sa = attrs(sddl);
  const srv = k.CreateNamedPipeW!(ffi.ptr(w(name)), 3, 0, 1, 4096, 4096, 0, sa ? ffi.ptr(sa) : null) as bigint;
  return { name, srv };
};
const LOCKED = pipeSddl(sec!.userSid);
const levelFor = async (connectClient: (name: string) => unknown): Promise<number> => {
  const { name, srv } = testPipe(LOCKED);
  const client = connectClient(name);
  k.ConnectNamedPipe!(srv, 0n);
  const buf = new Uint8Array(1);
  const n = new Uint32Array(1);
  if (!k.ReadFile!(srv, ffi.ptr(buf), 1, ffi.ptr(n), 0n)) fail("server read failed");
  if (!a.ImpersonateNamedPipeClient!(srv)) fail("impersonate call failed");
  const tok = new BigUint64Array(1);
  const ok = a.OpenThreadToken!(k.GetCurrentThread!(), 0x8, 1, ffi.ptr(tok));
  const lvl = new Uint32Array(1);
  const len = new Uint32Array(1);
  if (ok) a.GetTokenInformation!(tok[0]!, 9, ffi.ptr(lvl), 4, ffi.ptr(len));
  a.RevertToSelf!();
  if (ok) k.CloseHandle!(tok[0]!);
  (client as { destroy?: () => void }).destroy?.();
  k.DisconnectNamedPipe!(srv);
  k.CloseHandle!(srv);
  return lvl[0]!;
};
const ours = await levelFor((name) => {
  const c = sec!.connect(name);
  if (!c.ok) fail(`connect to own test pipe failed: ${c.reason}`);
  const s = (c as { ok: true; stream: Duplex }).stream;
  s.write("x");
  return s;
});
const plain = await levelFor((name) => {
  const h = k.CreateFileW!(ffi.ptr(w(name)), 0xc0000000, 0, 0n, 3, 0, 0n) as bigint;
  const n = new Uint32Array(1);
  k.WriteFile!(h, ffi.ptr(new Uint8Array([120])), 1, ffi.ptr(n), 0n);
  return { destroy: () => k.CloseHandle!(h) };
});
console.warn(`impersonation level: ours ${ours}, plain client ${plain}`);
if (ours !== 1) fail(`our client allows impersonation level ${ours}`);
if (plain !== 2) fail(`control: a plain client should allow impersonation (got ${plain})`);

// A pipe this user's own process serves but with the default DACL (not locked) is refused: the
// owner and DACL on the handle count, not the server's PID report alone.
const loose = testPipe(null);
const refused = sec!.connect(loose.name);
if (refused.ok || refused.reason !== "not_mine") fail("a pipe with the default DACL was accepted");
k.CloseHandle!(loose.srv);
// The same DACL but another owner (the Administrators group this runner's user belongs to) is refused
// too, though its server PID is ours: the owner must be this user.
const otherOwner = testPipe(`O:BA${pipeSddl(sec!.userSid).slice(pipeSddl(sec!.userSid).indexOf("D:"))}`);
if (otherOwner.srv === 0xffffffffffffffffn) fail("test pipe with owner BA couldn't be created");
const refused2 = sec!.connect(otherOwner.name);
if (refused2.ok || refused2.reason !== "not_mine")
  fail(`a pipe owned by someone else was accepted (${JSON.stringify(refused2.ok ? "ok" : refused2.reason)})`);
k.CloseHandle!(otherOwner.srv);
console.warn("refused: default-DACL pipe and foreign-owner pipe");

// Remote clients: through SMB loopback (\\127.0.0.1\pipe\…) a client is a network logon.
const remoteOpen = (local: string) => {
  const remote = local.replace("\\\\.\\", "\\\\127.0.0.1\\");
  const h = k.CreateFileW!(ffi.ptr(w(remote)), 0xc0000000, 0, 0n, 3, 0x00110000, 0n) as bigint;
  const opened = h !== 0xffffffffffffffffn;
  if (opened) k.CloseHandle!(h);
  return opened;
};
const control = testPipe(`D:P(A;;GA;;;${sec!.userSid})(A;;GA;;;SY)`);
const controlOpened = remoteOpen(control.name);
k.CloseHandle!(control.srv);
const server2 = await startCodeServer({ path: `${path}-remote`, code, listen: (p, on) => sec!.listen(p, on) });
const oursOpened = remoteOpen(`${path}-remote`);
await server2.close();
console.warn(`remote open: control ${controlOpened}, ours ${oursOpened}`);
if (oursOpened) fail("a remote (SMB) client opened the pipe");
if (!controlOpened) console.warn("note: SMB loopback unavailable here; the remote refusal is unproven by a control");
// ---- the accept loop and writes (review 2026-10-22) ------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = (stream: Duplex, req: Record<string, unknown>, ms = 3000) =>
  new Promise<string>((resolve, reject) => {
    let got = "";
    const on = (c: Buffer) => {
      got += c.toString();
      if (!got.includes(`"id":${String(req.id)}`)) return;
      stream.off("data", on);
      resolve(got);
    };
    stream.on("data", on);
    stream.write(`${JSON.stringify(req)}\n`);
    setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
const cliOnce = async (p: string) => {
  let o = "";
  const inp = new PassThrough();
  setTimeout(() => inp.write("/salir\n"), 1500);
  const code = await runCode(
    {
      input: inp,
      out: (x) => void (o += x),
      err: () => undefined,
      env: {},
      cwd: process.cwd(),
      openPipe: () => sec!.connect(p),
    },
    p,
    ["claude", "--workspace", "w", "hola"],
    "es",
  );
  if (code !== 0 || !o.includes("hola desde windows")) fail(`CLI failed on ${p}: ${o}`);
};
/** A raw client, retrying while the one listening instance is busy (as a real client waits). */
const rawOpen = async (p: string): Promise<bigint> => {
  for (let i = 0; i < 40; i++) {
    const h = k.CreateFileW!(ffi.ptr(w(p)), 0xc0000000, 0, 0n, 3, 0x00110000, 0n) as bigint;
    if (h !== 0xffffffffffffffffn) return h;
    await sleep(50);
  }
  return 0xffffffffffffffffn;
};

// A client that comes 600 ms after the agent started, and clients that connect and close at once.
const p3 = `${path}-accept`;
const server3 = await startCodeServer({ path: p3, code, listen: (p, on) => sec!.listen(p, on) });
await sleep(600);
for (let i = 0; i < 5; i++) {
  const h = await rawOpen(p3);
  if (h === 0xffffffffffffffffn) fail("quick client couldn't open");
  k.CloseHandle!(h);
}
await sleep(200);
await cliOnce(p3);
console.warn("accept: late client and quick connect-close handled, CLI still works");

// A client that stops reading never freezes the agent: another client is answered meanwhile, and the
// stuck one is dropped once its backlog passes the limit.
const stuck = await rawOpen(p3);
if (stuck === 0xffffffffffffffffn) fail("stuck client couldn't open");
const n = new Uint32Array(1);
const req = new Uint8Array(
  Buffer.from(
    `${JSON.stringify({ id: 1, method: "start", params: { appId: "claude-code", workspaceLabel: "w", prompt: "flood" } })}\n`,
  ),
);
k.WriteFile!(stuck, ffi.ptr(req), req.length, ffi.ptr(n), 0n);
await sleep(300);
const other = sec!.connect(p3);
if (!other.ok) fail("second client couldn't connect");
const t0 = Date.now();
await rpc((other as { ok: true; stream: Duplex }).stream, { id: 7, method: "apps" }).catch((e: Error) =>
  fail(`agent froze behind a stuck reader: ${e.message}`),
);
console.warn(`answered another client in ${Date.now() - t0} ms while one was stuck`);
const k2 = ffi.dlopen("kernel32.dll", {
  PeekNamedPipe: { args: ["u64", "u64", "u32", "u64", "ptr", "u64"], returns: "i32" },
}).symbols;
let dropped = false;
const drain = new Uint8Array(65536);
for (let i = 0; i < 200 && !dropped; i++) {
  await sleep(50);
  // Data the stuck client never read still sits in its buffer after the server closed its end:
  // read it now; once it's empty, a broken pipe means the server dropped the connection.
  const avail = new Uint32Array(1);
  if (!(k2.PeekNamedPipe!(stuck, 0n, 0, 0n, ffi.ptr(avail), 0n) as number)) dropped = true;
  else if (avail[0]! > 0) k.ReadFile!(stuck, ffi.ptr(drain), Math.min(avail[0]!, drain.length), ffi.ptr(n), 0n);
}
k.CloseHandle!(stuck);
(other as { ok: true; stream: Duplex }).stream.destroy();
if (!dropped) fail("the stuck reader was never dropped");
await server3.close();
console.warn("stuck reader dropped");

// At most PIPE_MAX_CONNECTIONS at once: one more is dropped cleanly; after one leaves, a new one is served.
const p5 = `${path}-cap`;
const server5 = await startCodeServer({ path: p5, code, listen: (p, on) => sec!.listen(p, on) });
const held: Duplex[] = [];
for (let i = 0; i < PIPE_MAX_CONNECTIONS; i++) {
  const c = sec!.connect(p5);
  if (!c.ok) fail(`connection ${i + 1} refused`);
  const st = (c as { ok: true; stream: Duplex }).stream;
  await rpc(st, { id: 100 + i, method: "apps" });
  held.push(st);
}
const extra = sec!.connect(p5);
const extraServed =
  extra.ok &&
  (await rpc((extra as { ok: true; stream: Duplex }).stream, { id: 200, method: "apps" }, 1500).then(
    () => true,
    () => false,
  ));
if (extraServed) fail(`a connection past ${PIPE_MAX_CONNECTIONS} was served`);
if (extra.ok) (extra as { ok: true; stream: Duplex }).stream.destroy();
held.shift()!.destroy();
await sleep(200);
const again = sec!.connect(p5);
if (!again.ok) fail("no connection after one left");
await rpc((again as { ok: true; stream: Duplex }).stream, { id: 201, method: "apps" });
for (const st of [...held, (again as { ok: true; stream: Duplex }).stream]) st.destroy();
await server5.close();
console.warn(`connections capped at ${PIPE_MAX_CONNECTIONS}`);

// When the next instance can't be made, the loop says so and stops; the open connection keeps working.
const p4 = `${path}-max`;
const errors: string[] = [];
const server4 = await startCodeServer({
  path: p4,
  code,
  listen: (p, on) => sec!.listen(p, on, (m) => void errors.push(m), 1),
});
const only = sec!.connect(p4);
if (!only.ok) fail("first client of a one-instance pipe couldn't connect");
await sleep(300);
if (!errors.some((e) => e.startsWith("stopped accepting"))) fail(`no log when the loop stopped: ${errors.join(";")}`);
await rpc((only as { ok: true; stream: Duplex }).stream, { id: 9, method: "apps" });
(only as { ok: true; stream: Duplex }).stream.destroy();
await server4.close();
console.warn("accept loop stops cleanly and says so; the open connection kept working");

console.warn("OK: pipe locked to this user and SYSTEM, no second server, CLI end to end");
process.exit(0);
