/*
 * client.ts
 * ---------
 * The provider factory. Given a config + an API key, it returns the right concrete adapter typed as
 * the LLMProvider INTERFACE — so every caller (analyze.ts and beyond) stays provider-blind. This is
 * the only file that knows which concrete classes exist; adding a new provider means adding a case
 * here and a new adapter, nothing else changes.
 *
 * Why a local ProviderConfig instead of importing LLMConfig: state/llmConfig.ts is not built yet,
 * and depending on it now would create a forward/circular reference (state will eventually read this
 * layer's outputs). We declare the minimal structural shape the factory needs right here. When
 * state/llmConfig.ts lands, its `LLMConfig` will be structurally compatible with this interface, so
 * callers can pass it directly with no adapter or cast.
 *
 * Depends on: LLMProvider (./provider.js), AnthropicAdapter (./anthropicAdapter.js),
 * OpenAIAdapter (./openaiAdapter.js). No network, no I/O.
 */

import { AnthropicAdapter } from "./anthropicAdapter.js";
import { OpenAIAdapter } from "./openaiAdapter.js";
import type { LLMProvider } from "./provider.js";

/**
 * The minimal config shape getProvider needs. Exported so callers (and the future
 * state/llmConfig.ts) can reference exactly this contract. `baseURL` is required even for Anthropic
 * (where it is unused) to keep the structural shape stable and predictable; the future LLMConfig
 * will simply always carry one.
 */
export interface ProviderConfig {
  provider: "anthropic" | "openai";
  model: string;
  baseURL: string;
}

/**
 * Selects and constructs the concrete adapter for the configured provider, returned as LLMProvider.
 *
 * Returning the interface (not the concrete class) is the whole point: downstream code can never
 * accidentally couple to Anthropic- or OpenAI-specific behavior.
 *
 * The switch is exhaustive over ProviderConfig["provider"]. The `default` branch narrows the value
 * to `never` (so adding a new union member without handling it becomes a COMPILE error), and at
 * runtime throws a descriptive error naming the bad provider rather than silently returning nothing.
 */
export function getProvider(
  llmConfig: ProviderConfig,
  apiKey: string,
): LLMProvider {
  switch (llmConfig.provider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey, llmConfig.model);
    case "openai":
      return new OpenAIAdapter(apiKey, llmConfig.model, llmConfig.baseURL);
    default: {
      // Exhaustiveness guard: if every case above is handled, `llmConfig.provider` is `never` here.
      // This catches both an unhandled future union member (compile time) and a malformed config
      // value at runtime, without ever introducing `any`.
      const unknownProvider: never = llmConfig.provider;
      throw new Error(`Unknown LLM provider: ${String(unknownProvider)}`);
    }
  }
}
