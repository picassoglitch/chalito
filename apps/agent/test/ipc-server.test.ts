import { mkdtempSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { IpcError, ipcPath, readIpcSecret, startIpcServer } from "../src/ipc-server.js";

const SECRET = "a".repeat(64);

/** One request, one answer line (what the desktop's Rust client does). */
export const ipcCall = (path: string, msg: unknown): Promise<Record<string, unknown> | null> =>
  new Promise((resolve, reject) => {
    const sock = connect(path);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(typeof msg === "string" ? msg : `${JSON.stringify(msg)}\n`));
    sock.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        sock.end();
      }
    });
    sock.on("close", () => resolve(null));
    sock.on("error", reject);
  });

const server = async (handlers = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "chalito-ipc-"));
  const path = join(dir, "agent.sock");
  const errors: string[] = [];
  const s = await startIpcServer({ path, secret: SECRET, handlers, onError: (m) => void errors.push(m) });
  return { s, path, errors };
};

describe("agent IPC server (local socket, per-launch secret)", () => {
  it("answers the methods it has, with the secret; the socket is 0600", async () => {
    const { s, path } = await server({ ping: async () => ({ version: "1" }), nothing: async () => undefined });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await ipcCall(path, { id: 1, token: SECRET, method: "ping" })).toEqual({
      id: 1,
      ok: true,
      result: { version: "1" },
    });
    expect(await ipcCall(path, { id: 2, token: SECRET, method: "nothing" })).toEqual({ id: 2, ok: true, result: null });
    await s.close();
  });

  it("refuses a wrong or missing secret, unknown methods and prototype names", async () => {
    const { s, path } = await server({ ping: async () => ({}) });
    expect(await ipcCall(path, { id: 1, token: "b".repeat(64), method: "ping" })).toEqual({
      id: 1,
      ok: false,
      error: "unauthorized",
    });
    expect(await ipcCall(path, { id: 2, method: "ping" })).toMatchObject({ ok: false, error: "unauthorized" });
    expect(await ipcCall(path, { id: 3, token: SECRET, method: "nope" })).toMatchObject({ error: "unknown_method" });
    expect(await ipcCall(path, { id: 4, token: SECRET, method: "constructor" })).toMatchObject({
      error: "unknown_method",
    });
    expect(await ipcCall(path, { id: 5, token: SECRET, method: "__proto__" })).toMatchObject({
      error: "unknown_method",
    });
    await s.close();
  });

  it("errors are codes: an IpcError's code, anything else 'internal' (no message leaks)", async () => {
    const { s, path, errors } = await server({
      refuse: async () => {
        throw new IpcError("no_pending_pairing");
      },
      crash: async () => {
        throw new Error("/home/ana/.chalito/secret path");
      },
    });
    expect(await ipcCall(path, { id: 1, token: SECRET, method: "refuse" })).toEqual({
      id: 1,
      ok: false,
      error: "no_pending_pairing",
    });
    const r = await ipcCall(path, { id: 2, token: SECRET, method: "crash" });
    expect(r).toEqual({ id: 2, ok: false, error: "internal" });
    expect(errors).toEqual(["refuse", "crash"]);
    await s.close();
  });

  it("garbage or an oversized line closes the connection", async () => {
    const { s, path } = await server({ ping: async () => ({}) });
    expect(await ipcCall(path, "not json\n")).toBeNull();
    expect(await ipcCall(path, "x".repeat(70 * 1024))).toBeNull();
    await s.close();
  });

  it("refuses to start with a weak secret; close() removes the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-ipc-"));
    await expect(startIpcServer({ path: join(dir, "s"), secret: "short", handlers: {} })).rejects.toThrow(/hex/);
    const { s, path } = await server();
    await s.close();
    expect(() => statSync(path)).toThrow();
  });

  it("paths: ~/.chalito/agent.sock, or a per-user named pipe on Windows", () => {
    expect(ipcPath("/home/ana/.chalito", "linux")).toBe("/home/ana/.chalito/agent.sock");
    expect(ipcPath("C:\\x", "win32", "Ana María")).toBe("\\\\.\\pipe\\chalito-agent-Ana_Mar_a");
  });

  it("the secret is the first stdin line; nothing, junk or a timeout means no IPC", async () => {
    const feed = (s: string | null) => {
      const p = new PassThrough();
      if (s !== null) p.write(s);
      return p;
    };
    expect(await readIpcSecret(feed(`${SECRET}\nmore`))).toBe(SECRET);
    expect(await readIpcSecret(feed("not-a-secret\n"))).toBeNull();
    expect(await readIpcSecret(feed(null), 20)).toBeNull();
    const ended = feed(SECRET);
    ended.end();
    expect(await readIpcSecret(ended)).toBe(SECRET);
  });
});
