import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { z } from "zod";
import { PlansConfig } from "@chalito/protocol";
import {
  CatalogConfig,
  EscalationConfig,
  RechargeCopy,
  ModelsConfig,
  PricesConfig,
  ProvidersConfig,
  RenderConfig,
  RoomsConfig,
} from "./schemas.js";

/** Directory holding the YAML files (packages/config). */
export const CONFIG_DIR = fileURLToPath(new URL("../", import.meta.url));

const load = <S extends z.ZodTypeAny>(schema: S, file: string, dir = CONFIG_DIR): z.infer<S> => {
  const raw = parse(readFileSync(new URL(file, `file://${dir.endsWith("/") ? dir : `${dir}/`}`), "utf8"), {
    merge: true,
  });
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error(`${file}: ${result.error.message}`);
  return result.data;
};

export const loadPlans = (dir?: string) => load(PlansConfig, "plans.yaml", dir);
export const loadModels = (dir?: string) => load(ModelsConfig, "models.yaml", dir);
export const loadPrices = (dir?: string) => load(PricesConfig, "prices.yaml", dir);
export const loadProviders = (dir?: string) => load(ProvidersConfig, "providers.yaml", dir);
export const loadRooms = (dir?: string) => load(RoomsConfig, "rooms.yaml", dir);
export const loadRender = (dir?: string) => load(RenderConfig, "render.yaml", dir);
export const loadCatalog = (dir?: string) => load(CatalogConfig, "catalog.yaml", dir);
export const loadEscalation = (dir?: string) => load(EscalationConfig, "escalation.yaml", dir);
export const loadRechargeCopy = (locale: "es" | "en", dir?: string) =>
  load(RechargeCopy, `copy/recharge.${locale}.yaml`, dir);

export interface LiabilityText {
  locale: "es" | "en";
  version: number;
  /** Phrase the user must type to accept. */
  phrase: string;
  text: string;
}

/** Developer-mode liability clause (brief §5 M3). Its version must match the ToS clause (M15). */
export const loadLiabilityText = (locale: "es" | "en", dir = CONFIG_DIR): LiabilityText => {
  const raw = readFileSync(
    new URL(`legal/devmode-liability.${locale}.md`, `file://${dir.endsWith("/") ? dir : `${dir}/`}`),
    "utf8",
  );
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`devmode-liability.${locale}.md: missing front matter`);
  const meta = parse(match[1]!) as { version: number; toggle_phrase: string };
  return { locale, version: meta.version, phrase: meta.toggle_phrase, text: match[2]!.trim() };
};
