import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIAdapter } from "./openaiAdapter.js";
import type { LLMRequest } from "./provider.js";

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

describe("OpenAIAdapter.complete", () => {
  it("posts to ${baseURL}/chat/completions with a Bearer header and system+user messages", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        json: { choices: [{ message: { content: "hi" } }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter(
      "sk-openai",
      "gpt-test",
      "https://api.openai.com/v1",
    );
    const result = await adapter.complete(makeRequest());

    expect(result).toBe("hi");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");

    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-openai");

    const body: unknown = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "gpt-test",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "user prompt" },
      ],
    });
  });

  it("does not double-slash when baseURL has a trailing slash", async () => {
    const fetchMock = vi.fn(async () =>
      fakeResponse({
        ok: true,
        status: 200,
        json: { choices: [{ message: { content: "ok" } }] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAIAdapter(
      "k",
      "m",
      "https://api.openai.com/v1/",
    );
    await adapter.complete(makeRequest());

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("returns the first choice's message content on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({
          ok: true,
          status: 200,
          json: { choices: [{ message: { content: "the answer" } }] },
        }),
      ),
    );

    const adapter = new OpenAIAdapter("k", "m", "https://x/v1");
    expect(await adapter.complete(makeRequest())).toBe("the answer");
  });

  it("throws with the status in the message on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeResponse({ ok: false, status: 500, text: "server error" }),
      ),
    );

    const adapter = new OpenAIAdapter("k", "m", "https://x/v1");
    await expect(adapter.complete(makeRequest())).rejects.toThrow("500");
  });
});
