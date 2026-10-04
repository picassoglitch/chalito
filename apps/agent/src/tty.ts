import { createInterface, type Interface } from "node:readline";

/** Terminal I/O for the CLI. Streams are injected so tests can script the answers. */
export interface TtyIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * Reads answers one line at a time. Lines that arrive before they're asked for are
 * queued, not dropped (readline's own question() loses them when input is piped).
 */
export class LineReader {
  readonly #rl: Interface;
  readonly #lines: string[] = [];
  readonly #waiters: ((l: string | null) => void)[] = [];
  #closed = false;

  constructor(private readonly io: TtyIo) {
    this.#rl = createInterface({ input: io.input, terminal: false });
    this.#rl.on("line", (l) => {
      const w = this.#waiters.shift();
      if (w) w(l);
      else this.#lines.push(l);
    });
    this.#rl.on("close", () => {
      this.#closed = true;
      for (const w of this.#waiters.splice(0)) w(null);
    });
  }

  /** Prints `prompt` and resolves with the next line (null at end of input). */
  ask(prompt: string): Promise<string | null> {
    this.io.output.write(prompt);
    const l = this.#lines.shift();
    if (l !== undefined) return Promise.resolve(l);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  close(): void {
    this.#rl.close();
  }
}

const YES = /^(s|si|sí|y|yes)$/i;
export const isYes = (answer: string | null): boolean => YES.test((answer ?? "").trim());

/**
 * Reads a secret without echoing it. On a TTY it switches to raw mode; piped input
 * (`echo $KEY | chalito keys set …`) is read as one line.
 */
export const readHidden = (io: TtyIo, prompt: string): Promise<string | null> => {
  io.output.write(prompt);
  const { input } = io;
  if (!input.isTTY || !input.setRawMode) {
    const reader = new LineReader({ input, output: io.output });
    return reader.ask("").finally(() => reader.close());
  }
  return new Promise((resolve) => {
    let value = "";
    input.setRawMode!(true);
    input.resume();
    const done = (v: string | null) => {
      input.removeListener("data", onData);
      input.setRawMode!(false);
      input.pause();
      io.output.write("\n");
      resolve(v);
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(value);
        if (ch === "\u0003") return done(null);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
};
