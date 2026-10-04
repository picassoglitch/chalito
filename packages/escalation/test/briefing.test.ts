import { describe, expect, it } from "vitest";
import type { CallBriefing } from "@chalito/protocol";
import { CALL_MENU, buildBriefing } from "../src/briefing.js";
import { buildTemplateVars } from "../src/payloads.js";
import { item } from "./sim.js";

const base = { v: 1 as const, nid: "n1", uid: "u1", callBriefingEnabled: true, items: [] };
const counts = (o: Partial<CallBriefing["counts"]> = {}) => ({
  approvals: 0,
  questions: 0,
  messages: 0,
  mesas: 0,
  ...o,
});

const mesa = (locale: "es" | "en"): CallBriefing => ({
  ...base,
  locale,
  kind: "mesa_starting",
  counts: counts({ mesas: 1 }),
  mesa: { title: "Plan de lanzamiento", startsInMin: 5 },
});

const agents = (locale: "es" | "en", callBriefingEnabled = true): CallBriefing => ({
  ...base,
  locale,
  kind: "agents_waiting",
  callBriefingEnabled,
  counts: counts({ questions: 3, messages: 5, approvals: 1 }),
  unansweredWindowHours: 3,
  items: [
    { deviceLabel: "Escritorio", sessionLabel: "API de pagos", line: "¿Corro las migraciones en staging?" },
    { deviceLabel: "Laptop", sessionLabel: "Landing", line: "¿Publico el borrador?" },
    { deviceLabel: "Laptop", sessionLabel: "Docs" },
    { deviceLabel: "Escritorio", sessionLabel: "Infra", line: "¿Subo la versión?" },
  ],
});

const unanswered = (locale: "es" | "en"): CallBriefing => ({
  ...base,
  locale,
  kind: "unanswered_messages",
  counts: counts({ messages: 1 }),
  unansweredWindowHours: 1,
});

describe("call briefing (ES)", () => {
  it("meeting in 5", () => {
    expect(buildBriefing(mesa("es")).text).toMatchInlineSnapshot(
      `"Hola, habla Chalito. Tu Mesa «Plan de lanzamiento» empieza en 5 minutos. Oprime 1 para conectarte ahora, 2 para que te llame un minuto antes, o 3 para descartar."`,
    );
  });
  it("agents on standby, with call lines", () => {
    expect(buildBriefing(agents("es")).segments).toMatchInlineSnapshot(`
      [
        "Hola, habla Chalito.",
        "Tienes 3 agentes en espera que necesitan tu respuesta y 5 mensajes sin contestar en las últimas 3 horas.",
        "También tienes 1 aprobación pendiente; esa solo se aprueba desde tu app.",
        "En Escritorio, API de pagos pregunta: ¿Corro las migraciones en staging?",
        "En Laptop, Landing pregunta: ¿Publico el borrador?",
        "En Laptop, Docs espera tu respuesta.",
        "Y 1 pendiente más.",
        "Oprime 1 para escucharlos y responder, 2 para que te llame en 10 minutos, o 3 para descartar.",
      ]
    `);
  });
  it("unanswered messages", () => {
    expect(buildBriefing(unanswered("es")).text).toMatchInlineSnapshot(
      `"Hola, habla Chalito. Tienes 1 mensaje sin contestar en la última hora. Oprime 1 para escucharlo y responder, 2 para que te llame en 10 minutos, o 3 para descartar."`,
    );
  });
});

describe("call briefing (EN)", () => {
  it("meeting in 5", () => {
    expect(buildBriefing(mesa("en")).text).toMatchInlineSnapshot(
      `"Hi, this is Chalito. Your Mesa "Plan de lanzamiento" starts in 5 minutes. Press 1 to join now, 2 to get a call one minute before, or 3 to dismiss."`,
    );
  });
  it("agents on standby, with call lines", () => {
    expect(buildBriefing(agents("en")).segments).toMatchInlineSnapshot(`
      [
        "Hi, this is Chalito.",
        "You have 3 agents waiting for your answer and 5 unanswered messages from the last 3 hours.",
        "You also have 1 pending approval; it can only be approved in your app.",
        "On Escritorio, API de pagos asks: ¿Corro las migraciones en staging?",
        "On Laptop, Landing asks: ¿Publico el borrador?",
        "On Laptop, Docs is waiting for you.",
        "And 1 more item.",
        "Press 1 to hear them and answer, 2 to get a call in 10 minutes, or 3 to dismiss.",
      ]
    `);
  });
  it("unanswered messages", () => {
    expect(buildBriefing(unanswered("en")).text).toMatchInlineSnapshot(
      `"Hi, this is Chalito. You have 1 unanswered message from the last hour. Press 1 to hear it and answer, 2 to get a call in 10 minutes, or 3 to dismiss."`,
    );
  });
});

describe("call briefing rules", () => {
  it("with call briefing disabled the script is metadata only, even if lines were sent", () => {
    const s = buildBriefing(agents("es", false));
    expect(s.segments).toMatchInlineSnapshot(`
      [
        "Hola, habla Chalito.",
        "Tienes 3 agentes en espera que necesitan tu respuesta y 5 mensajes sin contestar en las últimas 3 horas.",
        "También tienes 1 aprobación pendiente; esa solo se aprueba desde tu app.",
        "En Escritorio, API de pagos espera tu respuesta.",
        "En Laptop, Landing espera tu respuesta.",
        "En Laptop, Docs espera tu respuesta.",
        "Y 1 pendiente más.",
        "Oprime 1 para escucharlos y responder, 2 para que te llame en 10 minutos, o 3 para descartar.",
      ]
    `);
    for (const it of agents("es").items) if (it.line) expect(s.text).not.toContain(it.line);
  });

  it("a line that breaks the CallLine rules falls back to metadata", () => {
    const b = agents("es");
    b.items = [{ deviceLabel: "Escritorio", sessionLabel: "API", line: "¿Borro /etc/passwd?" }];
    const s = buildBriefing(b);
    expect(s.text).not.toContain("passwd");
    expect(s.text).toContain("En Escritorio, API espera tu respuesta.");
  });

  it("the DTMF menu is fixed and nothing invites approving by voice", () => {
    for (const b of [mesa("es"), agents("es"), unanswered("en"), agents("en")]) {
      const s = buildBriefing(b);
      expect(s.menu).toEqual(CALL_MENU);
      expect(s.menu).toEqual({ "1": "connect", "2": "snooze", "3": "dismiss" });
      expect(s.segments.at(-1)).toMatch(/^(Oprime|Press) 1 .* 2 .* 3 /);
      expect(s.text).not.toMatch(/oprime \d para aprobar|press \d to approve/i);
    }
  });

  it("is deterministic and validates its input", () => {
    expect(buildBriefing(agents("en"))).toEqual(buildBriefing(agents("en")));
    expect(() => buildBriefing({ ...mesa("es"), locale: "fr" } as never)).toThrow();
  });

  it("singulars and 'now' read naturally", () => {
    const now = { ...mesa("es"), mesa: { title: "Demo", startsInMin: 0 } };
    expect(buildBriefing(now).segments[1]).toBe("Tu Mesa «Demo» empieza ahora.");
    const one = { ...agents("en"), counts: counts({ questions: 1 }), items: [] };
    expect(buildBriefing(one).segments[1]).toBe("You have 1 agent waiting for your answer.");
  });
});

describe("template variables", () => {
  it("are only integers and enums, whatever the item carries", () => {
    const vars = buildTemplateVars(
      { ...item({ counts: { approvals: 2, questions: 400, messages: 600, mesas: 1 } }), title: "SECRET" } as never,
      "es",
    );
    expect(vars).toEqual({
      template: "chalito_pendientes_v1",
      locale: "es",
      total: 999,
      source: "session_question",
      urgency: "high",
      linkId: "n1",
    });
  });
});
