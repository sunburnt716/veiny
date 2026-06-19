/*
 * anthropicAdapter.ts
 * -------------------
 * The Anthropic Messages API implementation of LLMProvider. One class = one provider's transport.
 * It knows the Anthropic URL, headers, request body shape, and response envelope — and NOTHING about
 * prompts or parsing. It receives a fully-built LLMRequest and returns the model's raw text; turning
 * that text into typed data is parse.ts's job.
 *
 * Dependency exception: this file uses the GLOBAL `fetch` (Node 18+). That is the single, explicit,
 * spec-mandated exception to Veiny's "no external deps" rule. We deliberately do NOT pull in the
 * @anthropic-ai SDK, node-fetch, or axios — a thin hand-rolled adapter keeps the dependency surface
 * at zero and the wire contract visible in one place.
 *
 * Depends on: LLMProvider, LLMRequest (./provider.js). No other Veiny modules.
 */

import type { LLMProvider, LLMRequest } from "./provider.js";

// Narrow view of the slice of Anthropic's response we actually consume. We do NOT model the whole
// envelope — only what we read — so the shape check stays tight. `text` is optional because some
// content blocks (e.g. tool_use) carry no text; we validate it is present before use.
interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

export class AnthropicAdapter implements LLMProvider {
  // apiKey and model are captured at construction (by the factory in client.ts) and never mutated.
  // Private so callers stay provider-blind and can't reach in to read the key.
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  /**
   * Sends one request to Anthropic's Messages API and returns the model's raw text.
   * Throws (never swallows) on transport/HTTP failure or on an unexpected response shape, always
   * with a descriptive message that includes the status and/or a body snippet for debugging.
   */
  async complete(req: LLMRequest): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens,
        system: req.system,
        // Anthropic puts the system prompt in its own top-level field; only the user turn goes in
        // `messages`.
        messages: [{ role: "user", content: req.user }],
      }),
    });

    // Surface HTTP failures loudly with the server's own error body — that text usually names the
    // exact problem (bad key, unknown model, rate limit).
    if (!res.ok) {
      throw new Error(
        `Anthropic request failed (${res.status}): ${await res.text()}`,
      );
    }

    // res.json() is typed `any`; pin it to `unknown` so nothing untyped leaks, then validate the
    // shape before trusting it.
    const data: unknown = await res.json();

    if (!this.isAnthropicResponse(data)) {
      // Include a bounded snippet of the raw body so the unexpected shape is debuggable without
      // dumping a potentially huge payload into the error.
      const snippet = JSON.stringify(data).slice(0, 500);
      throw new Error(
        `Anthropic returned an unexpected response shape: ${snippet}`,
      );
    }

    // Shape is validated: first content block exists and has a string `text`.
    const first = data.content[0];
    if (first === undefined || typeof first.text !== "string") {
      const snippet = JSON.stringify(data).slice(0, 500);
      throw new Error(
        `Anthropic response missing text content: ${snippet}`,
      );
    }

    return first.text;
  }

  /**
   * Runtime guard narrowing `unknown` to AnthropicResponse: requires a non-empty `content` array.
   * Kept as a method (not inline) so the validation logic reads clearly and stays free of `any`.
   */
  private isAnthropicResponse(value: unknown): value is AnthropicResponse {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const content = (value as { content?: unknown }).content;
    return Array.isArray(content) && content.length > 0;
  }
}
