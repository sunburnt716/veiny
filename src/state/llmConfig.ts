/*
 * llmConfig.ts
 * ------------
 * Sole owner of .agent/llmConfig.json — the persisted choice of whether LLM heuristic analysis is
 * enabled and, if so, which provider/model/baseURL to use.
 *
 * Like credentials.ts, this is an approved deviation from "all .agent/ I/O goes through
 * agentState.ts": each of these state files has a single distinct concern and owns its own file.
 * This module never touches credentials.json directly — it delegates key handling to credentials.ts.
 *
 * The exported LLMConfig is intentionally structurally compatible with ProviderConfig in
 * llm/client.ts (same provider / model / baseURL fields), so a saved config can be handed straight
 * to getProvider() with no adapter or cast — the only extra field here is `enabled`, which the
 * factory ignores.
 *
 * Path discipline: every path is derived from repoRoot via path.join; nothing is hardcoded.
 *
 * Depends on: Node built-ins (node:fs, node:path, node:process, node:readline/promises) and the
 * key helpers in ./credentials.js (loadApiKey, promptForApiKey, saveApiKey). No network here:
 * promptForLLM only gathers + persists configuration, it never runs analysis.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import * as readline from "node:readline/promises";
import { loadApiKey, promptForApiKey, saveApiKey } from "./credentials.js";

// Canonical .agent/ layout for the LLM config file.
const AGENT_DIR = ".agent";
const LLM_CONFIG_FILE = "llmConfig.json";

// Interactive defaults.
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";
const DEFAULT_OPENAI_MODEL = "gpt-4o";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * The on-disk shape of .agent/llmConfig.json.
 *
 * Structurally compatible with ProviderConfig (llm/client.ts): provider/model/baseURL line up
 * exactly, so getProvider(config, apiKey) accepts an LLMConfig directly. `enabled` is the extra bit
 * the watch loop reads to decide whether to invoke the LLM at all. `baseURL` is always present even
 * for anthropic (where it is unused, set to "") to keep the shape stable.
 */
export interface LLMConfig {
  enabled: boolean;
  provider: "anthropic" | "openai";
  model: string;
  baseURL: string;
}

// --- Path helpers (derived from repoRoot, never hardcoded) ---------------------------------------

function agentDir(repoRoot: string): string {
  return path.join(repoRoot, AGENT_DIR);
}

function llmConfigPath(repoRoot: string): string {
  return path.join(agentDir(repoRoot), LLM_CONFIG_FILE);
}

// --- Defensive narrowing -------------------------------------------------------------------------

/**
 * Narrows an arbitrary parsed JSON value to a valid LLMConfig, or null if it does not match the
 * expected shape. No `any`: accept `unknown`, narrow with explicit type guards.
 */
function asLLMConfig(value: unknown): LLMConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    enabled?: unknown;
    provider?: unknown;
    model?: unknown;
    baseURL?: unknown;
  };
  // Narrow `provider` inline (not via an intermediate boolean) so the compiler tracks the union
  // type through to the return below.
  if (
    typeof candidate.enabled === "boolean" &&
    (candidate.provider === "anthropic" || candidate.provider === "openai") &&
    typeof candidate.model === "string" &&
    typeof candidate.baseURL === "string"
  ) {
    return {
      enabled: candidate.enabled,
      provider: candidate.provider,
      model: candidate.model,
      baseURL: candidate.baseURL,
    };
  }
  return null;
}

// --- Public API ----------------------------------------------------------------------------------

/**
 * writeLLMConfig: persist the LLM configuration. Creates .agent/ if needed and writes
 * .agent/llmConfig.json as pretty JSON with a trailing newline (matching the project's on-disk
 * format). This is the single place llmConfig.json is written.
 */
export function writeLLMConfig(repoRoot: string, config: LLMConfig): void {
  mkdirSync(agentDir(repoRoot), { recursive: true });
  writeFileSync(
    llmConfigPath(repoRoot),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

/**
 * readLLMConfig: load the LLM configuration, or null if it is absent.
 *
 * Parsed defensively: corrupt JSON or an invalid shape logs a descriptive warning and returns null
 * (the caller treats a missing/invalid config the same — LLM analysis simply stays off) rather than
 * crashing the watch loop.
 */
export function readLLMConfig(repoRoot: string): LLMConfig | null {
  const file = llmConfigPath(repoRoot);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const config = asLLMConfig(parsed);
    if (config !== null) {
      return config;
    }
    console.warn(
      `Warning: ${file} did not contain a valid LLM config; ignoring it.`,
    );
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: could not parse ${file}; ignoring it. ${message}`);
    return null;
  }
}

/**
 * promptForLLM: the init-time step that asks the developer whether to enable LLM analysis and, if
 * so, gathers provider/model/baseURL and resolves an API key. It WRITES the resulting config (and,
 * if needed, the key) but performs NO analysis and returns void.
 *
 * Flow:
 *   - Decline (anything other than y/yes) → write a disabled config and return.
 *   - Accept → ask provider (default anthropic), model (provider-specific default), and — for
 *     openai only — baseURL (default the public endpoint; anthropic's baseURL stays "").
 *   - Resolve the key via loadApiKey (env/file). Only if that is null do we prompt (no echo) and
 *     save it. A key already found in env/file is neither re-prompted nor re-saved.
 *
 * The readline interface is always closed in a finally so stdin is released even on error.
 */
export async function promptForLLM(repoRoot: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const enableAnswer = (
      await rl.question(
        "Would you like to enable LLM heuristic analysis? (y/n): ",
      )
    )
      .trim()
      .toLowerCase();

    // Declined: persist a disabled config and stop. baseURL/model are empty placeholders.
    if (enableAnswer !== "y" && enableAnswer !== "yes") {
      writeLLMConfig(repoRoot, {
        enabled: false,
        provider: "anthropic",
        model: "",
        baseURL: "",
      });
      return;
    }

    // --- Provider: default anthropic; "openai" selects openai, anything else falls back. ----------
    const providerAnswer = (
      await rl.question("Which provider? (anthropic/openai) [anthropic]: ")
    )
      .trim()
      .toLowerCase();
    const provider: LLMConfig["provider"] =
      providerAnswer === "openai" ? "openai" : DEFAULT_PROVIDER;

    // --- Model + baseURL: provider-specific defaults. --------------------------------------------
    let model: string;
    let baseURL: string;

    if (provider === "anthropic") {
      const modelAnswer = (
        await rl.question(`Model [${DEFAULT_ANTHROPIC_MODEL}]: `)
      ).trim();
      model = modelAnswer.length > 0 ? modelAnswer : DEFAULT_ANTHROPIC_MODEL;
      // Anthropic's baseURL is unused by the adapter; keep it "" for a stable shape.
      baseURL = "";
    } else {
      const modelAnswer = (
        await rl.question(`Model [${DEFAULT_OPENAI_MODEL}]: `)
      ).trim();
      model = modelAnswer.length > 0 ? modelAnswer : DEFAULT_OPENAI_MODEL;

      const baseURLAnswer = (
        await rl.question(`Base URL [${DEFAULT_OPENAI_BASE_URL}]: `)
      ).trim();
      baseURL =
        baseURLAnswer.length > 0 ? baseURLAnswer : DEFAULT_OPENAI_BASE_URL;
    }

    // --- API key: prefer an existing env/file key; only prompt + save if none is found. ----------
    const existingKey = loadApiKey(repoRoot);
    if (existingKey === null) {
      const enteredKey = await promptForApiKey();
      saveApiKey(repoRoot, enteredKey);
    }

    // --- Persist the enabled config. -------------------------------------------------------------
    writeLLMConfig(repoRoot, {
      enabled: true,
      provider,
      model,
      baseURL,
    });
  } finally {
    // Always release stdin, even if a question rejected.
    rl.close();
  }
}
