import { keyEnvAllowed, unsafeLaunchArg } from "./policy.js";

/**
 * The part of a Chalito app recipe (engine contract §1, `packages/protocol/src/recipe.ts`) the
 * ACP driver reads. Structural on purpose: the engine's zod `Recipe` satisfies it, and so do the
 * built-in configs below.
 */
export interface AcpRecipe {
  /** Recipe id (`^[a-z0-9][a-z0-9-]{1,40}$`): "grok", "gemini", "goose", … */
  readonly id: string;
  /** Product name, for messages. */
  readonly name: string;
  /** Where a BYO API key goes: the variable the agent reads it from. */
  readonly apiKey?: { readonly env: string } | undefined;
  readonly driver: {
    readonly acp?:
      | {
          /** argv of the ACP server: `command[0]` is the CLI (replaced by its pinned path), the rest its args. */
          readonly command: readonly string[];
          /**
           * ACP `authenticate` method ids Chalito may send with an API key, in order of preference.
           * Never used for sign-in: a session relies on the person's own login in the CLI.
           */
          readonly authMethods?: readonly string[] | undefined;
        }
      | undefined;
  };
}

const RECIPE_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Why `recipe` can't drive an ACP session, or null when it can. */
export const acpRecipeProblem = (recipe: AcpRecipe): string | null => {
  if (!RECIPE_ID.test(recipe.id)) return `invalid recipe id "${recipe.id}"`;
  const acp = recipe.driver.acp;
  if (!acp) return `${recipe.name} has no ACP driver`;
  if (acp.command.length === 0 || !acp.command[0]) return `${recipe.name}'s ACP command is empty`;
  const bad = unsafeLaunchArg(acp.command.slice(1));
  if (bad) return `${recipe.name}'s ACP command has "${bad}", which skips Chalito's approvals`;
  if (recipe.apiKey && !keyEnvAllowed(recipe.apiKey.env))
    return `${recipe.name}'s API key variable "${recipe.apiKey.env}" isn't allowed`;
  for (const m of acp.authMethods ?? [])
    if (!/^[\w.:-]{1,64}$/.test(m)) return `${recipe.name}'s auth method "${m}" isn't allowed`;
  return null;
};

/**
 * ACP launch configs for the agents Chalito knows, keyed by recipe id. The curated catalog's
 * recipes carry the same `driver.acp` (the engine's `recipes/` folder); these keep the existing
 * `grok` / `gemini` adapters working before a catalog is loaded, and the tests pin them.
 * Checked versions are noted per entry (VERIFIED = run against that version).
 */
export const BUILTIN_ACP_RECIPES = {
  /** VERIFIED: @xai-official/grok 1.0.46 (`grok agent stdio`, D-062). `--sandbox` is added per mode. */
  grok: {
    id: "grok",
    name: "Grok Build",
    apiKey: { env: "XAI_API_KEY" },
    driver: {
      acp: { command: ["grok", "--no-auto-update", "agent", "--no-leader", "stdio"], authMethods: ["xai.api_key"] },
    },
  },
  /** VERIFIED: @google/gemini-cli 0.61.0 (`gemini --acp`, D-062). The key goes in authenticate `_meta`, not the env. */
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    apiKey: { env: "GEMINI_API_KEY" },
    driver: { acp: { command: ["gemini", "--acp", "--approval-mode", "default"], authMethods: ["gemini-api-key"] } },
  },
  /** VERIFIED: opencode-ai 1.18.34 (`opencode acp`). Uses its own sign-in or provider config; preset makes every tool ask. */
  opencode: {
    id: "opencode",
    name: "OpenCode",
    driver: { acp: { command: ["opencode", "acp"] } },
  },
  /** VERIFIED: goose 1.53.0 release binary (`goose acp`). Provider and key come from `goose configure`. */
  goose: {
    id: "goose",
    name: "Goose",
    driver: { acp: { command: ["goose", "acp"] } },
  },
  /** VERIFIED: @qwen-code/qwen-code 0.25.0 (`qwen --acp`); API key = OpenAI-compatible key, auth method `openai`. */
  "qwen-code": {
    id: "qwen-code",
    name: "Qwen Code",
    apiKey: { env: "OPENAI_API_KEY" },
    driver: { acp: { command: ["qwen", "--acp", "--approval-mode", "default"], authMethods: ["openai"] } },
  },
  /**
   * VERIFIED handshake only: @github/copilot 1.0.92 (`copilot --acp`; sign-in `copilot login`).
   * Its approval commands (/allow-all, /permissions, /autopilot, /reset-allowed-tools, /sandbox)
   * are refused by the generic policy. UNVERIFIED: whether every tool asks over ACP by default.
   */
  "copilot-cli": {
    id: "copilot-cli",
    name: "GitHub Copilot CLI",
    driver: { acp: { command: ["copilot", "--acp"] } },
  },
  /** VERIFIED handshake: Mistral Vibe 2.25.8 (`vibe-acp`), key in MISTRAL_API_KEY; preset holds the `ask` mode. */
  "mistral-vibe": {
    id: "mistral-vibe",
    name: "Mistral Vibe",
    apiKey: { env: "MISTRAL_API_KEY" },
    driver: { acp: { command: ["vibe-acp"] } },
  },
} as const satisfies Record<string, AcpRecipe>;
