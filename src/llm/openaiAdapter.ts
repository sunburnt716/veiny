/*
 * openaiAdapter.ts
 * ----------------
 * The OpenAI-compatible Chat Completions implementation of LLMProvider. Like the Anthropic adapter,
 * it owns transport only (URL, headers, body, response envelope) and returns the model's raw text —
 * never prompts, never parsing.
 *
 * Why one class covers many providers: the `/chat/completions` request/response shape is a de-facto
 * standard. By making `baseURL` configurable, this single adapter serves OpenAI, Ollama, Groq,
 * Together, OpenRouter, and any other OpenAI-compatible endpoint — without a new class each. The
 * factory in client.ts just passes a different baseURL.
 *
 * Dependency exception: uses the GLOBAL `fetch` only — the same explicit, spec-mandated exception as
 * the Anthropic adapter. No SDKs, no node-fetch, no axios.
 *
 * Depends on: LLMProvider, LLMRequest (./provider.js). No other Veiny modules.
 */

import type { LLMProvider, LLMRequest } from "./provider.js";

// Narrow view of the slice of the Chat Completions response we consume. We only model what we read:
// the first choice's message content. Both inner levels are optional because partial/edge responses
// can omit them; we validate before use.
interface OpenAIResponse {
  choices: Array<{ message?: { content?: string } }>;
}

export class OpenAIAdapter implements LLMProvider {
  // baseURL is what makes this class provider-portable (OpenAI, Ollama, Groq, …). All three fields
  // are captured at construction by the factory and never mutated; private to keep the key hidden.
  constructor(
    private apiKey: string,
    private model: string,
    private baseURL: string,
  ) {}

  /**
   * Sends one request to an OpenAI-compatible Chat Completions endpoint and returns the raw text.
   * Throws (never swallows) on non-2xx HTTP or on an unexpected response shape, always with a
   * descriptive message including status and/or a body snippet.
   */
  async complete(req: LLMRequest): Promise<string> {
    // Tolerate a user-supplied baseURL with or without a trailing slash so we never emit a
    // double-slashed URL (which some OpenAI-compatible servers, e.g. Ollama, reject).
    const base = this.baseURL.replace(/\/+$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        // The OpenAI shape carries the system prompt as the first message rather than a top-level
        // field (unlike Anthropic).
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
    });

    // Surface HTTP failures with the server's error body, which typically names the exact cause.
    if (!res.ok) {
      throw new Error(
        `OpenAI request failed (${res.status}): ${await res.text()}`,
      );
    }

    // Pin the `any` from res.json() to `unknown`, then validate before trusting.
    const data: unknown = await res.json();

    if (!this.isOpenAIResponse(data)) {
      const snippet = JSON.stringify(data).slice(0, 500);
      throw new Error(
        `OpenAI returned an unexpected response shape: ${snippet}`,
      );
    }

    // Shape is validated to have a non-empty choices array; still guard the optional inner fields.
    const first = data.choices[0];
    const content = first?.message?.content;
    if (typeof content !== "string") {
      const snippet = JSON.stringify(data).slice(0, 500);
      throw new Error(
        `OpenAI response missing message content: ${snippet}`,
      );
    }

    return content;
  }

  /**
   * Runtime guard narrowing `unknown` to OpenAIResponse: requires a non-empty `choices` array.
   * Inner message/content are validated separately in complete() so this stays a cheap shape check.
   */
  private isOpenAIResponse(value: unknown): value is OpenAIResponse {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const choices = (value as { choices?: unknown }).choices;
    return Array.isArray(choices) && choices.length > 0;
  }
}
