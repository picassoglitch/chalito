import type { DevModeToggle } from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import type { ConfirmPrompter } from "./devmode.js";
import { isYes, type LineReader } from "./tty.js";

const COPY = {
  es: {
    title: (t: string) => `\n!!  ¿Activar ${t}?  !!\n`,
    examples: "Esto puede salir mal, por ejemplo:",
    continue: "¿Continuar? [s/N] ",
    second: "Confirmación 2 de 3. ",
    sure: "¿Seguro que quieres activarlo? [s/N] ",
    third: "\nConfirmación 3 de 3: aceptación de responsabilidad\n",
    check: "[ ] Marca la casilla: ¿aceptas este texto? [s/N] ",
    type: (p: string) => `Escribe exactamente "${p}" para aceptar: `,
  },
  en: {
    title: (t: string) => `\n!!  Turn on ${t}?  !!\n`,
    examples: "Things that can go wrong, for example:",
    continue: "Continue? [y/N] ",
    second: "Confirmation 2 of 3. ",
    sure: "Are you sure you want to turn it on? [y/N] ",
    third: "\nConfirmation 3 of 3: liability acceptance\n",
    check: "[ ] Tick the box: do you accept this text? [y/N] ",
    type: (p: string) => `Type exactly "${p}" to accept: `,
  },
} as const;

/**
 * The three separate Developer-mode confirmations in a terminal. Each is its own
 * question; anything other than an explicit yes (or the exact phrase) cancels.
 */
export class TtyPrompter implements ConfirmPrompter {
  constructor(
    private readonly reader: LineReader,
    private readonly out: (s: string) => void,
    private readonly locale: "es" | "en" = "es",
  ) {}

  async first(toggle: DevModeToggle, examples: string[]): Promise<boolean> {
    const c = COPY[this.locale];
    this.out(`${c.title(toggle)}${c.examples}\n${examples.map((e) => `  - ${e}\n`).join("")}`);
    return isYes(await this.reader.ask(c.continue));
  }

  async second(_toggle: DevModeToggle, risk: string): Promise<boolean> {
    const c = COPY[this.locale];
    this.out(`\n${c.second}${risk}\n`);
    return isYes(await this.reader.ask(c.sure));
  }

  async liability(text: LiabilityText): Promise<{ checked: boolean; typed: string }> {
    const c = COPY[this.locale];
    this.out(`${c.third}\n  ${text.text}\n  (v${text.version})\n\n`);
    const checked = isYes(await this.reader.ask(c.check));
    if (!checked) return { checked, typed: "" };
    return { checked, typed: (await this.reader.ask(c.type(text.phrase))) ?? "" };
  }
}
