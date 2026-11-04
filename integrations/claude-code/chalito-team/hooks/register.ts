import type { Register } from "claude-code";

// Aldo 2026-11-03 — wakes Claude for teammates without the dev-channels flag: each batch from `chalito team watch`
// becomes a plugin-attributed prompt once idle, never folded into a running turn nor sent as the person's words.
type Batch = { seqs: number[]; text: string };

export const register: Register = (on) => {
  const seen = new Set<number>();
  const pending: Batch[] = [];
  let submitting = false;
  let retry: (() => void) | null = null;

  on("session.start", async ($, e, next) => {
    const started = await next(e);
    // Only an interactive session has someone to wake; -p runs and SDK hosts keep team_read.
    if (!e.surface) return started;
    const home = await $.env.get("HOME");
    if (!home) return started;
    const agent = `${home}/.local/share/chalito/chalito-agent`;
    if (!(await $.fs.exists(agent))) return started;

    const flush = async (): Promise<void> => {
      if (submitting) return;
      submitting = true;
      try {
        while (pending.length) {
          const result = await $.prompt.submit({ text: pending[0]!.text });
          // Refused (the person pressed Esc, say): kept, and tried again after their next turn.
          if (result.drop !== undefined) return;
          pending.shift();
        }
      } finally {
        submitting = false;
      }
    };
    retry = () => void flush();

    const take = (line: string) => {
      let batch: Batch;
      try {
        batch = JSON.parse(line) as Batch;
      } catch {
        return;
      }
      if (!Array.isArray(batch.seqs) || typeof batch.text !== "string") return;
      const fresh = batch.seqs.filter((s) => !seen.has(s));
      if (!fresh.length) return;
      for (const s of fresh) seen.add(s);
      pending.push(batch);
      void flush();
    };

    const watch = async (): Promise<void> => {
      let buffer = "";
      try {
        for await (const { stream, text } of $.process.spawn({ argv: [agent, "team", "watch"] })) {
          if (stream !== "stdout") continue;
          buffer += text;
          // One batch is well under this; a stream that never ends a line is dropped, not buffered forever.
          if (buffer.length > 2_000_000 && !buffer.includes("\n")) buffer = "";
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            take(buffer.slice(0, at));
            buffer = buffer.slice(at + 1);
          }
        }
      } catch {
        // The agent could not start; tried again below.
      }
      // Chalito restarted, or this session's team server is not up yet: reconnect shortly.
      $.clock.after(5000, () => void watch());
    };

    void watch();
    return started;
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (pending.length && retry) retry();
    return done;
  });
};
