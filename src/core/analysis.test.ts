import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigSnapshot } from "../commands/init.js";
import { writeDependencyMaps } from "../state/agentState.js";
import { blastRadiusCheck, runDiffAnalysis, typeCheckAnalysis } from "./analysis.js";
import type {
  BlastRadiusEntry,
  DependentMap,
  Diagnostic,
  FileDiff,
  ReportEntry,
} from "./types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-analysis-")));
  tempDirs.push(dir);
  return dir;
}

// A complete-but-empty ConfigSnapshot for tests that don't exercise config — runDiffAnalysis
// reserves `config` for the future symbol pass, so its contents are irrelevant to v1.
function emptyConfig(): ConfigSnapshot {
  return {
    nodeVersion: process.version,
    packageManager: "unknown",
    languageSpecificConfigs: {},
    pathAliasses: {},
    packageManagerSettings: {},
    workspaces: [],
  };
}

// Minimal tsconfig that needs no external @types: no "types" field, skipLibCheck on. Anything in
// the temp dir's root is included so the temp source files are part of the Program.
function writeTsconfig(repoRoot: string): void {
  writeFileSync(
    path.join(repoRoot, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        module: "nodenext",
        target: "esnext",
        skipLibCheck: true,
      },
      include: ["*.ts"],
    }),
    "utf8",
  );
}

function write(dir: string, relativePath: string, contents: string): string {
  const full = path.join(dir, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return full;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("blastRadiusCheck", () => {
  it("emits a file-level entry for each importer of a changed file", () => {
    const dependentMap: DependentMap = {
      "src/lib.ts": ["src/a.ts", "src/b.ts"],
    };

    const entries = blastRadiusCheck(["src/lib.ts"], dependentMap);

    expect(entries).toHaveLength(2);
    const byAffected = [...entries].sort((x, y) =>
      x.affectedFile.localeCompare(y.affectedFile),
    );
    expect(byAffected).toEqual<BlastRadiusEntry[]>([
      {
        affectedFile: "src/a.ts",
        changedFile: "src/lib.ts",
        affectedSymbols: "all",
        precision: "file",
      },
      {
        affectedFile: "src/b.ts",
        changedFile: "src/lib.ts",
        affectedSymbols: "all",
        precision: "file",
      },
    ]);
  });

  it("contributes nothing for a changed file with no importers", () => {
    const dependentMap: DependentMap = {
      "src/lib.ts": ["src/a.ts"],
    };

    // "src/orphan.ts" is not a key in the map -> nobody imports it -> no entries.
    const entries = blastRadiusCheck(["src/orphan.ts"], dependentMap);

    expect(entries).toEqual([]);
  });

  it("only includes importers for the files that were actually changed", () => {
    const dependentMap: DependentMap = {
      "src/lib.ts": ["src/a.ts"],
      "src/other.ts": ["src/z.ts"],
    };

    const entries = blastRadiusCheck(["src/lib.ts"], dependentMap);

    expect(entries).toEqual<BlastRadiusEntry[]>([
      {
        affectedFile: "src/a.ts",
        changedFile: "src/lib.ts",
        affectedSymbols: "all",
        precision: "file",
      },
    ]);
  });

  it("returns [] for empty inputs", () => {
    expect(blastRadiusCheck([], {})).toEqual([]);
    expect(blastRadiusCheck(["src/lib.ts"], {})).toEqual([]);
    expect(blastRadiusCheck([], { "src/lib.ts": ["src/a.ts"] })).toEqual([]);
  });
});

describe("typeCheckAnalysis", () => {
  it("reports a diagnostic in a changed file with inChangedHunk true when the hunk covers the error line", () => {
    const repoRoot = makeTempDir();
    writeTsconfig(repoRoot);
    // Line 1 is the type error (TS2322): a string assigned to a number.
    write(repoRoot, "bad.ts", 'export const n: number = "not a number";\n');

    const diffs: FileDiff[] = [
      {
        filePath: "bad.ts",
        hunks: [{ startLine: 1, lineCount: 1 }],
        additions: ['export const n: number = "not a number";'],
        deletions: [],
      },
    ];

    const diagnostics = typeCheckAnalysis(diffs, repoRoot);

    const diag = diagnostics.find((d) => d.filePath === "bad.ts");
    expect(diag).toBeDefined();
    const found = diag as Diagnostic;
    expect(found.filePath).toBe("bad.ts");
    expect(found.code).toBe(2322);
    expect(found.category).toBe("error");
    expect(found.line).toBe(1);
    expect(found.column).toBeGreaterThanOrEqual(1);
    expect(found.inChangedHunk).toBe(true);
  });

  it("still returns the diagnostic but flags inChangedHunk false when the hunk does not cover the error line", () => {
    const repoRoot = makeTempDir();
    writeTsconfig(repoRoot);
    // The error is on line 1; the staged hunk lands far away on line 50.
    write(repoRoot, "bad.ts", 'export const n: number = "not a number";\n');

    const diffs: FileDiff[] = [
      {
        filePath: "bad.ts",
        hunks: [{ startLine: 50, lineCount: 2 }],
        additions: [],
        deletions: [],
      },
    ];

    const diagnostics = typeCheckAnalysis(diffs, repoRoot);

    const diag = diagnostics.find((d) => d.filePath === "bad.ts");
    expect(diag).toBeDefined();
    const found = diag as Diagnostic;
    expect(found.code).toBe(2322);
    // inChangedHunk is a flag, not a filter: the diagnostic survives but is not in a hunk.
    expect(found.inChangedHunk).toBe(false);
  });

  it("drops diagnostics in files that are not part of the staged diff", () => {
    const repoRoot = makeTempDir();
    writeTsconfig(repoRoot);
    // Two files each with an error; only the first is in the diff.
    write(repoRoot, "changed.ts", 'export const a: number = "nope";\n');
    write(repoRoot, "untouched.ts", 'export const b: number = "also nope";\n');

    const diffs: FileDiff[] = [
      {
        filePath: "changed.ts",
        hunks: [{ startLine: 1, lineCount: 1 }],
        additions: ['export const a: number = "nope";'],
        deletions: [],
      },
    ];

    const diagnostics = typeCheckAnalysis(diffs, repoRoot);

    expect(diagnostics.some((d) => d.filePath === "changed.ts")).toBe(true);
    expect(diagnostics.some((d) => d.filePath === "untouched.ts")).toBe(false);
  });
});

describe("runDiffAnalysis", () => {
  it("returns a typeCheck then blastRadius envelope, fills blast radius from the map, and writes report.json", () => {
    const repoRoot = makeTempDir();
    writeTsconfig(repoRoot);
    // A clean changed file (no type errors) so typeCheck data is empty.
    write(repoRoot, "lib.ts", "export const value = 42;\n");
    write(repoRoot, "consumer.ts", 'import { value } from "./lib.js";\nexport const x = value;\n');

    // consumer.ts imports lib.ts -> dependentMap records lib.ts is imported by consumer.ts.
    writeDependencyMaps(repoRoot, {
      dependencyMap: { "consumer.ts": ["lib.ts"], "lib.ts": [] },
      dependentMap: { "lib.ts": ["consumer.ts"] },
    });

    const diffs: FileDiff[] = [
      {
        filePath: "lib.ts",
        hunks: [{ startLine: 1, lineCount: 1 }],
        additions: ["export const value = 42;"],
        deletions: [],
      },
    ];

    const report = runDiffAnalysis(diffs, repoRoot, emptyConfig());

    expect(report).toHaveLength(2);
    const [typeCheckEntry, blastEntry] = report as [ReportEntry, ReportEntry];
    expect(typeCheckEntry.type).toBe("typeCheck");
    expect(blastEntry.type).toBe("blastRadius");

    // The clean file produces no diagnostics.
    if (typeCheckEntry.type === "typeCheck") {
      expect(typeCheckEntry.data).toEqual([]);
    }

    // Blast radius surfaces the importer of the changed file.
    if (blastEntry.type === "blastRadius") {
      expect(blastEntry.data).toEqual<BlastRadiusEntry[]>([
        {
          affectedFile: "consumer.ts",
          changedFile: "lib.ts",
          affectedSymbols: "all",
          precision: "file",
        },
      ]);
    }

    // The report was persisted exactly once to .agent/report.json.
    const reportPath = path.join(repoRoot, ".agent", "report.json");
    expect(existsSync(reportPath)).toBe(true);
    const onDisk: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(onDisk).toEqual(report);
  });
});
