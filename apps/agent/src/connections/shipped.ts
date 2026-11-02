import { readConfigFile } from "@chalito/config";
import { loadBuiltinConnectors, type ConnectorCatalog } from "./catalog.js";

// Kept out of catalog.ts: @chalito/config resolves files at import, which the panel's jsdom tests can't load.
export const shippedConnectors = (): ConnectorCatalog => loadBuiltinConnectors(readConfigFile("connectors.yaml"));
