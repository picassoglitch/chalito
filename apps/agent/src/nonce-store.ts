import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NonceStore } from "@chalito/crypto";
import type { Logger } from "./redact.js";

/**
 * ~/.chalito/nonces.json: command and decision nonces the agent has accepted, kept until
 * the message they came with expires. Persisted so a restart inside that window still
 * rejects a replay. Entries are pruned at expiry; writes are atomic and 0600. Only the
 * daemon claims nonces, so there is a single writer.
 */
export class FileNonceStore implements NonceStore {
  readonly #seen: Map<string, number>;

  constructor(
    readonly dir: string,
    private readonly log?: Logger,
  ) {
    this.#seen = this.#read();
  }

  get file(): string {
    return join(this.dir, "nonces.json");
  }

  async claim(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    let pruned = false;
    for (const [n, exp] of this.#seen)
      if (exp <= now) {
        this.#seen.delete(n);
        pruned = true;
      }
    if (expiresAt <= now || this.#seen.has(nonce)) {
      if (pruned) this.#write();
      return false;
    }
    this.#seen.set(nonce, expiresAt);
    // Persist before reporting success: a crash after this point can't forget the nonce.
    this.#write();
    return true;
  }

  get size(): number {
    return this.#seen.size;
  }

  #read(): Map<string, number> {
    if (!existsSync(this.file)) return new Map();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return new Map(
        Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])),
      );
    } catch {
      // Commands also carry short expiries and are verified against the local trusted list,
      // so an unreadable file costs at most the replay window; say so loudly.
      this.log?.error("nonces.unreadable", { file: this.file, action: "starting empty" });
      return new Map();
    }
  }

  #write(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#seen)), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
