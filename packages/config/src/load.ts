import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { z } from "zod";
import { PlansConfig } from "@chalito/protocol";
import { CatalogConfig, ModelsConfig, PricesConfig, ProvidersConfig, RenderConfig, RoomsConfig } from "./schemas.js";

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
