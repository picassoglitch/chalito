import { Duplex } from "node:stream";

// Owner decision 2026-10-22 (ADR 0031 §6a): `chalito code` on Windows, over a named pipe only this
// user (and SYSTEM) can open, local clients only, its server checked by the CLI. Win32 via bun:ffi.

export type PipeConnect = { ok: true; stream: Duplex } | { ok: false; reason: "not_mine" | "unavailable" };

/** What the agent and the CLI need from Windows to use code.sock's pipe safely. */
export interface WinPipeSecurity {
  /** This process's user SID (S-1-5-21-…). */
  readonly userSid: string;
  /** Serves `pipePath` (locked at creation, local clients of this user only); throws if it can't. */
  listen(
    pipePath: string,
    onStream: (stream: Duplex) => void,
    onError?: (msg: string) => void,
    /** Tests only: cap the instances (the default is unlimited). */
    maxInstances?: number,
  ): { close(): void; sddl: string };
  /** The CLI's one connection: identification-only, the pipe's owner, DACL and server checked on it. */
  connect(pipePath: string): PipeConnect;
}

/** The pipe's security: owned by this user; no network logon; full access for this user and SYSTEM only. */
export const pipeSddl = (userSid: string): string => `O:${userSid}D:P(D;;GA;;;NU)(A;;GA;;;${userSid})(A;;GA;;;SY)`;

/** A protected DACL that denies network logons and allows nobody but `userSid` (or its alias) and SYSTEM. */
export const onlyUserAndSystem = (sddl: string, userSid: string, alias?: string): boolean => {
  const dacl = /D:([^(]*)((?:\([^)]*\))*)/.exec(sddl);
  if (!dacl || !dacl[1]!.includes("P")) return false;
  const aces = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.split(";"));
  const deniesNetwork = aces.some((a) => a[0] === "D" && (a[5] === "NU" || a[5] === "S-1-5-2"));
  const allows = aces.filter((a) => a[0] !== "D");
  return (
    deniesNetwork &&
    allows.length > 0 &&
    allows.every((a) => a[0] === "A" && [userSid, alias, "SY", "S-1-5-18"].includes(a[5]))
  );
};

/** Owned by this user, and its DACL is `onlyUserAndSystem`. */
export const pipeLockedTo = (sddl: string, userSid: string, alias?: string): boolean => {
  const owner = /O:(.*?)(?=[GDS]:|$)/.exec(sddl)?.[1];
  return owner !== undefined && (owner === userSid || owner === alias) && onlyUserAndSystem(sddl, userSid, alias);
};

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const READ_CONTROL = 0x00020000;
const OPEN_EXISTING = 3;
/** SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: a pipe server may identify this client, never act as it. */
export const SQOS_IDENTIFICATION = 0x00110000;
const PIPE_ACCESS_DUPLEX = 0x3;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
const PIPE_NOWAIT = 0x1;
const PIPE_REJECT_REMOTE_CLIENTS = 0x8;
const PIPE_UNLIMITED_INSTANCES = 255;
/** Connections served at once (each is polled); more are refused. */
export const PIPE_MAX_CONNECTIONS = 8;
const SE_KERNEL_OBJECT = 6;
const OWNER_SECURITY_INFORMATION = 0x1;
const DACL_SECURITY_INFORMATION = 0x4;
const SDDL_REVISION_1 = 1;
const TOKEN_QUERY = 0x8;
const TOKEN_USER = 1;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const ERROR_PIPE_BUSY = 231;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_PIPE_LISTENING = 536;
const INVALID = 0xffffffffffffffffn;

type Ptr = number;
interface BunFfi {
  dlopen(
    lib: string,
    syms: Record<string, { args: string[]; returns: string }>,
  ): { symbols: Record<string, (...a: unknown[]) => unknown> };
  ptr(view: ArrayBufferView): Ptr;
  read: { u16(p: Ptr, offset: number): number };
}

const wstr = (s: string) => new Uint8Array(Buffer.from(`${s}\0`, "utf16le"));

/** bun:ffi under the shipped (Bun) agent on Windows; null anywhere else (then code.sock isn't served there). */
export const loadWinPipeSecurity = async (
  platform: NodeJS.Platform = process.platform,
): Promise<WinPipeSecurity | null> => {
  if (platform !== "win32" || !(process.versions as Record<string, string | undefined>).bun) return null;
  let ffi: BunFfi;
  try {
    ffi = (await import("bun:" + "ffi")) as unknown as BunFfi;
  } catch {
    return null;
  }
  const { dlopen, ptr, read } = ffi;
  const k32 = dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "u64", "u32", "u32", "u64"], returns: "u64" },
    CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "u64" },
    ConnectNamedPipe: { args: ["u64", "u64"], returns: "i32" },
    DisconnectNamedPipe: { args: ["u64"], returns: "i32" },
    SetNamedPipeHandleState: { args: ["u64", "ptr", "u64", "u64"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetNamedPipeServerProcessId: { args: ["u64", "ptr"], returns: "i32" },
    GetNamedPipeClientProcessId: { args: ["u64", "ptr"], returns: "i32" },
    GetNamedPipeClientComputerNameW: { args: ["u64", "ptr", "u32"], returns: "i32" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetCurrentProcess: { args: [], returns: "u64" },
    LocalFree: { args: ["u64"], returns: "u64" },
    GetLastError: { args: [], returns: "u32" },
    WaitNamedPipeW: { args: ["ptr", "u32"], returns: "i32" },
    PeekNamedPipe: { args: ["u64", "u64", "u32", "u64", "ptr", "u64"], returns: "i32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "u64"], returns: "i32" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "u64"], returns: "i32" },
  }).symbols;
  const adv = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSidToStringSidW: { args: ["u64", "ptr"], returns: "i32" },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "u64"], returns: "i32" },
    GetSecurityInfo: { args: ["u64", "u32", "u32", "u64", "u64", "u64", "u64", "ptr"], returns: "u32" },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ["u64", "u32", "u32", "ptr", "u64"],
      returns: "i32",
    },
  }).symbols;
  const call = <T>(fn: ((...a: unknown[]) => unknown) | undefined, ...a: unknown[]) => fn!(...a) as T;
  const lastError = () => call<number>(k32.GetLastError);

  /** A UTF-16 string the OS allocated, read and then freed. */
  const takeWide = (p: bigint): string => {
    const at = Number(p);
    let n = 0;
    while (read.u16(at, n * 2) !== 0) n++;
    const chars: number[] = [];
    for (let i = 0; i < n; i++) chars.push(read.u16(at, i * 2));
    call(k32.LocalFree, p);
    return String.fromCharCode(...chars);
  };

  const tokenSid = (proc: bigint): string | null => {
    const tok = new BigUint64Array(1);
    if (!call<number>(adv.OpenProcessToken, proc, TOKEN_QUERY, ptr(tok))) return null;
    try {
      const buf = new Uint8Array(256);
      const len = new Uint32Array(1);
      if (!call<number>(adv.GetTokenInformation, tok[0]!, TOKEN_USER, ptr(buf), buf.length, ptr(len))) return null;
      // TOKEN_USER starts with SID_AND_ATTRIBUTES: the SID pointer (into buf) comes first.
      const sidPtr = new BigUint64Array(buf.buffer, 0, 1)[0]!;
      const out = new BigUint64Array(1);
      if (!call<number>(adv.ConvertSidToStringSidW, sidPtr, ptr(out))) return null;
      return takeWide(out[0]!);
    } finally {
      call(k32.CloseHandle, tok[0]!);
    }
  };

  const pidSid = (pid: number): string | null => {
    const proc = call<bigint>(k32.OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (proc === 0n) return null;
    try {
      return tokenSid(proc);
    } finally {
      call(k32.CloseHandle, proc);
    }
  };

  const userSid = tokenSid(call<bigint>(k32.GetCurrentProcess));
  if (!userSid) return null;

  const toSddl = (sd: bigint, info: number): string | null => {
    const out = new BigUint64Array(1);
    const ok = call<number>(
      adv.ConvertSecurityDescriptorToStringSecurityDescriptorW,
      sd,
      SDDL_REVISION_1,
      info,
      ptr(out),
      0n,
    );
    return ok ? takeWide(out[0]!) : null;
  };

  // How Windows writes this user back in an SDDL: its SID, or an alias for a well-known one ("LA").
  const alias = (() => {
    const sd = new BigUint64Array(1);
    const src = ptr(wstr(`D:(A;;GA;;;${userSid})`));
    if (!call<number>(adv.ConvertStringSecurityDescriptorToSecurityDescriptorW, src, SDDL_REVISION_1, ptr(sd), 0n))
      return undefined;
    const back = toSddl(sd[0]!, DACL_SECURITY_INFORMATION);
    call(k32.LocalFree, sd[0]!);
    return back ? /\(A;;[A-Z]+;;;([^)]+)\)/.exec(back)?.[1] : undefined;
  })();

  /** The pipe object's owner and DACL as SDDL, read on `h` (a client's with READ_CONTROL, or the server's). */
  const sddlOf = (h: bigint): string | null => {
    const sd = new BigUint64Array(1);
    const info = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    if (call<number>(adv.GetSecurityInfo, h, SE_KERNEL_OBJECT, info, 0n, 0n, 0n, 0n, ptr(sd)) !== 0) return null;
    const out = toSddl(sd[0]!, info);
    call(k32.LocalFree, sd[0]!);
    return out;
  };

  // A pipe handle in PIPE_NOWAIT mode as a stream: reads follow a peek, and a write takes what the
  // pipe has room for now and finishes on a later tick, so a client that stops reading blocks nothing.
  const pipeStream = (h: bigint, onClose?: () => void): Duplex => {
    let closed = false;
    const avail = new Uint32Array(1);
    const done = new Uint32Array(1);
    call(k32.SetNamedPipeHandleState, h, ptr(new Uint32Array([PIPE_NOWAIT])), 0n, 0n);
    /** The write in progress: what's left of it and its callback (Node queues the next ones). */
    let inFlight: { rest: Uint8Array; cb: (err?: Error | null) => void } | null = null;
    const flush = () => {
      while (inFlight && !closed) {
        const part = inFlight.rest;
        if (!call<number>(k32.WriteFile, h, ptr(part), part.length, ptr(done), 0n)) {
          const cb = inFlight.cb;
          inFlight = null;
          return cb(new Error("pipe_write_failed"));
        }
        if (done[0] === 0) return; // full: try again on the next tick
        inFlight.rest = part.subarray(done[0]!);
        if (inFlight.rest.length === 0) {
          const cb = inFlight.cb;
          inFlight = null;
          cb();
        }
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      onClose?.();
      call(k32.CloseHandle, h);
    };
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        if (closed) return cb(new Error("pipe_closed"));
        inFlight = { rest: new Uint8Array(chunk), cb };
        flush();
      },
      final(cb) {
        close();
        cb();
      },
      destroy(err, cb) {
        close();
        cb(err);
      },
    });
    const timer = setInterval(() => {
      if (closed) return;
      flush();
      if (!call<number>(k32.PeekNamedPipe, h, 0n, 0, 0n, ptr(avail), 0n)) {
        stream.push(null);
        stream.destroy();
        return;
      }
      if (avail[0] === 0) return;
      const buf = new Uint8Array(Math.min(avail[0]!, 65536));
      if (!call<number>(k32.ReadFile, h, ptr(buf), buf.length, ptr(done), 0n)) {
        stream.push(null);
        stream.destroy();
        return;
      }
      stream.push(Buffer.from(buf.subarray(0, done[0]!)));
    }, 15);
    return stream;
  };

  /** Opens the pipe as a client: identification-only, so a server can never act as this user. */
  const open = (pipePath: string, access: number): bigint => {
    const name = wstr(pipePath);
    for (let i = 0; i < 20; i++) {
      const h = call<bigint>(k32.CreateFileW, ptr(name), access, 0, 0n, OPEN_EXISTING, SQOS_IDENTIFICATION, 0n);
      if (h !== INVALID) return h;
      if (lastError() !== ERROR_PIPE_BUSY) break;
      call(k32.WaitNamedPipeW, ptr(name), 500);
    }
    throw new Error("pipe_open_failed");
  };

  /** A connected client is local (no computer name) and its process runs as this user. */
  const clientIsMine = (h: bigint): boolean => {
    const host = new Uint8Array(512);
    if (call<number>(k32.GetNamedPipeClientComputerNameW, h, ptr(host), host.length)) return false;
    const pid = new Uint32Array(1);
    return !!call<number>(k32.GetNamedPipeClientProcessId, h, ptr(pid)) && pidSid(pid[0]!) === userSid;
  };

  return {
    userSid,
    listen(pipePath, onStream, onError, maxInstances = PIPE_UNLIMITED_INSTANCES) {
      const sd = new BigUint64Array(1);
      const src = ptr(wstr(pipeSddl(userSid)));
      if (!call<number>(adv.ConvertStringSecurityDescriptorToSecurityDescriptorW, src, SDDL_REVISION_1, ptr(sd), 0n))
        throw new Error("pipe_sddl_failed");
      // SECURITY_ATTRIBUTES (x64): length, padding, the descriptor, inherit = false.
      const sa = new Uint8Array(24);
      const view = new DataView(sa.buffer);
      view.setUint32(0, sa.length, true);
      view.setBigUint64(8, sd[0]!, true);
      const name = wstr(pipePath);
      const instance = (first: boolean): bigint => {
        const h = call<bigint>(
          k32.CreateNamedPipeW,
          ptr(name),
          PIPE_ACCESS_DUPLEX | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
          PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
          maxInstances,
          65536,
          65536,
          0,
          ptr(sa),
        );
        if (h === INVALID) throw new Error(`pipe_create_failed_${lastError()}`);
        return h;
      };
      let pending: bigint;
      try {
        // FILE_FLAG_FIRST_PIPE_INSTANCE: if anyone already made this name, nothing is served.
        pending = instance(true);
      } catch (err) {
        call(k32.LocalFree, sd[0]!);
        throw err;
      }
      const sddl = sddlOf(pending);
      if (!sddl || !pipeLockedTo(sddl, userSid, alias)) {
        call(k32.CloseHandle, pending);
        call(k32.LocalFree, sd[0]!);
        throw new Error(`pipe_not_locked: ${sddl}`);
      }
      const live = new Set<Duplex>();
      let stopped = false;
      const accept = setInterval(() => {
        if (stopped) return;
        // PIPE_NOWAIT: ConnectNamedPipe never blocks; it says whether a client is there.
        // In PIPE_NOWAIT mode a nonzero return means "listening"; only ERROR_PIPE_CONNECTED is a client.
        if (call<number>(k32.ConnectNamedPipe, pending, 0n) !== 0) return;
        const e = lastError();
        if (e === ERROR_PIPE_LISTENING) return;
        // At most PIPE_MAX_CONNECTIONS polled at once: one more is dropped, so nobody can pile them up.
        if (e !== ERROR_PIPE_CONNECTED || live.size >= PIPE_MAX_CONNECTIONS || !clientIsMine(pending)) {
          // Gone already, or not a local process of this user: drop it and keep listening.
          call(k32.DisconnectNamedPipe, pending);
          return;
        }
        const h = pending;
        // Handed to its stream from here: never closed again by this loop.
        pending = 0n;
        try {
          pending = instance(false);
        } catch (err) {
          stopped = true;
          onError?.(`stopped accepting: ${err instanceof Error ? err.message : "error"}`);
        }
        const stream = pipeStream(h, () => live.delete(stream));
        live.add(stream);
        onStream(stream);
      }, 50);
      return {
        sddl,
        close() {
          stopped = true;
          clearInterval(accept);
          for (const s of live) s.destroy();
          if (pending !== 0n) call(k32.CloseHandle, pending);
          call(k32.LocalFree, sd[0]!);
        },
      };
    },
    connect(pipePath) {
      let h: bigint;
      try {
        h = open(pipePath, GENERIC_READ | GENERIC_WRITE | READ_CONTROL);
      } catch {
        return { ok: false, reason: "unavailable" };
      }
      // The server picks its own PID report; the pipe object's owner and DACL it can't fake to us.
      const sddl = sddlOf(h);
      const pid = new Uint32Array(1);
      const serverOk = !!call<number>(k32.GetNamedPipeServerProcessId, h, ptr(pid)) && pidSid(pid[0]!) === userSid;
      if (!sddl || !pipeLockedTo(sddl, userSid, alias) || !serverOk) {
        call(k32.CloseHandle, h);
        return { ok: false, reason: "not_mine" };
      }
      return { ok: true, stream: pipeStream(h) };
    },
  };
};
