/*
 * analysis.ts
 * -----------
 * Veiny's deterministic analysis engine.
 *
 * "Deterministic" here means: given the same staged diff and the same on-disk state, this engine
 * always produces the same report — no heuristics that drift, no network, no randomness. It runs
 * the real TypeScript type checker over the project and computes a depth-1 "blast radius" from the
 * dependency graph, then packages both results into a single report envelope.
 *
 * Three exported functions, in dependency order:
 *   1. typeCheckAnalysis  — run tsc programmatically, keep only diagnostics in changed files.
 *   2. blastRadiusCheck   — pure: who imports the changed files (one hop).
 *   3. runDiffAnalysis    — thin orchestrator: type check + blast radius -> report, persisted once.
 *
 * IMPORTANT DEPENDENCY NOTE:
 *   The project's normal rule is "Babel only for AST work." This file is the explicit, spec-mandated
 *   exception: real type checking requires the TypeScript Compiler API, so we import `typescript`
 *   (already a runtime dependency). We use a DEFAULT import (`import ts from "typescript"`). The
 *   `typescript` package ships an `export =` (CommonJS-style) shape, so a default/namespace import is
 *   the correct ESM interop form here — verified to compile under this repo's tsconfig
 *   (verbatimModuleSyntax is on, and the default import still resolves). This is NOT a license to add
 *   other AST/lint libraries.
 */

import * as path from "node:path";
import ts from "typescript";
import type { ConfigSnapshot } from "../commands/init.js";
import { readDependentMap, writeReport } from "../state/agentState.js";
import type {
  BlastRadiusEntry,
  DependentMap,
  Diagnostic,
  FileDiff,
  Hunk,
  ReportEntry,
} from "./types.js";

/**
 * Convert an absolute file path into a repo-relative path with FORWARD slashes.
 *
 * Why this exists: TypeScript reports diagnostics against absolute (and often already
 * forward-slashed) file paths, but every path key in Veiny's world — FileDiff.filePath, the
 * dependency maps, report entries — is repo-relative with forward slashes. We normalize once here so
 * comparisons (e.g. "is this diagnostic in a changed file?") are apples-to-apples on every OS,
 * including Windows where path.sep is "\\".
 */
function toRepoRelative(absolutePath: string, repoRoot: string): string {
  // path.relative yields an OS-native separator; split/join forces "/" so keys match the maps.
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

/**
 * Does a 1-based line fall inside any hunk of this file's diff?
 *
 * A hunk covers the inclusive line range [startLine, startLine + lineCount - 1] on the NEW side.
 * A hunk with lineCount === 0 is a pure deletion: it has no new-side lines and therefore covers
 * NOTHING (we special-case it for clarity and to avoid an off-by-one trap where startLine - 1 could
 * accidentally match).
 */
function lineIsInAnyHunk(line: number, hunks: Hunk[]): boolean {
  for (const hunk of hunks) {
    if (hunk.lineCount === 0) {
      // Pure deletion — no new-side lines to land on.
      continue;
    }
    const lastLine = hunk.startLine + hunk.lineCount - 1;
    if (line >= hunk.startLine && line <= lastLine) {
      return true;
    }
  }
  return false;
}

/**
 * 1) typeCheckAnalysis
 * --------------------
 * Run the TypeScript type checker over the whole project, then narrow the resulting diagnostics down
 * to only those that live in files touched by the staged diff. Each surviving diagnostic is located
 * (1-based line/column), categorized, and flagged with whether it sits inside a changed hunk.
 *
 * Why "whole project, then filter" instead of "only changed files": a type error is often reported
 * in a different file (or a different line of the same file) than the edit that caused it. Building a
 * full Program and then keeping diagnostics that map to changed FILES gives correct results while
 * still keeping the report focused on what the developer is about to commit.
 *
 * v1 caveat (intentional): we do NOT try to distinguish pre-existing errors from newly introduced
 * ones. If a changed file already had an unrelated error, it will appear in the report. That is
 * acceptable for v1 — `inChangedHunk` gives callers a cheap signal for "this is right where you just
 * edited," without us guessing at causality.
 *
 * Failure policy: if the tsconfig or the compiler program cannot be loaded, this is the ONE fatal
 * path. We log a descriptive error and THROW — we never swallow it and never silently return [].
 */
function typeCheckAnalysis(diffs: FileDiff[], repoRoot: string): Diagnostic[] {
  // Derive the tsconfig path from repoRoot — never hardcoded.
  const configPath = path.join(repoRoot, "tsconfig.json");

  // The config host is ts.sys (real filesystem access) plus a mandatory callback for the one class
  // of config error that getParsedCommandLineOfConfigFile cannot recover from. We capture it so we
  // can surface a meaningful message instead of a silent null parse result.
  let unrecoverableConfigError: ts.Diagnostic | undefined;
  const configHost: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic: ts.Diagnostic): void => {
      unrecoverableConfigError = diagnostic;
    },
  };

  const parsedConfig = ts.getParsedCommandLineOfConfigFile(
    configPath,
    /* optionsToExtend */ {},
    configHost,
  );

  // If the config could not be parsed at all, fail loudly. This is fatal: without compiler options
  // and a file list there is nothing meaningful to type check.
  if (!parsedConfig) {
    const detail = unrecoverableConfigError
      ? ts.flattenDiagnosticMessageText(
          unrecoverableConfigError.messageText,
          "\n",
        )
      : "unknown configuration error";
    const message = `Failed to load TypeScript config at ${configPath}: ${detail}`;
    console.error(message);
    throw new Error(message);
  }

  // Build the Program from the resolved file list + options. This is the unit the checker operates
  // on. If construction throws (e.g. an invalid option combination), wrap it with context first so
  // the failure is descriptive rather than a bare compiler stack trace, then rethrow.
  let program: ts.Program;
  try {
    program = ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: parsedConfig.options,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Failed to create TypeScript program from ${configPath}: ${detail}`;
    console.error(message);
    throw new Error(message);
  }

  // ts.getPreEmitDiagnostics returns BOTH syntactic and semantic diagnostics (plus global/options
  // diagnostics) in one call — exactly the union the spec asks for, without us manually merging
  // getSyntacticDiagnostics + getSemanticDiagnostics per source file.
  const allDiagnostics = ts.getPreEmitDiagnostics(program);

  // Build the set of changed file paths (repo-relative, forward slashes) once, for O(1) membership
  // tests below. FileDiff.filePath is already repo-relative; we keep it verbatim as the key.
  const changedFiles = new Set<string>(diffs.map((diff) => diff.filePath));

  // Index FileDiffs by path so we can look up the hunks for a given diagnostic's file in O(1).
  const diffByFile = new Map<string, FileDiff>(
    diffs.map((diff) => [diff.filePath, diff]),
  );

  const results: Diagnostic[] = [];

  for (const diagnostic of allDiagnostics) {
    // Drop diagnostics with no associated source file (e.g. global/options-level errors) or no
    // position. We only report against concrete files the developer is changing.
    if (!diagnostic.file || diagnostic.start === undefined) {
      continue;
    }

    // Map the diagnostic's source file to a repo-relative, forward-slashed path and keep it ONLY if
    // it belongs to a changed file. Untouched files are dropped here.
    const relativePath = toRepoRelative(diagnostic.file.fileName, repoRoot);
    if (!changedFiles.has(relativePath)) {
      continue;
    }

    // Resolve location. getLineAndCharacterOfPosition is 0-based for both line and character; we
    // store 1-based values to match the Diagnostic contract and human expectations.
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start,
    );
    const oneBasedLine = line + 1;
    const oneBasedColumn = character + 1;

    // Flatten the (possibly chained) message into a single readable string.
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );

    // Map the TS category enum to our two-value union. Everything that is not an Error (warnings,
    // suggestions, messages) collapses to "warning" — v1 only distinguishes error vs. not-error.
    const category: Diagnostic["category"] =
      diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning";

    // Flag — NOT a filter — whether this diagnostic's line sits inside a staged hunk. We keep EVERY
    // in-file diagnostic regardless: an edit inside one hunk can surface an error elsewhere in the
    // same file, and that is exactly what we want to show.
    const fileDiff = diffByFile.get(relativePath);
    const inChangedHunk = fileDiff
      ? lineIsInAnyHunk(oneBasedLine, fileDiff.hunks)
      : false;

    results.push({
      filePath: relativePath,
      line: oneBasedLine,
      column: oneBasedColumn,
      message,
      code: diagnostic.code,
      category,
      inChangedHunk,
    });
  }

  return results;
}

/**
 * 2) blastRadiusCheck
 * -------------------
 * PURE function. Given the list of changed files and the (already-parsed) dependentMap, report which
 * OTHER files are affected because they import a changed file.
 *
 * No fs, no network, no agentState import. The caller owns reading the map; this function only
 * transforms data. That keeps it trivially unit-testable and side-effect free.
 *
 * DEPTH-1 ONLY. For each changed file we do exactly one lookup in dependentMap — the set of files
 * that import it directly. There is deliberately no DFS/BFS, no stack/queue, and no transitive
 * traversal: an edit's first-order importers are the highest-signal, lowest-noise set to surface
 * before a commit. Transitive reach can balloon and bury the signal.
 *
 * v1 is FILE-LEVEL: every entry carries affectedSymbols: "all" and precision: "file" because we do
 * not yet know which exported symbols actually changed. The spec's symbol-precise version — which
 * would consume ChangedSymbol + SymbolMap and emit precision: "symbol" with a concrete symbol list —
 * is a documented FUTURE evolution and is intentionally NOT implemented here.
 *
 * A changed file with no entry in dependentMap (nobody imports it) contributes zero entries.
 */
function blastRadiusCheck(
  changedFiles: string[],
  dependentMap: DependentMap,
): BlastRadiusEntry[] {
  const entries: BlastRadiusEntry[] = [];

  for (const changedFile of changedFiles) {
    // One lookup per changed file — depth 1, no recursion. Under noUncheckedIndexedAccess this is
    // `string[] | undefined`, so we guard explicitly; a missing key contributes nothing.
    const importers = dependentMap[changedFile];
    if (!importers) {
      continue;
    }

    for (const importer of importers) {
      entries.push({
        affectedFile: importer, // the file that imports the changed file
        changedFile, // the diffed file causing the impact
        affectedSymbols: "all", // v1: file-level, so all symbols are considered affected
        precision: "file", // v1: always "file"; "symbol" reserved for the future pass
      });
    }
  }

  return entries;
}

/**
 * 3) runDiffAnalysis
 * ------------------
 * Thin orchestrator over the analysis TYPES (not a per-file loop). It runs the two checks, packages
 * their outputs into the report envelope, persists the report exactly ONCE, and returns it.
 *
 * Persisting here (and ONLY here) keeps the helpers pure/side-effect-free: typeCheckAnalysis and
 * blastRadiusCheck never touch disk. Returning the report (rather than only writing it) lets callers
 * and tests assert on the result without reading the file back.
 *
 * About `config`: it is currently RESERVED. The file-level v1 path does not consume it — it is
 * threaded through for the future symbol-precise blast-radius pass (which will need build/path-alias
 * info to resolve symbols). Do NOT delete it: the signature is fixed by the spec. (tsconfig does not
 * enable noUnusedParameters, so an unused parameter does not produce a compile error.)
 */
function runDiffAnalysis(
  diffs: FileDiff[],
  repoRoot: string,
  config: ConfigSnapshot,
): ReportEntry[] {
  // Reference `config` so its reservation is explicit and self-documenting. Marked void to make
  // clear we are intentionally not using its value yet (v1 file-level path). See note above.
  void config;

  // 1. Type check the project and keep diagnostics that land in changed files.
  const diagnostics = typeCheckAnalysis(diffs, repoRoot);

  // 2. Load the (inverse) dependency graph: file -> who imports it. agentState owns this read and
  //    degrades to {} if the map is absent/corrupt, so blast radius simply comes back empty then.
  const dependentMap = readDependentMap(repoRoot);

  // 3. Compute depth-1 blast radius from the list of changed file paths.
  const blast = blastRadiusCheck(
    diffs.map((diff) => diff.filePath),
    dependentMap,
  );

  // 4. Aggregate both results into the discriminated-union report envelope.
  const report: ReportEntry[] = [
    { type: "typeCheck", data: diagnostics },
    { type: "blastRadius", data: blast },
  ];

  // 5. Persist ONCE — the single write for an analysis pass. Helpers never write.
  writeReport(repoRoot, report);

  // 6. Return the in-memory report so callers/tests need not read it back from disk.
  return report;
}

export { blastRadiusCheck, runDiffAnalysis, typeCheckAnalysis };
