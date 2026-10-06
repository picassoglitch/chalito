import type { Locale } from "@chalito/protocol";
import { AnchorStore } from "../anchor.js";
import { loadOrCreateIdentity } from "../identity.js";
import { osAuthFor, type StatFn } from "../os-auth.js";
import { FilePolicyHolder } from "../policy-file.js";
import type { ProcessRunner } from "../runner.js";
import type { SecretStore } from "../secrets.js";
import { createLogger } from "../redact.js";
import { LineReader, isYes, type TtyIo } from "../tty.js";
import { AppCatalog } from "./catalog.js";
import { disableCustomRecipe, enableCustomRecipe } from "./custom-toggle.js";

const T = {
  es: {
    usage: "chalito apps list | apps custom list | apps custom enable <id> | apps custom disable <id>\n",
    curated: "Curadas:\n",
    custom: "Personalizadas (~/.chalito/recipes):\n",
    none: "  (ninguna)\n",
    on: "activada",
    off: "desactivada",
    edited: "editada desde que la activaste: desactivada hasta que la actives otra vez",
    problem: (f: string, r: string) =>
      `  ! ${f}: ${r === "shadows_curated" ? "usa el id de una app curada" : r === "duplicate_id" ? "id repetido" : r === "too_large" ? "archivo demasiado grande" : "no es una receta válida"}\n`,
    continue: "¿Continuar? [s/N] ",
    unknown: (id: string) => `No hay una receta personalizada «${id}» en ~/.chalito/recipes.\n`,
    already: "Esa receta ya está activada.\n",
    authFailed: "No se pudo verificar tu identidad en el sistema. No cambió nada.\n",
    cancelled: "Cancelado. No cambió nada.\n",
    enabled: (id: string) =>
      `Receta «${id}» activada en esta computadora. Si editas el archivo, se desactiva hasta que la actives otra vez.\n`,
    disabled: (id: string) => `Receta «${id}» desactivada.\n`,
    wasOff: (id: string) => `La receta «${id}» ya estaba desactivada.\n`,
  },
  en: {
    usage: "chalito apps list | apps custom list | apps custom enable <id> | apps custom disable <id>\n",
    curated: "Curated:\n",
    custom: "Custom (~/.chalito/recipes):\n",
    none: "  (none)\n",
    on: "on",
    off: "off",
    edited: "edited since you turned it on: off until you turn it on again",
    problem: (f: string, r: string) =>
      `  ! ${f}: ${r === "shadows_curated" ? "uses a curated app's id" : r === "duplicate_id" ? "repeated id" : r === "too_large" ? "file too large" : "not a valid recipe"}\n`,
    continue: "Continue? [y/N] ",
    unknown: (id: string) => `There's no custom recipe "${id}" in ~/.chalito/recipes.\n`,
    already: "That recipe is already on.\n",
    authFailed: "Couldn't verify your identity with the system. Nothing changed.\n",
    cancelled: "Cancelled. Nothing changed.\n",
    enabled: (id: string) =>
      `Recipe "${id}" is on for this computer. Editing the file turns it off until you turn it on again.\n`,
    disabled: (id: string) => `Recipe "${id}" is off.\n`,
    wasOff: (id: string) => `Recipe "${id}" was already off.\n`,
  },
};

export interface AppsCliIo {
  out(s: string): void;
  err(s: string): void;
  tty: TtyIo;
  platform: NodeJS.Platform;
  secrets?: SecretStore;
  runner: ProcessRunner;
  osStat?: StatFn;
}

/**
 * `chalito apps …`: lists the catalog and turns custom recipes on or off. Turning one ON is
 * local only (this terminal): OS authentication, a review of every command it runs, and the
 * recipe id typed back. The running daemon sees the policy change.
 */
export const appsCli = async (
  io: AppsCliIo,
  dir: string,
  locale: Locale,
  args: (string | undefined)[],
): Promise<number> => {
  const t = T[locale];
  const [sub, action, id] = args;
  const keys = await loadOrCreateIdentity(io.secrets!);
  const holder = new FilePolicyHolder(dir, keys.sign, { anchor: await new AnchorStore(io.secrets!).load() });
  const catalog = new AppCatalog({
    dir,
    customEnables: () => holder.get().apps?.custom ?? {},
    log: createLogger(() => undefined),
  });

  const listCustom = () => {
    io.out(t.custom);
    const entries = catalog.entries().filter((e) => e.custom);
    if (!entries.length) io.out(t.none);
    const enables = holder.get().apps?.custom ?? {};
    for (const e of entries) {
      const was = enables[e.recipe.id];
      const state = e.enabled ? t.on : was?.enabled ? t.edited : t.off;
      io.out(`  ${e.recipe.id}  ${e.recipe.name}  (${state})\n`);
    }
    for (const p of catalog.custom().problems) io.out(t.problem(p.file, p.reason));
  };

  if (sub === "list") {
    io.out(t.curated);
    for (const r of catalog.curated()) io.out(`  ${r.id}  ${r.name} · ${r.vendor}  [${r.kinds.join(", ")}]\n`);
    listCustom();
    return 0;
  }
  if (sub !== "custom") {
    io.err(t.usage);
    return 1;
  }
  if (action === "list" || action === undefined) {
    listCustom();
    return 0;
  }
  if (!id || (action !== "enable" && action !== "disable")) {
    io.err(t.usage);
    return 1;
  }
  const emit = () => undefined;
  if (action === "disable") {
    const changed = await disableCustomRecipe({ policy: holder, emit }, id, "cli");
    io.out(changed ? t.disabled(id) : t.wasOff(id));
    return 0;
  }
  const reader = new LineReader(io.tty);
  try {
    const res = await enableCustomRecipe(
      {
        policy: holder,
        catalog,
        osAuth: osAuthFor(io.platform, io.runner, (m) => io.err(`${m}\n`), locale, io.osStat),
        prompter: {
          review: async ([title, warn, ...lines]) => {
            io.out(`\n${title}\n${warn}\n\n${lines.map((l) => `  ${l}\n`).join("")}\n`);
            return isYes(await reader.ask(t.continue));
          },
          typed: async (q) => (await reader.ask(`${q}: `)) ?? "",
        },
        locale,
        emit,
      },
      id,
    );
    if (!res.ok) {
      io.err(
        res.reason === "unknown_recipe"
          ? t.unknown(id)
          : res.reason === "already_on"
            ? t.already
            : res.reason === "os_auth_failed"
              ? t.authFailed
              : t.cancelled,
      );
      return res.reason === "already_on" ? 0 : 1;
    }
    io.out(t.enabled(id));
    return 0;
  } finally {
    reader.close();
  }
};
