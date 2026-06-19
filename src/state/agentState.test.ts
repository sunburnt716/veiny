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
import type {
  DependentMap,
  ImportEdge,
  ReportEntry,
  VerificationEntry,
} from "../core/types.js";
import {
  dependencyGraphExists,
  readDependentMap,
  readImports,
  readUserContext,
  readVerifications,
  recordVerification,
  writeAgentState,
  writeDependencyMaps,
  writeHeuristicReport,
  writeImports,
  writeReport,
} from "./agentState.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-state-")));
  tempDirs.push(dir);
  return dir;
}

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

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("writeReport", () => {
  it("writes report.json containing the passed report", () => {
    const repoRoot = makeTempDir();
    const report: ReportEntry[] = [
      {
        type: "typeCheck",
        data: [
          {
            filePath: "src/a.ts",
            line: 3,
            column: 7,
            message: "Type 'string' is not assignable to type 'number'.",
            code: 2322,
            category: "error",
            inChangedHunk: true,
          },
        ],
      },
      {
        type: "blastRadius",
        data: [
          {
            affectedFile: "src/b.ts",
            changedFile: "src/a.ts",
            affectedSymbols: "all",
            precision: "file",
          },
        ],
      },
    ];

    writeReport(repoRoot, report);

    const reportPath = path.join(repoRoot, ".agent", "report.json");
    expect(existsSync(reportPath)).toBe(true);
    const onDisk: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(onDisk).toEqual(report);
  });
});

describe("readDependentMap", () => {
  it("returns {} when the file is absent", () => {
    const repoRoot = makeTempDir();

    expect(readDependentMap(repoRoot)).toEqual({});
  });

  it("returns the parsed object when the file is present", () => {
    const repoRoot = makeTempDir();
    const map: DependentMap = { "src/lib.ts": ["src/a.ts", "src/b.ts"] };
    writeDependencyMaps(repoRoot, {
      dependencyMap: {},
      dependentMap: map,
    });

    expect(readDependentMap(repoRoot)).toEqual(map);
  });

  it("returns {} for a corrupt / non-object file and does not throw", () => {
    const repoRoot = makeTempDir();
    mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
    // Invalid JSON.
    writeFileSync(
      path.join(repoRoot, ".agent", "dependentMap.json"),
      "{ this is not valid json",
      "utf8",
    );

    expect(() => readDependentMap(repoRoot)).not.toThrow();
    expect(readDependentMap(repoRoot)).toEqual({});
  });

  it("returns {} when the file parses to a non-object (e.g. an array)", () => {
    const repoRoot = makeTempDir();
    mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".agent", "dependentMap.json"),
      JSON.stringify(["not", "a", "map"]),
      "utf8",
    );

    expect(readDependentMap(repoRoot)).toEqual({});
  });
});

describe("writeAgentState", () => {
  it("writes repoInfo and configInfo and userContext when context is provided", () => {
    const repoRoot = makeTempDir();

    writeAgentState(repoRoot, emptyConfig(), "some project context");

    const agentDir = path.join(repoRoot, ".agent");
    expect(existsSync(path.join(agentDir, "repoInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "configInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "userContext.md"))).toBe(true);

    const repoInfo: unknown = JSON.parse(
      readFileSync(path.join(agentDir, "repoInfo.json"), "utf8"),
    );
    expect(repoInfo).toEqual({ repoRoot });
    expect(
      readFileSync(path.join(agentDir, "userContext.md"), "utf8"),
    ).toContain("some project context");
  });

  it("skips userContext.md when context is empty", () => {
    const repoRoot = makeTempDir();

    writeAgentState(repoRoot, emptyConfig(), "");

    const agentDir = path.join(repoRoot, ".agent");
    expect(existsSync(path.join(agentDir, "repoInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "configInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "userContext.md"))).toBe(false);
  });
});

describe("dependencyGraphExists", () => {
  it("is false before writeDependencyMaps and true after", () => {
    const repoRoot = makeTempDir();

    expect(dependencyGraphExists(repoRoot)).toBe(false);

    writeDependencyMaps(repoRoot, {
      dependencyMap: { "a.ts": ["b.ts"] },
      dependentMap: { "b.ts": ["a.ts"] },
    });

    expect(dependencyGraphExists(repoRoot)).toBe(true);
  });
});

describe("recordVerification", () => {
  it("appends across multiple calls, preserving order", () => {
    const repoRoot = makeTempDir();

    const first: VerificationEntry = {
      timestamp: "2026-01-01T00:00:00.000Z",
      caughtFiles: ["src/a.ts"],
      committedFiles: ["src/a.ts"],
      accurate: true,
    };
    const second: VerificationEntry = {
      timestamp: "2026-01-02T00:00:00.000Z",
      caughtFiles: ["src/b.ts", "src/c.ts"],
      committedFiles: ["src/b.ts"],
      accurate: false,
    };

    recordVerification(repoRoot, first);
    recordVerification(repoRoot, second);

    // Read back through the public reader: both entries, in call order.
    expect(readVerifications(repoRoot)).toEqual<VerificationEntry[]>([
      first,
      second,
    ]);

    // And the on-disk file is a JSON array of those two entries.
    const onDisk: unknown = JSON.parse(
      readFileSync(
        path.join(repoRoot, ".agent", "verifications.json"),
        "utf8",
      ),
    );
    expect(onDisk).toEqual([first, second]);
  });
});

describe("readVerifications", () => {
  it("returns [] when the file is absent", () => {
    const repoRoot = makeTempDir();

    expect(readVerifications(repoRoot)).toEqual([]);
  });

  it("degrades to [] for corrupt JSON without throwing", () => {
    const repoRoot = makeTempDir();
    mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".agent", "verifications.json"),
      "{ not valid json",
      "utf8",
    );

    expect(() => readVerifications(repoRoot)).not.toThrow();
    expect(readVerifications(repoRoot)).toEqual([]);
  });

  it("degrades to [] when the file parses to a non-array value", () => {
    const repoRoot = makeTempDir();
    mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".agent", "verifications.json"),
      JSON.stringify({ not: "an array" }),
      "utf8",
    );

    expect(readVerifications(repoRoot)).toEqual([]);
  });
});

describe("writeImports / readImports", () => {
  it("round-trips an ImportEdge[] through disk", () => {
    const repoRoot = makeTempDir();
    const edges: ImportEdge[] = [
      { importer: "src/a.ts", imported: "src/b.ts", symbols: ["thing"] },
      { importer: "src/c.ts", imported: "src/b.ts", symbols: ["all"] },
    ];

    writeImports(repoRoot, edges);

    expect(readImports(repoRoot)).toEqual(edges);

    // And the on-disk file is exactly that array of edges.
    const onDisk: unknown = JSON.parse(
      readFileSync(path.join(repoRoot, ".agent", "imports.json"), "utf8"),
    );
    expect(onDisk).toEqual(edges);
  });

  it("returns [] when imports.json is absent", () => {
    const repoRoot = makeTempDir();

    expect(readImports(repoRoot)).toEqual([]);
  });

  it("degrades to [] for corrupt JSON without throwing", () => {
    const repoRoot = makeTempDir();
    mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, ".agent", "imports.json"),
      "{ not valid json",
      "utf8",
    );

    expect(() => readImports(repoRoot)).not.toThrow();
    expect(readImports(repoRoot)).toEqual([]);
  });
});

describe("readUserContext", () => {
  it("returns the file contents when userContext.md is present", () => {
    const repoRoot = makeTempDir();
    writeAgentState(repoRoot, emptyConfig(), "my project context");

    expect(readUserContext(repoRoot)).toContain("my project context");
  });

  it('returns "" when userContext.md is absent', () => {
    const repoRoot = makeTempDir();

    expect(readUserContext(repoRoot)).toBe("");
  });
});

describe("writeHeuristicReport", () => {
  it("writes a markdown report under .agent/reports/ and returns its path", () => {
    const repoRoot = makeTempDir();
    const markdown = "# Veiny Risk Analysis\n\nSome findings.";

    const reportPath = writeHeuristicReport(repoRoot, markdown);

    // The returned path lives under .agent/reports/ and is named report-*.md.
    const reportsDir = path.join(repoRoot, ".agent", "reports");
    expect(reportPath.startsWith(reportsDir)).toBe(true);
    const base = path.basename(reportPath);
    expect(base.startsWith("report-")).toBe(true);
    expect(base.endsWith(".md")).toBe(true);

    // The file exists and contains the passed markdown.
    expect(existsSync(reportPath)).toBe(true);
    expect(readFileSync(reportPath, "utf8")).toContain("Some findings.");
  });
});
