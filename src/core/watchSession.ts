/*
 * watchSession.ts
 * ---------------
 * PURE helper functions for Veiny's interactive watch session (commands/watch.ts).
 *
 * "Pure" here is a hard contract, not an aspiration:
 *   - No fs, no git, no readline, no console, no network, no timers.
 *   - No side effects of any kind — inputs are never mutated, only read.
 *   - The ONLY import is the type-only import below.
 *
 * Why this matters: keeping these as pure data->data transforms means they can be unit-tested
 * with plain literal objects and arrays, with zero mocking of the filesystem, git, or stdin.
 * The impure orchestration (reading report.json, talking to the user) lives in the watch
 * command; the decisions about what the numbers mean live here.
 *
 * Type-only import: we pull these in purely for compile-time shape checking. Marking the import
 * `import type` guarantees it is erased from the emitted JavaScript, so this module genuinely has
 * no runtime dependencies — reinforcing the purity contract above.
 */
import type { ReportEntry, ReportSummary, CommitComparison } from "./types.js";

/**
 * summarizeReport
 * ---------------
 * Collapse a full report (the discriminated-union envelope written to report.json) into the small
 * set of headline numbers shown to the developer the moment a staged change is caught.
 *
 * The report is an array of `ReportEntry`, where each entry is one of:
 *   - { type: "typeCheck";   data: Diagnostic[] }       — TS diagnostics for the staged diff
 *   - { type: "blastRadius"; data: BlastRadiusEntry[] } — who imports the changed files
 *
 * We do NOT assume both variants are present, that they appear at most once, or that they appear
 * in any particular order. We simply walk every entry, narrow on the `type` discriminant, and
 * accumulate. Anything absent naturally contributes zero — an empty report yields all zeros.
 *
 * Returns { errors, warnings, affectedFiles }:
 *   - errors:        typeCheck diagnostics with category === "error"
 *   - warnings:      typeCheck diagnostics with category === "warning"
 *   - affectedFiles: the count of UNIQUE affectedFile values across all blastRadius entries
 *
 * Purity: the input array and its contents are only read. We build fresh locals and return a new
 * object; nothing on `report` is touched.
 */
function summarizeReport(report: ReportEntry[]): ReportSummary {
  // Running tallies for the two typeCheck categories.
  let errors = 0;
  let warnings = 0;

  // A Set gives us de-duplication of affected files for free, and the final `affectedFiles`
  // number is just its size. We collect across ALL blastRadius entries (there may be more than
  // one such entry, or none) so a file imported via several changed files is still counted once.
  const affectedFileSet = new Set<string>();

  // Iterate every entry. Switching on `entry.type` is what lets TypeScript narrow the union:
  // inside the "typeCheck" branch `entry.data` is Diagnostic[]; inside "blastRadius" it is
  // BlastRadiusEntry[]. No casts, no `any` — the discriminant does the work.
  for (const entry of report) {
    switch (entry.type) {
      case "typeCheck": {
        // entry.data: Diagnostic[]. Each diagnostic's `category` is exactly "error" | "warning",
        // so a simple comparison classifies it. We tally rather than collect — we only need counts.
        for (const diagnostic of entry.data) {
          if (diagnostic.category === "error") {
            errors += 1;
          } else if (diagnostic.category === "warning") {
            warnings += 1;
          }
          // No `else`: the type guarantees only those two categories, so there is nothing else
          // to handle. We intentionally avoid a catch-all that could silently miscount.
        }
        break;
      }
      case "blastRadius": {
        // entry.data: BlastRadiusEntry[]. We only care about distinct importers (`affectedFile`).
        // Adding an already-present value to a Set is a no-op, which is exactly the de-dup we want.
        for (const blast of entry.data) {
          affectedFileSet.add(blast.affectedFile);
        }
        break;
      }
      // No `default` branch: ReportEntry is a closed discriminated union, so every variant is
      // handled above. If a new variant is added to types.ts without updating this switch, the
      // missing handling stays visible at the call sites rather than being swallowed here.
    }
  }

  // Build and return a brand-new summary object. The input was never mutated.
  return {
    errors,
    warnings,
    affectedFiles: affectedFileSet.size,
  };
}

/**
 * compareCaughtToCommitted
 * ------------------------
 * Cross-reference the files Veiny CAUGHT (the staged files it analyzed/warned about) against the
 * files that actually landed in a detected commit. This powers the accuracy-feedback loop: did the
 * developer commit the things we flagged, or did they commit other things we never saw?
 *
 * Returns { committedAndCaught, caughtNotCommitted, allCaughtWereCommitted }:
 *   - committedAndCaught:     caught files that ALSO appear in committedFiles
 *   - caughtNotCommitted:     caught files that do NOT appear in committedFiles
 *   - allCaughtWereCommitted: true when every caught file is in committedFiles
 *
 * Both result arrays preserve the ORDER of caughtFiles and are de-duplicated (a file listed twice
 * in caughtFiles appears at most once in the output, in its first position).
 *
 * Edge case (called out in the spec): if caughtFiles is empty there is nothing uncommitted, so
 * allCaughtWereCommitted is `true` and both arrays are empty. This falls out naturally from the
 * logic below — the loop never runs, the lists stay empty, and our flag starts at `true` — but it
 * is the most important behavior to get right, so it is documented explicitly.
 *
 * Purity: inputs are only read. We build fresh arrays/sets and return a new object.
 */
function compareCaughtToCommitted(
  caughtFiles: string[],
  committedFiles: string[],
): CommitComparison {
  // Set of committed files for O(1) membership tests as we scan the caught files.
  const committedSet = new Set<string>(committedFiles);

  // Tracks which caught files we have already emitted, so duplicates in caughtFiles do not produce
  // duplicates in either output array. Order is still driven by the caughtFiles iteration order.
  const seen = new Set<string>();

  const committedAndCaught: string[] = [];
  const caughtNotCommitted: string[] = [];

  // Start optimistic: "all caught files were committed". This is also the correct answer for the
  // empty-caughtFiles case, because the loop below never flips it to false.
  let allCaughtWereCommitted = true;

  for (const file of caughtFiles) {
    // De-dup: only the first occurrence of a given path is classified and emitted.
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);

    if (committedSet.has(file)) {
      // Caught AND committed — Veiny flagged something that genuinely landed.
      committedAndCaught.push(file);
    } else {
      // Caught but NOT committed — there exists at least one caught file outside the commit,
      // so the "all were committed" invariant is broken.
      caughtNotCommitted.push(file);
      allCaughtWereCommitted = false;
    }
  }

  // Fresh object; neither caughtFiles nor committedFiles was mutated.
  return {
    committedAndCaught,
    caughtNotCommitted,
    allCaughtWereCommitted,
  };
}

export { summarizeReport, compareCaughtToCommitted };
