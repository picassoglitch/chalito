import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BoardPort, BoardStatus } from "./protocol.js";

const LINE = "board://line";
const STATUS = "board://status";

/** Tauri's listen is async; this hands back a sync unsubscribe that also covers a pending one. */
const subscribe = <T>(event: string, cb: (payload: T) => void): (() => void) => {
  let off: UnlistenFn | null = null;
  let gone = false;
  void listen<T>(event, (e) => cb(e.payload)).then((f) => (gone ? f() : (off = f)));
  return () => {
    gone = true;
    off?.();
  };
};

/** The serial link in src-tauri/src/board.rs (every window hears the board; writes are serialized there). */
export const tauriBoardPort: BoardPort = {
  status: () => invoke<BoardStatus>("board_status"),
  write: (line) => invoke("board_write", { line }),
  onLine: (cb) => subscribe<string>(LINE, cb),
  onStatus: (cb) => subscribe<BoardStatus>(STATUS, cb),
};
