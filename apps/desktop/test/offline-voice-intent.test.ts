import { describe, expect, it } from "vitest";
import { parseIntent, type VoiceCommand } from "../src/lib/offline-voice/intent.js";

const cmds = (s: string) => parseIntent(s).commands;
const one = (c: VoiceCommand) => [c];

describe("voice intent rules: Spanish, with and without accents", () => {
  it.each([
    ["Apruébalo", one({ kind: "approve" })],
    ["apruebalo", one({ kind: "approve" })],
    ["APRUEBA ESO, porfa.", one({ kind: "approve" })],
    ["Sí, autorízalo", one({ kind: "approve" })],
    ["Recházalo", one({ kind: "deny" })],
    ["No lo apruebes", one({ kind: "deny" })],
    ["no aprobar", one({ kind: "deny" })],
    ["Deniégalo", one({ kind: "deny" })],
    ["Abre la sesión de pagos", one({ kind: "open", target: "pagos" })],
    ["abre la sesion de pagos", one({ kind: "open", target: "pagos" })],
    ["Oye Chalito, ábreme la sesión del backend", one({ kind: "open", target: "backend" })],
    ["Muéstrame la próxima sesión", one({ kind: "open", target: null })],
    ["Siguiente", one({ kind: "open", target: null })],
    ["Pausa 20 minutos", one({ kind: "pause", minutes: 20 })],
    ["Pausa a Chalito por quince minutos", one({ kind: "pause", minutes: 15 })],
    ["Cállate media hora", one({ kind: "pause", minutes: 30 })],
    ["Silencio", one({ kind: "pause", minutes: 15 })],
    ["silencio una hora", one({ kind: "pause", minutes: 60 })],
    ["Pon no molestar", one({ kind: "dnd", on: true })],
    ["Activa el modo no molestar", one({ kind: "dnd", on: true })],
    ["Quita no molestar", one({ kind: "dnd", on: false })],
    ["Desactiva el no molestar", one({ kind: "dnd", on: false })],
  ])("%s", (said, want) => expect(cmds(said)).toEqual(want));

  it("a new session keeps the prompt as said: accents, case and words that look like commands", () => {
    expect(cmds("Nueva sesión: Arregla el botón de «Aprobar» y no molestar")).toEqual([
      { kind: "newSession", prompt: "Arregla el botón de «Aprobar» y no molestar" },
    ]);
    expect(cmds("Inicia una sesión para revisar por qué falla el CI")).toEqual([
      { kind: "newSession", prompt: "revisar por qué falla el CI" },
    ]);
    expect(cmds("nueva sesión")).toEqual([{ kind: "newSession", prompt: "" }]);
  });

  it("commands said before a new session are still heard", () => {
    expect(cmds("Pon no molestar y nueva sesión para limpiar los logs")).toEqual([
      { kind: "dnd", on: true },
      { kind: "newSession", prompt: "limpiar los logs" },
    ]);
  });
});

describe("voice intent rules: English", () => {
  it.each([
    ["Approve", one({ kind: "approve" })],
    ["Yes, approve it please", one({ kind: "approve" })],
    ["go ahead", one({ kind: "approve" })],
    ["Deny it", one({ kind: "deny" })],
    ["Don't approve that", one({ kind: "deny" })],
    ["reject", one({ kind: "deny" })],
    ["Open the next session", one({ kind: "open", target: null })],
    ["open the session called billing api", one({ kind: "open", target: "billing api" })],
    ["next", one({ kind: "open", target: null })],
    ["pause the pet for half an hour", one({ kind: "pause", minutes: 30 })],
    ["Pause for 10 minutes", one({ kind: "pause", minutes: 10 })],
    ["quiet", one({ kind: "pause", minutes: 15 })],
    ["do not disturb", one({ kind: "dnd", on: true })],
    ["Turn on do not disturb", one({ kind: "dnd", on: true })],
    ["Turn off do not disturb", one({ kind: "dnd", on: false })],
    ["DND off", one({ kind: "dnd", on: false })],
  ])("%s", (said, want) => expect(cmds(said)).toEqual(want));

  it("start a new session with a prompt", () => {
    expect(cmds("Start a new session to fix the flaky test")).toEqual([
      { kind: "newSession", prompt: "fix the flaky test" },
    ]);
  });
});

describe("voice intent rules: what isn't a command", () => {
  it.each(["[BLANK_AUDIO]", "(música)", "", "qué hora es", "what's the weather like"])("%s → nothing", (said) =>
    expect(cmds(said)).toEqual([]),
  );

  it("drops whisper's markers from the text it shows", () => {
    expect(parseIntent(" [BLANK_AUDIO] Aprueba (risas) ").text).toBe("Aprueba");
  });

  it("deny wins over approve in the same breath, so 'no' is never heard as yes", () => {
    expect(cmds("no lo apruebes, recházalo")).toEqual([{ kind: "deny" }]);
    expect(cmds("don't allow it")).toEqual([{ kind: "deny" }]);
  });

  it("several asks come back in the order said, for the 'this, this or all' card", () => {
    expect(cmds("Rechaza y pon no molestar")).toEqual([{ kind: "deny" }, { kind: "dnd", on: true }]);
    expect(cmds("Approve and then pause for 10 minutes")).toEqual([
      { kind: "approve" },
      { kind: "pause", minutes: 10 },
    ]);
  });

  it.each([
    "No autorizar",
    "no aceptar",
    "Don't accept it",
    "don't authorize that",
    "do not go ahead",
    "never approve that",
    "no lo vayas a aprobar",
    "I don't want you to approve it",
    "no los apruebes",
    "no me lo apruebes",
    "I can't allow that",
    "I won't approve it",
    "I don't want to approve this",
  ])("a negated approval is a deny, never an approve: %s", (said) => expect(cmds(said)).toEqual([{ kind: "deny" }]));

  it.each(["¿ya está aprobado?", "¿lo apruebo?", "should I approve it?", "did you approve it?"])(
    "asking about it doesn't approve: %s",
    (said) => expect(cmds(said)).toEqual([]),
  );

  it.each([
    ["Can you approve it?", "approve"],
    ["¿Puedes aprobarlo?", "approve"],
    ["Please reject it?", "deny"],
  ] as const)("a polite request punctuated as a question still counts: %s", (said, kind) =>
    expect(cmds(said)).toEqual([{ kind }]),
  );

  it.each([
    "No, apruébalo",
    "no no, aprueba",
    "No hay problema, apruébalo",
    "No problem, approve it",
    "no sé, apruébalo",
    "No pasa nada, autorízalo",
    "I have no idea, just approve it",
    "Not now. Approve it.",
    "why not approve it",
    "no me dejes esperando, apruébalo",
  ])("a 'no' in another clause doesn't flip an approval: %s", (said) =>
    expect(cmds(said)).toEqual([{ kind: "approve" }]),
  );

  it.each([
    ["pausa dos horas", 120],
    ["pause for two hours", 120],
    ["pausa 2 horas", 120],
    ["pausa por 1 hora", 60],
    ["pause one hour", 60],
    ["pause for an hour", 60],
    ["pausa una hora", 60],
    ["pausa un rato", 15],
    ["pause for twenty five minutes", 25],
    ["pausa cuarenta y cinco minutos", 45],
    ["pausa veinticinco minutos", 25],
    ["pausa tres minutos", 3],
    ["pause 5m", 5],
    ["pausa 1h", 60],
    ["silencio 20", 20],
    ["silencio 20 por favor", 20],
    ["pausa diez, chalito", 10],
    ["pausa 5mins", 5],
    ["pausa dieciocho minutos", 18],
    ["pause for seventy minutes", 70],
  ])("durations: %s → %i min", (said, minutes) => expect(cmds(said)).toEqual([{ kind: "pause", minutes }]));

  it("an open said after another command is kept", () => {
    expect(cmds("Aprueba y abre pagos")).toEqual([{ kind: "approve" }, { kind: "open", target: "pagos" }]);
  });

  it("don't disturb, with the apostrophe whisper writes", () => {
    expect(cmds("Don't disturb me")).toEqual([{ kind: "dnd", on: true }]);
  });

  it("caps a pause at four hours", () => {
    expect(cmds("pausa 900 minutos")).toEqual([{ kind: "pause", minutes: 240 }]);
  });
});
