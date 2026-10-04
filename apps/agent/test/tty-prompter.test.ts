import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadLiabilityText } from "@chalito/config";
import { RISK_COPY } from "../src/devmode.js";
import { LineReader, isYes, readHidden } from "../src/tty.js";
import { TtyPrompter } from "../src/tty-prompter.js";

const scripted = (lines: string[]) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (b: Buffer) => (printed += b.toString()));
  input.end(lines.map((l) => `${l}\n`).join(""));
  return { io: { input, output }, printed: () => printed };
};

describe("TtyPrompter: the three Developer-mode confirmations", () => {
  it("asks three separate questions, shows examples, risk and the liability text, returns the typed phrase", async () => {
    const liability = loadLiabilityText("es");
    const t = scripted(["s", "sí", "s", "ACEPTO"]);
    const reader = new LineReader(t.io);
    let out = "";
    const p = new TtyPrompter(reader, (s) => (out += s), "es");
    const copy = RISK_COPY.es.allowSudo;

    expect(await p.first("allowSudo", copy.examples)).toBe(true);
    expect(await p.second("allowSudo", copy.risk)).toBe(true);
    expect(await p.liability(liability)).toEqual({ checked: true, typed: "ACEPTO" });
    reader.close();

    expect(out).toContain("¿Activar allowSudo?");
    for (const e of copy.examples) expect(out).toContain(e);
    expect(out).toContain("sudo puede dañar tu sistema de forma irreversible.");
    expect(out).toContain("Chalito no es responsable");
    expect(t.printed()).toContain('Escribe exactamente "ACEPTO"');
  });

  it("anything but an explicit yes cancels; an unticked box doesn't ask for the phrase", async () => {
    const t = scripted(["", "no", "n"]);
    const reader = new LineReader(t.io);
    const p = new TtyPrompter(reader, () => undefined, "en");
    expect(await p.first("autoApproveHigh", [])).toBe(false);
    expect(await p.second("autoApproveHigh", "")).toBe(false);
    expect(await p.liability(loadLiabilityText("en"))).toEqual({ checked: false, typed: "" });
    expect(t.printed()).not.toContain("Type exactly");
    reader.close();
  });

  it("end of input counts as no", async () => {
    const t = scripted([]);
    const reader = new LineReader(t.io);
    expect(await new TtyPrompter(reader, () => undefined).first("allowSudo", [])).toBe(false);
  });
});

describe("tty helpers", () => {
  it("isYes accepts s/si/sí/y/yes only", () => {
    for (const y of ["s", "S", "si", "sí", "y", "YES", " yes "]) expect(isYes(y)).toBe(true);
    for (const n of ["", "n", "no", "ok", "yeah", null]) expect(isYes(n)).toBe(false);
  });

  it("readHidden reads piped input as one line without echoing it", async () => {
    const t = scripted(["sk-ant-secret-value"]);
    expect(await readHidden(t.io, "key: ")).toBe("sk-ant-secret-value");
    expect(t.printed()).toBe("key: ");
  });

  it("readHidden in raw mode handles backspace and never echoes", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => void };
    const modes: boolean[] = [];
    input.isTTY = true;
    input.setRawMode = (on) => void modes.push(on);
    const output = new PassThrough();
    let printed = "";
    output.on("data", (b: Buffer) => (printed += b.toString()));
    const p = readHidden({ input, output }, "key: ");
    input.write("abx\u007fc\r");
    expect(await p).toBe("abc");
    expect(modes).toEqual([true, false]);
    expect(printed).toBe("key: \n");
  });
});
