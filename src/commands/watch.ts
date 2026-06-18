/*
 * watch.ts
 * --------
 * The `watch` command. This file is a little different from the rest of the codebase: its functions
 * are actions taken AFTER a trigger, driven by fs.watch / fs.watchFile rather than a linear call
 * chain.
 *
 * What it does: watches repoRoot/.git/index (the file git rewrites on every `git add`) so we know
 * the moment files are staged, then asks detectStagedCommit what changed and hands the result to the
 * deterministic analysis engine (core/analysis.ts). fs.watch is the low-latency primary; fs.watchFile
 * polls every 1000ms as a backup, because git replaces .git/index atomically on `git add`, which can
 * silently detach a lone fs.watch watcher (and the index may not even exist yet in a fresh repo).
 *
 * Orchestration only: the heavy analysis logic lives in core/analysis.ts; the shared types live in
 * core/types.ts. This file just turns "the index changed" into a FileDiff[] and triggers analysis.
 */

import { execSync } from "node:child_process";
import { watch, watchFile, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { runDiffAnalysis } from "../core/analysis.js";
import type { FileDiff, Hunk } from "../core/types.js";
import {
  buildDependencyGraph,
  dependencyGraphExists,
} from "../utils/dependencyGraph.js";
import { captureConfig, validateGitRepo } from "./init.js";

// Verbosity for watch output. Defaults to "periodic" so we don't spam "Watching for
// changes" when it isn't useful.
// TODO: move this into .agent/ config (via src/state) so the user can change it later.
type WatchVerbosity = "verbose" | "periodic";
const watchVerbosity: WatchVerbosity = "periodic";

/**
 * parseHunkHeader: pull the NEW-side range out of a unified-diff hunk header.
 * Format: `@@ -oldStart[,oldCount] +newStart[,newCount] @@ [context]`. When newCount is omitted git
 * means 1; when it is 0 the hunk is a pure deletion (covers no new-side lines). Returns null for any
 * line that isn't a hunk header.
 */
function parseHunkHeader(line: string): Hunk | null {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  const startLine = Number(match[1]);
  const lineCount = match[2] !== undefined ? Number(match[2]) : 1;
  if (!Number.isFinite(startLine) || !Number.isFinite(lineCount)) {
    return null;
  }
  return { startLine, lineCount };
}

// git prefixes the new side of a diff path with "b/" by default; strip it to get a repo-relative path.
function stripDiffPrefix(diffPath: string): string {
  return diffPath.startsWith("b/") ? diffPath.slice(2) : diffPath;
}

/**
 * parseStagedDiff: turn `git diff --cached -U0` output into FileDiff[]. We read the new-side path
 * from each `+++ b/<path>` line (skipping `+++ /dev/null` deletions, which can't be type-checked)
 * and collect every following `@@` hunk's new-side range until the next file. Binary / mode-only
 * staged changes have no textual hunks and simply don't appear here — the analysis only cares about
 * text source files.
 */
function parseStagedDiff(diffOutput: string): FileDiff[] {
  const diffsByPath = new Map<string, FileDiff>();
  let current: FileDiff | null = null;

  for (const line of diffOutput.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = null; // a deletion — nothing on the new side to analyze
        continue;
      }
      const filePath = stripDiffPrefix(target);
      current = { filePath, hunks: [] };
      diffsByPath.set(filePath, current);
      continue;
    }

    if (line.startsWith("@@") && current) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        current.hunks.push(hunk);
      }
    }
  }

  return [...diffsByPath.values()];
}

/**
 * detectStagedCommit: figure out what is staged for commit when the watcher fires. Runs
 * `git diff --cached -U0` once and parses it into FileDiff[] (repo-relative path + new-side hunks),
 * which is exactly the input the analysis engine consumes. Logs a short summary; on failure logs
 * descriptively and returns [].
 */
function detectStagedCommit(repoRoot: string): FileDiff[] {
  let diffOutput: string;
  try {
    diffOutput = execSync("git diff --cached --unified=0 --no-color", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Error: failed to read staged diff via 'git diff --cached'. ${message}`,
    );
    return [];
  }

  const diffs = parseStagedDiff(diffOutput);

  if (diffs.length > 0) {
    console.log(
      `Detected staged change — ${diffs.length} file(s) staged for commit:`,
    );
    for (const diff of diffs) {
      console.log(`  • ${diff.filePath}`);
    }
  } else {
    console.log(
      "Index changed, but no text files are currently staged for commit.",
    );
  }

  return diffs;
}

// Ask the developer a yes/no question on its own readline interface (index.ts has already closed
// the command-loop interface before runWatch runs, so we own stdin here).
async function promptYesNo(questionText: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(questionText)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function runWatch(): Promise<void> {
  const repoRoot = validateGitRepo();

  if (repoRoot.startsWith("Error:")) {
    console.error(repoRoot);
    return;
  }

  // The analysis engine needs the build config (for the future symbol pass) and the dependency
  // graph (for blast radius). Capture config now and ensure the graph exists.
  const config = captureConfig(repoRoot);

  if (!dependencyGraphExists(repoRoot)) {
    const shouldBuild = await promptYesNo(
      "No dependency graph found in .agent/. Build it now so staged changes can be analyzed? (y/n) ",
    );
    if (shouldBuild) {
      buildDependencyGraph(repoRoot, config);
    } else {
      console.log(
        "Continuing without a dependency graph — blast-radius analysis will be empty until you run 'start'.",
      );
    }
  }

  const indexPath = path.join(repoRoot, ".git", "index");

  // Debounce the two watch sources (fs.watch + fs.watchFile) through a single handler so a single
  // `git add` doesn't trigger duplicate analysis passes. Analysis is wrapped in try/catch so a
  // transient compiler/config failure logs but never kills the long-running watch loop.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const onIndexChange = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const diffs = detectStagedCommit(repoRoot);
      if (diffs.length === 0) {
        return;
      }
      try {
        runDiffAnalysis(diffs, repoRoot, config);
        console.log("Analysis written to .agent/report.json.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: analysis failed for this change. ${message}`);
      }
    }, 100);
  };

  // Backup poll every 1000ms. watchFile tolerates the index not existing yet (a brand-new repo has
  // no .git/index until the first `git add`) and fires once it appears, so it is set up first and
  // unconditionally as the guaranteed safety net.
  watchFile(indexPath, { interval: 1000 }, onIndexChange);

  // Primary watcher: lower latency than the poll, but fs.watch throws if .git/index does not exist
  // yet and can be broken by git's atomic index replacement. If it cannot attach we log a warning
  // and keep going — the 1000ms poll above still covers us.
  try {
    const watcher: FSWatcher = watch(indexPath, onIndexChange);
    watcher.on("error", (error: Error) => {
      console.error(
        `Warning: live watcher on ${indexPath} stopped. ${error.message} (still polling every 1000ms)`,
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Warning: could not attach a live watcher to ${indexPath}. ${message} (falling back to the 1000ms poll)`,
    );
  }

  if (watchVerbosity === "periodic") {
    console.log("Watching for changes periodically...");
  } else {
    console.log("Watching for changes...");
  }
}

export { detectStagedCommit, runWatch };
