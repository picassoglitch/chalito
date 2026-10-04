import { describe, expect, it } from "vitest";
import { estimateTokens } from "@chalito/protocol";
import { buildCallLine } from "../src/call-lines.js";
import { CardBuilder } from "../src/card.js";
import { createLogger, redact } from "../src/redact.js";

describe("redaction", () => {
  it("removes keys, tokens, emails and phone numbers but keeps timestamps", () => {
    const out = redact(
      "key sk-ant-api03-abcdefghijklmnop, Bearer abc.def.ghi, aldo@example.com, +52 55 1234 5678, 5512345678, xai-abcdefghijklmnopqrstu, at 2026-10-04T10:00:00Z",
    );
    expect(out).not.toMatch(/abcdefghijklmnop|aldo@|1234 5678|5512345678|xai-abcdefg/);
    expect(out).toContain("…78");
    expect(out).toContain("2026-10-04T10:00:00Z");
  });
  it("the logger redacts messages and metadata strings only", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).info("sent to aldo@example.com", {
      token: "sk-ant-api03-zzzzzzzzzzzz",
      n: 17900000000001,
    });
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.msg).toBe("sent to <email>");
    expect(parsed.token).toBe("sk-ant-…");
    expect(parsed.n).toBe(17900000000001);
  });
});

describe("session card", () => {
  it("stays under 300 tokens and never carries secrets", () => {
    const c = new CardBuilder(
      { sid: "s1", adapter: "claude-code", label: "chalito", workspaceLabel: "chalito" },
      () => 1,
    );
    c.goal(`${"Refactoriza todo el módulo de pagos ".repeat(30)} con mi key sk-ant-api03-SECRETSECRET`);
    c.action(`Bash: ${"x".repeat(500)}`);
    c.question("¿Corro las migraciones en staging?");
    for (let i = 0; i < 10; i++) c.blocker(`bloqueo ${i} ${"y".repeat(200)}`);
    const card = c.build();
    expect(estimateTokens(card)).toBeLessThanOrEqual(300);
    expect(JSON.stringify(card)).not.toContain("SECRET");
    expect(card.blockers).toHaveLength(3);
  });
});

describe("call line text", () => {
  it("keeps a short question and falls back to a generic line for paths or commands", () => {
    expect(buildCallLine("Escritorio", "¿Corro las migraciones en staging?", "es")).toBe(
      "El agente de Escritorio pregunta: ¿Corro las migraciones en staging?",
    );
    expect(buildCallLine("Escritorio", "¿Edito src/db/schema.ts?", "es")).toBe(
      "El agente de Escritorio necesita tu respuesta.",
    );
    expect(buildCallLine("Desk", "run `rm -rf dist`", "en")).toBe("The Desk agent needs your answer.");
  });
});
