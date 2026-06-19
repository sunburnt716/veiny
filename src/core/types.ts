/*
 * types.ts
 * --------
 * Shared type definitions for Veiny's dependency graph and deterministic analysis engine.
 * Centralized here as a single source of truth so the parser (utils/dependencyGraph.ts), the
 * analysis engine (core/analysis.ts), the state writer (state/agentState.ts), and the watch
 * command (commands/watch.ts) all agree on the same shapes — and so humans and other agents can
 * cross-reference one file instead of chasing duplicated interfaces.
 */

// --- Dependency graph (written to .agent/dependencyMap.json and .agent/dependentMap.json) ---

// One direction of the graph: file -> list of related files (all repo-relative, forward slashes).
type DependencyMap = Record<string, string[]>;

// Both directions, carried together in memory while the codebase is walked.
interface DependencyMaps {
  dependencyMap: DependencyMap; // each file -> the files it imports (depends on)
  dependentMap: DependencyMap; // the inverse: each file -> the files that import it
}

// --- Git diff (produced by detectStagedCommit, consumed by the analysis engine) ---

// A contiguous run of changed lines on the NEW side of a staged diff.
interface Hunk {
  startLine: number; // 1-based start line on the new side
  lineCount: number; // number of new-side lines (0 for a pure deletion)
}

// The staged changes for a single file.
interface FileDiff {
  filePath: string; // relative to repoRoot
  hunks: Hunk[];
  additions: string[]; // new-side added lines (content, without the leading "+")
  deletions: string[]; // old-side removed lines (content, without the leading "-")
}

// One edge of the import graph with the symbols that cross it — written to .agent/imports.json.
// Kept separate from the lean dependency maps so the hot ripple-walk never loads symbol detail.
interface ImportEdge {
  importer: string; // file doing the importing, relative to repoRoot
  imported: string; // resolved file being imported, relative to repoRoot
  symbols: string[]; // named symbols crossing this edge, OR ["all"], OR ["default"]
}

// --- Analysis outputs (the contents of report.json) ---

// A single TypeScript diagnostic, located and flagged against the staged diff.
interface Diagnostic {
  filePath: string; // relative to repoRoot
  line: number; // 1-based
  column: number; // 1-based
  message: string;
  code: number; // TS error code, e.g. 2322
  category: "error" | "warning";
  inChangedHunk: boolean; // does this line fall inside a staged diff hunk?
}

// A symbol that changed in a diff. Defined for the future symbol-precise pass; UNUSED in v1,
// which computes blast radius at file level only.
interface ChangedSymbol {
  filePath: string; // relative to repoRoot
  symbolName: string;
  exported: boolean;
}

// One "who is affected by this change" record.
interface BlastRadiusEntry {
  affectedFile: string; // relative to repoRoot — the importer
  changedFile: string; // the diffed file causing it
  affectedSymbols: string[] | "all"; // "all" for file-level (v1 always emits this)
  precision: "symbol" | "file"; // v1 always "file"; "symbol" is reserved for the future pass
}

// --- .agent/ map shapes read from disk by the analysis engine ---

type DependentMap = Record<string, string[]>; // file -> the files that import it

// file -> { importer -> symbols used (or "all") }. Defined for the future symbol-precise pass;
// UNUSED in v1 (symbolMap collapses to dependentMap at file level).
type SymbolMap = Record<string, Record<string, string[] | "all">>;

// --- report.json envelope ---

// Discriminated union on `type`. Add new variants here as analyses are added (e.g. lint in v2).
type ReportEntry =
  | { type: "typeCheck"; data: Diagnostic[] }
  | { type: "blastRadius"; data: BlastRadiusEntry[] };

// --- interactive watch session ---

// Headline counts derived from a report, shown to the user when a staged change is caught.
interface ReportSummary {
  errors: number; // typeCheck diagnostics with category "error"
  warnings: number; // typeCheck diagnostics with category "warning"
  affectedFiles: number; // unique files in the blast radius (who imports the changed files)
}

// Result of comparing the files Veiny caught (staged) against the files in a detected commit.
interface CommitComparison {
  committedAndCaught: string[]; // caught files that actually landed in the commit
  caughtNotCommitted: string[]; // caught files that did NOT land in the commit
  allCaughtWereCommitted: boolean; // true when every caught file appears in the commit
}

// One accuracy-feedback record, appended to .agent/verifications.json on commit verification.
interface VerificationEntry {
  timestamp: string; // ISO-8601
  caughtFiles: string[]; // repo-relative files Veiny had caught (staged)
  committedFiles: string[]; // repo-relative files in the detected commit
  accurate: boolean; // the user's y/n answer
}

export type {
  BlastRadiusEntry,
  ChangedSymbol,
  CommitComparison,
  DependencyMap,
  DependencyMaps,
  DependentMap,
  Diagnostic,
  FileDiff,
  Hunk,
  ImportEdge,
  ReportEntry,
  ReportSummary,
  SymbolMap,
  VerificationEntry,
};
