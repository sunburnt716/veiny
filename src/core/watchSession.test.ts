import { describe, expect, it } from "vitest";

import type {
  CommitComparison,
  ReportEntry,
  ReportSummary,
} from "./types.js";
import { compareCaughtToCommitted, summarizeReport } from "./watchSession.js";

describe("summarizeReport", () => {
  it("counts errors and warnings separately and counts UNIQUE affected files", () => {
    const report: ReportEntry[] = [
      {
        type: "typeCheck",
        data: [
          {
            filePath: "src/a.ts",
            line: 1,
            column: 1,
            message: "boom",
            code: 2322,
            category: "error",
            inChangedHunk: true,
          },
          {
            filePath: "src/a.ts",
            line: 2,
            column: 1,
            message: "another boom",
            code: 2345,
            category: "error",
            inChangedHunk: false,
          },
          {
            filePath: "src/b.ts",
            line: 5,
            column: 3,
            message: "careful",
            code: 6133,
            category: "warning",
            inChangedHunk: true,
          },
        ],
      },
      {
        type: "blastRadius",
        data: [
          // Duplicate affectedFile value "src/x.ts" reached via two different changed files.
          {
            affectedFile: "src/x.ts",
            changedFile: "src/a.ts",
            affectedSymbols: "all",
            precision: "file",
          },
          {
            affectedFile: "src/x.ts",
            changedFile: "src/b.ts",
            affectedSymbols: "all",
            precision: "file",
          },
          {
            affectedFile: "src/y.ts",
            changedFile: "src/a.ts",
            affectedSymbols: "all",
            precision: "file",
          },
        ],
      },
    ];

    const summary = summarizeReport(report);

    expect(summary).toEqual<ReportSummary>({
      errors: 2,
      warnings: 1,
      // "src/x.ts" appears twice but is counted once -> 2 unique affected files.
      affectedFiles: 2,
    });
  });

  it("returns all zeros for an empty report", () => {
    expect(summarizeReport([])).toEqual<ReportSummary>({
      errors: 0,
      warnings: 0,
      affectedFiles: 0,
    });
  });

  it("treats a missing blastRadius variant (typeCheck only) as zero affected files", () => {
    const report: ReportEntry[] = [
      {
        type: "typeCheck",
        data: [
          {
            filePath: "src/a.ts",
            line: 1,
            column: 1,
            message: "boom",
            code: 2322,
            category: "error",
            inChangedHunk: true,
          },
          {
            filePath: "src/a.ts",
            line: 9,
            column: 1,
            message: "warn",
            code: 6133,
            category: "warning",
            inChangedHunk: false,
          },
        ],
      },
    ];

    expect(summarizeReport(report)).toEqual<ReportSummary>({
      errors: 1,
      warnings: 1,
      affectedFiles: 0,
    });
  });

  it("treats a missing typeCheck variant (blastRadius only) as zero errors and warnings", () => {
    const report: ReportEntry[] = [
      {
        type: "blastRadius",
        data: [
          {
            affectedFile: "src/x.ts",
            changedFile: "src/a.ts",
            affectedSymbols: "all",
            precision: "file",
          },
        ],
      },
    ];

    expect(summarizeReport(report)).toEqual<ReportSummary>({
      errors: 0,
      warnings: 0,
      affectedFiles: 1,
    });
  });
});

describe("compareCaughtToCommitted", () => {
  it("puts every caught file in committedAndCaught on full overlap", () => {
    const caught = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const committed = ["src/c.ts", "src/b.ts", "src/a.ts"];

    const result = compareCaughtToCommitted(caught, committed);

    expect(result).toEqual<CommitComparison>({
      // Order follows caughtFiles, not committedFiles.
      committedAndCaught: ["src/a.ts", "src/b.ts", "src/c.ts"],
      caughtNotCommitted: [],
      allCaughtWereCommitted: true,
    });
  });

  it("splits caught files correctly on partial overlap", () => {
    const caught = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const committed = ["src/a.ts", "src/c.ts"];

    const result = compareCaughtToCommitted(caught, committed);

    expect(result).toEqual<CommitComparison>({
      committedAndCaught: ["src/a.ts", "src/c.ts"],
      caughtNotCommitted: ["src/b.ts"],
      allCaughtWereCommitted: false,
    });
  });

  it("puts everything in caughtNotCommitted when caught and committed are disjoint", () => {
    const caught = ["src/a.ts", "src/b.ts"];
    const committed = ["src/x.ts", "src/y.ts"];

    const result = compareCaughtToCommitted(caught, committed);

    expect(result).toEqual<CommitComparison>({
      committedAndCaught: [],
      caughtNotCommitted: ["src/a.ts", "src/b.ts"],
      allCaughtWereCommitted: false,
    });
  });

  it("de-duplicates caught files while preserving first-occurrence order", () => {
    // "src/a.ts" (committed) and "src/b.ts" (uncommitted) each appear twice.
    const caught = ["src/a.ts", "src/b.ts", "src/a.ts", "src/b.ts"];
    const committed = ["src/a.ts"];

    const result = compareCaughtToCommitted(caught, committed);

    expect(result).toEqual<CommitComparison>({
      committedAndCaught: ["src/a.ts"],
      caughtNotCommitted: ["src/b.ts"],
      allCaughtWereCommitted: false,
    });
  });

  it("treats empty caughtFiles as all-committed with empty result arrays", () => {
    const result = compareCaughtToCommitted([], ["src/a.ts", "src/b.ts"]);

    expect(result).toEqual<CommitComparison>({
      committedAndCaught: [],
      caughtNotCommitted: [],
      allCaughtWereCommitted: true,
    });
  });
});
