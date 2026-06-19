import { describe, expect, it } from "vitest";

import { AnthropicAdapter } from "./anthropicAdapter.js";
import { getProvider, type ProviderConfig } from "./client.js";
import { OpenAIAdapter } from "./openaiAdapter.js";

describe("getProvider", () => {
  it("returns an AnthropicAdapter (an LLMProvider) for the anthropic provider", () => {
    const config: ProviderConfig = {
      provider: "anthropic",
      model: "claude-test",
      baseURL: "",
    };

    const provider = getProvider(config, "sk-test");

    expect(provider).toBeInstanceOf(AnthropicAdapter);
    expect(typeof provider.complete).toBe("function");
  });

  it("returns an OpenAIAdapter (an LLMProvider) for the openai provider", () => {
    const config: ProviderConfig = {
      provider: "openai",
      model: "gpt-test",
      baseURL: "https://api.openai.com/v1",
    };

    const provider = getProvider(config, "sk-test");

    expect(provider).toBeInstanceOf(OpenAIAdapter);
    expect(typeof provider.complete).toBe("function");
  });

  it("throws naming the bad provider for an unknown provider value", () => {
    // Construct an invalid config via a cast through `unknown` (never `any`) so we can exercise the
    // runtime exhaustiveness guard without breaking the compile-time union.
    const badConfig = {
      provider: "gemini",
      model: "x",
      baseURL: "",
    } as unknown as ProviderConfig;

    expect(() => getProvider(badConfig, "sk-test")).toThrow("gemini");
  });
});
