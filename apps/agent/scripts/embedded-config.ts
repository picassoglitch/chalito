/** packages/config files the agent reads at run time (@chalito/config readConfigFile): a compiled agent has
 * no packages/config on disk, so they travel inside it. */
export const EMBEDDED_CONFIG = [
  "providers.yaml",
  "sessions.yaml",
  "legal/devmode-liability.en.md",
  "legal/devmode-liability.es.md",
] as const;
/** The define rides on bun's command line: Windows caps that near 32 KB. */
export const EMBEDDED_CONFIG_MAX_BYTES = 24_000;

export const embeddedConfigDefine = (read: (file: string) => string): string => {
  const json = JSON.stringify(Object.fromEntries(EMBEDDED_CONFIG.map((f) => [f, read(f)])));
  if (Buffer.byteLength(json) > EMBEDDED_CONFIG_MAX_BYTES)
    throw new Error(`embedded config is ${Buffer.byteLength(json)} bytes, over ${EMBEDDED_CONFIG_MAX_BYTES}`);
  return json;
};
