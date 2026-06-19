import { describe, expect, it } from "vitest";

import { runHeuristicAnalysis } from "./analyze.js";
import type {
  AnalysisContext,
  AnalysisResult,
  LLMProvider,
  LLMRequest,
} from "./provider.js";

function makeContext(): AnalysisContext {
  return {
    userContext: "A TypeScript CLI.",
    changedFiles: [
      {
        filePath: "src/a.ts",
        hunks: [{ startLine: 1, lineCount: 1 }],
        additions: ["export const value = 42;"],
        deletions: [],
      },
    ],
    blastRadius: [],
    imports: [],
  };
}

// A fake provider that records the request it was handed and returns a canned JSON string. This is
// the whole point of analyze.ts taking the LLMProvider interface: the pipeline runs with zero
// network and no API key.
class FakeProvider implements LLMProvider {
  public lastRequest: LLMRequest | null = null;
  constructor(private readonly canned: string) {}
  async complete(req: LLMRequest): Promise<string> {
    this.lastRequest = req;
    return this.canned;
  }
}

describe("runHeuristicAnalysis", () => {
  it("returns the parsed AnalysisResult from the provider's canned response", async () => {
    const expected: AnalysisResult = {
      risks: [
        {
          severity: "medium",
          file: "src/a.ts",
          summary: "Value changed",
          reasoning: "Downstream consumers may rely on the old constant.",
        },
      ],
      overallAssessment: "Low overall risk.",
    };
    const provider = new FakeProvider(JSON.stringify(expected));

    const result = await runHeuristicAnalysis(makeContext(), provider);

    expect(result).toEqual(expected);
  });

  it("passes a built prompt (system + user + maxTokens) to the provider", async () => {
    const provider = new FakeProvider(
      JSON.stringify({ risks: [], overallAssessment: "No risks." }),
    );

    await runHeuristicAnalysis(makeContext(), provider);

    expect(provider.lastRequest).not.toBeNull();
    const req = provider.lastRequest as LLMRequest;
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.user).toContain("CHANGED FILES");
    expect(req.maxTokens).toBe(2048);
  });

  it("propagates a parse error when the provider returns unparseable text", async () => {
    const provider = new FakeProvider("not json at all");

    await expect(runHeuristicAnalysis(makeContext(), provider)).rejects.toThrow();
  });

  it("propagates a transport error thrown by the provider", async () => {
    class FailingProvider implements LLMProvider {
      async complete(): Promise<string> {
        throw new Error("network down");
      }
    }

    await expect(
      runHeuristicAnalysis(makeContext(), new FailingProvider()),
    ).rejects.toThrow("network down");
  });
});
