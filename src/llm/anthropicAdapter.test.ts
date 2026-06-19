import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicAdapter } from "./anthropicAdapter.js";
import type { LLMRequest } from "./provider.js";

// Build a minimal object that satisfies the parts of Response the adapter reads. Casting through
// `unknown` (never `any`) is the allowed escape hatch for a hand-rolled fetch stub.
function fakeResponse(opts: {
  ok: boolean;
  status: number;
  json?: unknown;
  text?: string;
}): Response {
  return {
    ok: opts.ok,
    status: opts.status,
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

function makeRequest(): LLMRequest {
  return { system: "system prompt", user: "user prompt", maxTokens: 2048 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AnthropicAdapter.complete", () => {
  it("sends a correctly shaped request to the Anthropic messages endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        json: { content: [{ type: "text", text: "hi" }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AnthropicAdapter("sk-test-key", "claude-test");
    const result = await adapter.complete(makeRequest());

    expect(result).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");

    // Headers include the Anthropic auth + version headers.
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    // Body carries model / max_tokens / system / messages.
    const body: unknown = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: 2048,
      system: "system prompt",
      messages: [{ role: "user", content: "user prompt" }],
    });
  });

  it("returns the first content block's text on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          json: { content: [{ type: "text", text: "the answer" }] },
        }),
      ),
    );

    const adapter = new AnthropicAdapter("k", "m");
    expect(await adapter.complete(makeRequest())).toBe("the answer");
  });

  it("throws with the status in the message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({ ok: false, status: 401, text: "invalid key" }),
      ),
    );

    const adapter = new AnthropicAdapter("bad-key", "m");
    await expect(adapter.complete(makeRequest())).rejects.toThrow("401");
  });
});
