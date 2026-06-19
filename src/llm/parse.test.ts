import { describe, expect, it } from "vitest";

import { parseAnalysisResponse } from "./parse.js";
import type { AnalysisResult } from "./provider.js";

// A canonical, well-formed result used across the happy-path variants.
const RESULT: AnalysisResult = {
  risks: [
    {
      severity: "high",
      file: "src/a.ts",
      summary: "Removed export still imported elsewhere",
      reasoning: "consumer.ts imports `thing` which no longer exists.",
    },
  ],
  overallAssessment: "One blocking risk; resolve before committing.",
};

describe("parseAnalysisResponse", () => {
  it("parses plain JSON into an AnalysisResult", () => {
    const raw = JSON.stringify(RESULT);

    expect(parseAnalysisResponse(raw)).toEqual(RESULT);
  });

  it("strips ```json code fences before parsing", () => {
    const raw = ["```json", JSON.stringify(RESULT, null, 2), "```"].join("\n");

    expect(parseAnalysisResponse(raw)).toEqual(RESULT);
  });

  it("tolerates surrounding prose and whitespace around the JSON", () => {
    // Models sometimes wrap the object in bare ``` fences and chatty text. After fence stripping +
    // trim, the remaining content is just the JSON object, so it parses.
    const raw = [
      "  ",
      "```",
      JSON.stringify(RESULT),
      "```",
      "  ",
    ].join("\n");

    expect(parseAnalysisResponse(raw)).toEqual(RESULT);
  });

  it("throws on malformed input and embeds the raw output in the message", () => {
    const raw = "this is not json at all { oops";

    expect(() => parseAnalysisResponse(raw)).toThrow();
    // The full raw output must be present in the thrown message for debuggability.
    try {
      parseAnalysisResponse(raw);
      throw new Error("expected parseAnalysisResponse to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(raw);
    }
  });
});
