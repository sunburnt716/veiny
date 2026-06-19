import { describe, expect, it } from "vitest";

import { formatReportMarkdown } from "./report.js";
import type { AnalysisResult } from "./provider.js";

describe("formatReportMarkdown", () => {
  it("includes each risk's file and summary plus the overall assessment", () => {
    const result: AnalysisResult = {
      risks: [
        {
          severity: "high",
          file: "src/a.ts",
          summary: "Removed export still imported",
          reasoning: "consumer.ts imports `thing` which no longer exists.",
        },
        {
          severity: "low",
          file: "src/b.ts",
          summary: "Renamed local variable",
          reasoning: "No external consumers affected.",
        },
      ],
      overallAssessment: "One blocking risk; resolve before committing.",
    };

    const md = formatReportMarkdown(result);

    // Each risk's file and summary appear.
    expect(md).toContain("src/a.ts");
    expect(md).toContain("Removed export still imported");
    expect(md).toContain("src/b.ts");
    expect(md).toContain("Renamed local variable");
    // Reasoning is rendered too.
    expect(md).toContain("consumer.ts imports `thing` which no longer exists.");
    // The overall assessment closes the report.
    expect(md).toContain("One blocking risk; resolve before committing.");
  });

  it("renders a no-risks notice and still includes the overall assessment", () => {
    const result: AnalysisResult = {
      risks: [],
      overallAssessment: "Nothing concerning in this change.",
    };

    const md = formatReportMarkdown(result);

    expect(md).toContain("No risks identified");
    expect(md).toContain("Nothing concerning in this change.");
  });
});
