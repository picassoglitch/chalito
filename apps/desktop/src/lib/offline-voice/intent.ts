// Re-implemented from Alux by Omar (homiomar), pet/intent.js: rules, not a model. Free, instant,
// offline, and the card always asks, so a wrong guess costs one click.

export type VoiceCommand =
  | { kind: "approve" }
  | { kind: "deny" }
  /** `target`: the words naming the session, or null for "the one that needs me". */
  | { kind: "open"; target: string | null }
  /** An empty prompt opens the new-session form. */
  | { kind: "newSession"; prompt: string }
  | { kind: "pause"; minutes: number }
  | { kind: "dnd"; on: boolean };

export interface ParsedVoice {
  /** What was heard, without whisper's [BLANK_AUDIO] / (music) markers. */
  text: string;
  /** In the order they were said, one per kind. */
  commands: VoiceCommand[];
}

/** Lower case, no accents, punctuation as spaces; `at[i]` is folded char i's index in the original. */
const fold = (s: string): { folded: string; at: number[] } => {
  let folded = "";
  const at: number[] = [];
  [...s].reduce((i, ch) => {
    const f = ch
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, " ");
    for (const c of f) {
      folded += c;
      at.push(i);
    }
    return i + ch.length;
  }, 0);
  return { folded, at };
};

const words = (list: string, from: number) => Object.fromEntries(list.split(" ").map((w, i) => [w, from + i] as const));
/** "un/una/a/an" count only before a unit ("una hora"), never alone ("un rato"). */
const ARTICLE: Record<string, number> = { un: 1, una: 1, a: 1, an: 1 };
const UNITS: Record<string, number> = {
  ...words("uno dos tres cuatro cinco seis siete ocho nueve", 1),
  ...words("one two three four five six seven eight nine", 1),
};
const TEENS: Record<string, number> = {
  ...words("diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve", 10),
  ...words("ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen", 10),
};
const TENS: Record<string, number> = {
  veinte: 20,
  twenty: 20,
  treinta: 30,
  thirty: 30,
  cuarenta: 40,
  forty: 40,
  cincuenta: 50,
  fifty: 50,
  sesenta: 60,
  sixty: 60,
  setenta: 70,
  seventy: 70,
  ochenta: 80,
  eighty: 80,
  noventa: 90,
  ninety: 90,
};
const HOUR_WORDS = new Set(["hora", "horas", "hour", "hours", "h", "hr", "hrs"]);
const MINUTE_WORDS = new Set(["min", "mins", "minuto", "minutos", "minute", "minutes", "m"]);
const UNIT_WORDS = new Set([...HOUR_WORDS, ...MINUTE_WORDS]);
const LEAD = new Set(["por", "durante", "unos", "unas", "for", "about", "like", "around", "some", "like"]);

/** A spoken number at w[i]: "45", "cuarenta y cinco", "veinticinco", "twenty five", "1h". */
const readNumber = (w: string[], i: number): { n: number; next: number; unit?: "h" | "m"; article?: true } | null => {
  const x = w[i] ?? "";
  const glued = /^(\d{1,3})(h|hr|hrs|m|min|mins)$/.exec(x);
  if (glued) return { n: Number(glued[1]), next: i + 1, unit: glued[2]!.startsWith("h") ? "h" : "m" };
  // "1.5 horas" folds to "1 5 horas": a decimal only when a unit follows.
  if (/^\d{1,3}$/.test(x) && /^\d$/.test(w[i + 1] ?? "") && UNIT_WORDS.has(w[i + 2] ?? ""))
    return { n: Number(`${x}.${w[i + 1]}`), next: i + 2 };
  if (/^\d{1,3}$/.test(x)) return { n: Number(x), next: i + 1 };
  const veinti = /^veinti(\w+)$/.exec(x);
  const vu = veinti ? (veinti[1] === "un" ? 1 : UNITS[veinti[1]!]) : undefined;
  if (vu !== undefined) return { n: 20 + vu, next: i + 1 };
  if (TENS[x] !== undefined) {
    const t = TENS[x]!;
    if (w[i + 1] === "y" && UNITS[w[i + 2] ?? ""] !== undefined) return { n: t + UNITS[w[i + 2]!]!, next: i + 3 };
    if (UNITS[w[i + 1] ?? ""] !== undefined) return { n: t + UNITS[w[i + 1]!]!, next: i + 2 };
    return { n: t, next: i + 1 };
  }
  if (TEENS[x] !== undefined) return { n: TEENS[x]!, next: i + 1 };
  if (UNITS[x] !== undefined) return { n: UNITS[x]!, next: i + 1 };
  if (ARTICLE[x] !== undefined) return { n: 1, next: i + 1, article: true };
  return null;
};

/** How long a pause the words right after "pausa" ask for, and how many of them that took. */
const duration = (w: string[]): { minutes: number; used: number } | null => {
  let i = 0;
  while (LEAD.has(w[i] ?? "")) i++;
  if (w[i] === "media" && w[i + 1] === "hora") return { minutes: 30, used: i + 2 };
  if (w[i] === "half" && w[i + 1] === "an" && w[i + 2] === "hour") return { minutes: 30, used: i + 3 };
  if (w[i] === "half" && w[i + 1] === "hour") return { minutes: 30, used: i + 2 };
  const num = readNumber(w, i);
  if (!num) return null;
  const unitWord = w[num.next] ?? "";
  const unit = num.unit ?? (HOUR_WORDS.has(unitWord) ? "h" : MINUTE_WORDS.has(unitWord) ? "m" : undefined);
  let used = num.unit || !unit ? num.next : num.next + 1;
  // A bare number is minutes ("silencio 20"); a bare article isn't a number ("un rato").
  if (!unit && num.article) return null;
  let minutes = unit === "h" ? num.n * 60 : num.n;
  const half =
    (w[used] === "y" && w[used + 1] === "media") ||
    (w[used] === "and" && w[used + 1] === "a" && w[used + 2] === "half");
  if (unit === "h" && half) {
    minutes += 30;
    used += w[used] === "y" ? 2 : 3;
  }
  return { minutes: Math.round(minutes), used };
};

const DND_WORDS = "(?:no molestar|no me molestes|do not disturb|dont disturb|don t disturb|dnd)";
const DND_ANY = new RegExp(`\\b${DND_WORDS}\\b`, "g");
const DND_OFF = new RegExp(
  `\\b(?:desactiva\\w*|quita\\w*|apaga\\w*|deshabilita\\w*|termina\\w*|turn off|switch off|disable|end|stop)(?:\\s(?:el|la|modo|mode|the))*\\s${DND_WORDS}\\b|\\b${DND_WORDS}\\s(?:off|apagado|desactivado|fuera)\\b`,
);
const DND_ON = new RegExp(
  `(?:\\b(?:activa\\w*|pon\\w*|enciende|turn on|switch on|enable)(?:\\s(?:el|la|modo|mode|the|en))*\\s)?\\b(?:modo\\s)?${DND_WORDS}\\b(?:\\s(?:on|activado|mode))?`,
);
const PAUSE =
  /\b(?:pausa\w*|pause\w*|silencio|silence|callate|quiet|mute|snooze|shh+|hush|duermete|go to sleep)\b(?:\s(?:a|al|el|la|the|chalito|mascota|pet))*/;
const DENY =
  /\b(?:rechaza\w*|rechac\w*|deniega\w*|niegalo|niegala|no (?:\w+ ){0,2}(?:apruebes|autorices|permitas|aceptes)|deny|reject|decline|refuse)\b/;
const APPROVE =
  /\b(?:aprueba\w*|aprobar(?:lo|la|los|las)?|autoriza(?:lo|la|los|las|r)?|acepta(?:lo|la|los|las|r)?|permitelo|permitela|dale que si|approve|allow it|allow|accept|authorize|go ahead)\b/;
const NEG_WORDS = "no|don t|dont|not|never|nunca|jamas|ni|can t|cant|cannot|won t|wont|shouldn t|shouldnt";
/** "no / don't / never" right before an approve verb (3 words, same clause) turns it into a deny. */
const NEGATED = new RegExp(`\\b(?:${NEG_WORDS})\\b(?:\\s+\\S+){0,3}\\s*$`);
/** Any negation earlier in the clause ("no creo que sea buena idea aprobarlo"): too unsure to offer it. */
const NEG_IN_CLAUSE = new RegExp(`\\b(?:${NEG_WORDS})\\b`);
/** A "no" right after the verb ("apruébalo no", "approve it? no!") takes it back. */
const TAKEN_BACK = /^\s*(?:\S+\s+){0,2}(?:no|not|nope|nah)\b/;
const WHY_NOT = /\b(?:why not|por que no)\b/;
/** Asking about it ("¿ya lo aprobaste?", "should I approve it?") rather than asking for it ("¿puedes aprobarlo?"). */
const ABOUT_IT =
  /\b(?:should i|shall i|do i|did i|did you|have you|has it|is it|was it|apruebo|apruebe|aprobaste|aprobo|aprobamos|aprobaron|ya)\b/;
const NEW_SESSION =
  /\b(?:(?:abre|crea|inicia|iniciar|empieza|comienza|arranca)\s(?:una\s)?(?:nueva\s)?sesion|nueva sesion|(?:start|open|create|begin)\s(?:a\s)?(?:new\s)?session|new session)\b(?:\s(?:para|con|que|sobre|de|to|with|about|and|y|for))?/;
const OPEN =
  /\b(?:abre\w*|abrir|muestra\w*|ensename|ve a|ir a|cambia a|open|show(?: me)?|go to|switch to)\s(?:(?:la|el|mi|the|my)\s)?(?:(?:siguiente|proxima|next)\s?)?(?:sesion|session|chat)?\b/;
const NEXT_ALONE = /^\s*(?:(?:la|the)\s)?(?:siguiente|proxima|next)(?:\s(?:sesion|session))?\s*$/;
const FILLER = new Set(
  "y and tambien also luego then porfa por favor please oye hey ok okay chalito ya now de del of for called llamada la el the a an mi my que se llama sesion session".split(
    " ",
  ),
);

const trimFiller = (s: string): string => {
  const w = s.split(/\s+/).filter(Boolean);
  while (w.length && FILLER.has(w[0]!)) w.shift();
  while (w.length && FILLER.has(w[w.length - 1]!)) w.pop();
  return w.join(" ");
};

export const parseIntent = (raw: string): ParsedVoice => {
  const text = String(raw ?? "")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const { folded, at } = fold(text);
  const found: { index: number; cmd: VoiceCommand }[] = [];
  let rest = ` ${folded} `;
  const blank = (start: number, len: number) =>
    (rest = rest.slice(0, start) + " ".repeat(len) + rest.slice(start + len));

  // A new session's prompt is free text: commands said inside it are part of the prompt.
  const ns = NEW_SESSION.exec(rest);
  if (ns) {
    const from = ns.index + ns[0].length - 1;
    const prompt = from < at.length ? text.slice(at[Math.max(0, from)] ?? text.length).trim() : "";
    found.push({ index: ns.index, cmd: { kind: "newSession", prompt: prompt.replace(/^[\s,.:;-]+/, "") } });
    rest = rest.slice(0, ns.index).padEnd(rest.length);
  }
  const off = DND_OFF.exec(rest);
  if (off) {
    found.push({ index: off.index, cmd: { kind: "dnd", on: false } });
    blank(off.index, off[0].length);
  }
  const on = DND_ON.exec(rest);
  if (on) {
    found.push({ index: on.index, cmd: { kind: "dnd", on: true } });
    blank(on.index, on[0].length);
  }
  // `rest` index → the original text, where the punctuation still marks clauses and questions.
  const orig = (i: number) => at[i - 1] ?? text.length;
  const clauseBefore = (i: number) =>
    fold(
      text
        .slice(0, orig(i))
        .split(/[,.;:!?¡¿]/)
        .pop() ?? "",
    ).folded.replace(DND_ANY, " ");
  // The "no" of "no molestar" was its own command, not a negation of the next one.
  const negatedAt = (i: number) => {
    const clause = clauseBefore(i);
    return NEGATED.test(clause) && !WHY_NOT.test(clause);
  };
  const hedgedAt = (i: number) => {
    const clause = clauseBefore(i);
    return NEG_IN_CLAUSE.test(clause) && !WHY_NOT.test(clause);
  };
  const takenBack = (end: number) => TAKEN_BACK.test(fold(text.slice(orig(end))).folded.replace(DND_ANY, " "));
  const pause = PAUSE.exec(rest);
  if (pause) {
    const from = pause.index + pause[0].length;
    const tokens = [...rest.slice(from).matchAll(/\S+/g)];
    const d = duration(tokens.map((t) => t[0]));
    const minutes = d ? Math.min(Math.max(d.minutes, 1), 240) : 15;
    if (!hedgedAt(pause.index)) found.push({ index: pause.index, cmd: { kind: "pause", minutes } });
    const last = d && d.used ? tokens[d.used - 1]! : null;
    blank(pause.index, (last ? from + last.index + last[0].length : from) - pause.index);
  }
  const sentenceOf = (i: number) => {
    const o = orig(i);
    const start = Math.max(...[".", "!", "?"].map((p) => text.lastIndexOf(p, o - 1))) + 1;
    const ends = [".", "!", "?"].map((p) => text.indexOf(p, o)).filter((x) => x >= 0);
    return text.slice(start, ends.length ? Math.min(...ends) + 1 : text.length);
  };
  const asksAbout = (i: number) => {
    const s = sentenceOf(i);
    return /[?¿]/.test(s) && ABOUT_IT.test(fold(s).folded);
  };
  const denyM = DENY.exec(rest);
  // "Don't reject it" isn't a deny; it isn't clearly an approve either, so it offers nothing.
  const deny = denyM && !asksAbout(denyM.index) && !hedgedAt(denyM.index) ? denyM : null;
  if (denyM) blank(denyM.index, denyM[0].length);
  if (deny) found.push({ index: deny.index, cmd: { kind: "deny" } });
  const approveM = deny ? null : APPROVE.exec(rest);
  const approve = approveM && !asksAbout(approveM.index) ? approveM : null;
  if (approve) {
    const end = approve.index + approve[0].length;
    // Never an Approve card when a "no" is anywhere near it: a deny if it's plainly negated, else nothing.
    const kind = negatedAt(approve.index) ? "deny" : hedgedAt(approve.index) || takenBack(end) ? null : "approve";
    if (kind) found.push({ index: approve.index, cmd: { kind } });
    blank(approve.index, approve[0].length);
  }
  const open = OPEN.exec(rest);
  const target = open ? trimFiller(rest.slice(open.index + open[0].length).replace(/\s+/g, " ")) : "";
  const opensSomething =
    open && (/sesion|session|chat|siguiente|proxima|next/.test(open[0]) || !found.length || target);
  if (open && opensSomething) {
    found.push({
      index: open.index,
      cmd: { kind: "open", target: target && !/^(?:siguiente|proxima|next|pendiente)$/.test(target) ? target : null },
    });
  } else if (NEXT_ALONE.test(rest)) {
    found.push({ index: 0, cmd: { kind: "open", target: null } });
  }
  return { text, commands: found.sort((a, b) => a.index - b.index).map((f) => f.cmd) };
};
