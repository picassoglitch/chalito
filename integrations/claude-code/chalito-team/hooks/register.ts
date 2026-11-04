import type { Register } from "claude-code";

// Aldo 2026-11-03 — wakes Claude for teammates without the dev-channels flag: each message from `chalito team watch`
// becomes a plugin-attributed prompt once idle, never folded into a running turn nor sent as the person's words.
type Line = { epoch: string; items: { seq: number; text: string }[] };

const SEEN_MAX = 2000;

export const register: Register = (on) => {
  // Keyed by Chalito epoch: its seqs start over when it restarts.
  const seen = new Set<string>();
  const pending: string[] = [];
  let submitting = false;
  let running = false;
  let flushNow: (() => void) | null = null;

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // Only an interactive session has someone to wake; -p runs and SDK hosts keep team_read. One loop per load.
    if (!e.surface || running) return started;
    const home = await $.env.get("HOME");
    if (!home) return started;
    const candidates = [
      `${home}/.local/share/chalito/chalito-agent`,
      `${home}/.local/bin/chalito`,
      "/usr/local/bin/chalito",
    ];
    let agent: string | null = null;
    for (const c of candidates) if (!agent && (await $.fs.exists(c))) agent = c;
    if (!agent) return started;
    running = true;

    const flush = async (): Promise<void> => {
      if (submitting) return;
      submitting = true;
      try {
        while (pending.length) {
          const result = await $.prompt.submit({ text: pending[0]! });
          // Refused (the person pressed Esc, say): kept, and tried again after their next turn.
          if (result.drop !== undefined) return;
          pending.shift();
        }
      } finally {
        submitting = false;
      }
    };
    flushNow = () => void flush();

    const take = (raw: string) => {
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        return;
      }
      if (typeof line.epoch !== "string" || !Array.isArray(line.items)) return;
      const fresh = line.items.filter(
        (i) => typeof i?.seq === "number" && typeof i.text === "string" && !seen.has(`${line.epoch}:${i.seq}`),
      );
      if (!fresh.length) return;
      for (const i of fresh) seen.add(`${line.epoch}:${i.seq}`);
      while (seen.size > SEEN_MAX) seen.delete(seen.values().next().value!);
      pending.push(fresh.map((i) => i.text).join("\n\n"));
      void flush();
    };

    let wait = 5000;
    const watch = async (): Promise<void> => {
      let buffer = "";
      let code: number | null = null;
      try {
        const child = $.process.spawn({ argv: [agent!, "team", "watch"] });
        for (;;) {
          const step = await child.next();
          if (step.done) {
            code = step.value.code;
            break;
          }
          if (step.value.stream !== "stdout") continue;
          buffer += step.value.text;
          // One batch is well under this; a stream that never ends a line is dropped, not buffered forever.
          if (buffer.length > 2_000_000 && !buffer.includes("\n")) buffer = "";
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            take(buffer.slice(0, at));
            buffer = buffer.slice(at + 1);
            wait = 5000;
          }
        }
      } catch {
        // The agent could not start; retried below with a longer wait.
      }
      // Exit 2: this Chalito has no `team watch` yet; nothing to retry until it is updated and the session restarts.
      if (code === 2) return;
      $.clock.after(wait, () => void watch());
      wait = Math.min(wait * 2, 60_000);
    };

    void watch();
    return started;
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (pending.length && flushNow) flushNow();
    return done;
  });
};
