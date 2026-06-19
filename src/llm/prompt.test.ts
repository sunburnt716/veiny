import { describe, expect, it } from "vitest";

import type { FileDiff } from "../core/types.js";
import { buildAnalysisPrompt, formatDiffs } from "./prompt.js";
import type { AnalysisContext } from "./provider.js";

// A minimal but complete AnalysisContext. Individual tests override the fields they care about.
function makeContext(overrides: Partial<AnalysisContext> = {}): AnalysisContext {
  return {
    userContext: "This is a TypeScript CLI.",
    changedFiles: [
      {
        filePath: "src/a.ts",
        hunks: [{ startLine: 1, lineCount: 1 }],
        additions: ["export const value = 42;"],
        deletions: ["export const value = 41;"],
      },
    ],
    blastRadius: [
      {
        affectedFile: "src/consumer.ts",
        changedFile: "src/a.ts",
        affectedSymbols: "all",
        precision: "file",
      },
    ],
    imports: [
      {
        importer: "src/consumer.ts",
        imported: "src/a.ts",
        symbols: ["value"],
      },
    ],
    ...overrides,
  };
}

describe("buildAnalysisPrompt", () => {
  it("produces a system prompt mentioning the JSON schema and an only-JSON instruction", () => {
    const { system } = buildAnalysisPrompt(makeContext());

    // Schema mention: the result fields must appear so the model knows the contract.
    expect(system).toContain('"risks"');
    expect(system).toContain('"overallAssessment"');
    expect(system).toContain("severity");
    // Only-JSON instruction.
    expect(system).toContain("ONLY");
  });

  it("produces a user prompt with the four section labels and the changed-file content", () => {
    const { user } = buildAnalysisPrompt(makeContext());

    expect(user).toContain("PROJECT CONTEXT");
    expect(user).toContain("CHANGED FILES");
    expect(user).toContain("BLAST RADIUS");
    expect(user).toContain("IMPORT SEAMS");

    // The developer context and the actual diff content are carried into the user half.
    expect(user).toContain("This is a TypeScript CLI.");
    expect(user).toContain("export const value = 42;");
  });

  it("falls back to a placeholder when no project context is provided", () => {
    const { user } = buildAnalysisPrompt(makeContext({ userContext: "   " }));

    expect(user).toContain("(none provided)");
  });

  it("caps the response at 2048 tokens", () => {
    expect(buildAnalysisPrompt(makeContext()).maxTokens).toBe(2048);
  });
});

describe("formatDiffs", () => {
  it("renders a small diff in full with +/- prefixes", () => {
    const diffs: FileDiff[] = [
      {
        filePath: "src/small.ts",
        hunks: [],
        additions: ["const added = 1;"],
        deletions: ["const removed = 0;"],
      },
    ];

    const out = formatDiffs(diffs);

    expect(out).toContain("### src/small.ts");
    // Deletions are rendered first with a "-" prefix, additions with "+".
    expect(out).toContain("-const removed = 0;");
    expect(out).toContain("+const added = 1;");
    // A small diff is shown in full -> no truncation note.
    expect(out).not.toContain("more lines");
  });

  it("truncates a diff exceeding 60 combined lines with a '+N more lines' note", () => {
    // 40 deletions + 40 additions = 80 combined lines; cap is 60, so 20 are hidden.
    const deletions = Array.from({ length: 40 }, (_, i) => `old line ${i}`);
    const additions = Array.from({ length: 40 }, (_, i) => `new line ${i}`);
    const diffs: FileDiff[] = [
      { filePath: "src/big.ts", hunks: [], additions, deletions },
    ];

    const out = formatDiffs(diffs);

    expect(out).toContain("… +20 more lines");
    // The first shown lines are the deletions (rendered first).
    expect(out).toContain("-old line 0");
    // A line beyond the 60-line cap must NOT appear: deletions 0..39 then additions 0..19 are the
    // first 60; addition 39 is well past the cap.
    expect(out).not.toContain("+new line 39");
  });

  it("renders a placeholder when there are no changed files", () => {
    expect(formatDiffs([])).toBe("(no changed files)");
  });
});
