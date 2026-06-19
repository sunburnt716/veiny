/*
 * watch.ts
 * --------
 * The `watch` command — now an INTERACTIVE session. This file is a little different from the rest of
 * the codebase: its functions are actions taken AFTER a trigger, driven by fs.watch / fs.watchFile
 * rather than a linear call chain.
 *
 * Two things are watched inside .git:
 *   - .git/index     : rewritten on every `git add` -> a "staged change" was caught. We analyze it
 *                      (core/analysis.ts), print headline metrics, and prompt the user (keep / quit).
 *   - .git/logs/HEAD : appended to on every commit -> a "commit" happened. We compare the files we
 *                      caught (staged) to the files in that commit and ask the developer whether the
 *                      detection was accurate, recording the answer as feedback.
 *
 * fs.watch is the low-latency primary; fs.watchFile polls every 1000ms as a backup, because git
 * replaces these files atomically, which can silently detach a lone fs.watch watcher (and they may
 * not exist yet in a fresh repo). Events from both sources are debounced and SERIALIZED through one
 * queue so two prompts can never be open at once. The user can stop any time: `quit` at a prompt, or
 * Ctrl+C (SIGINT) — both run a single graceful teardown.
 *
 * Orchestration only: the heavy analysis lives in core/analysis.ts, the pure session math in
 * core/watchSession.ts, the shared types in core/types.ts, and all .agent/ I/O in state/agentState.ts.
 */

import { execSync } from "node:child_process";
import { watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { runDiffAnalysis } from "../core/analysis.js";
import type {
  BlastRadiusEntry,
  FileDiff,
  Hunk,
  ReportEntry,
  VerificationEntry,
} from "../core/types.js";
import {
  compareCaughtToCommitted,
  summarizeReport,
} from "../core/watchSession.js";
import { runHeuristicAnalysis } from "../llm/analyze.js";
import { getProvider } from "../llm/client.js";
import type { AnalysisContext } from "../llm/provider.js";
import { formatReportMarkdown, reportToTerminal } from "../llm/report.js";
import { loadApiKey } from "../state/credentials.js";
import { readLLMConfig } from "../state/llmConfig.js";
import {
  readImports,
  readUserContext,
  recordVerification,
  writeHeuristicReport,
} from "../state/agentState.js";
import {
  buildDependencyGraph,
  dependencyGraphExists,
} from "../utils/dependencyGraph.js";
import { captureConfig, validateGitRepo, type ConfigSnapshot } from "./init.js";

// Verbosity for the startup message. Defaults to "periodic" so we don't over-announce.
// TODO: move this into .agent/ config (via src/state) so the user can change it later.
type WatchVerbosity = "verbose" | "periodic";
const watchVerbosity: WatchVerbosity = "periodic";

// Running totals for one watch session — shown to the user and recorded as feedback.
interface WatchSession {
  catches: number; // staged-change catches this session
  lastCaughtFiles: string[]; // repo-relative files from the most recent catch (for commit compare)
  commitsVerified: number;
  accurateCount: number;
  inaccurateCount: number;
}

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
 * from each `+++ b/<path>` line (skipping `+++ /dev/null` deletions, which can't be type-checked),
 * collect every following `@@` hunk's new-side range, and capture the actual changed lines
 * (`+`/`-` content, without the leading marker) into `additions`/`deletions` so the LLM layer has
 * real diff text to reason about. Binary / mode-only staged changes have no textual hunks and simply
 * don't appear here — the analysis only cares about text source files.
 *
 * The `---`/`+++` header lines are skipped explicitly so they're never mistaken for content; every
 * other line beginning with `+` or `-` inside a hunk is a changed line.
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
      current = { filePath, hunks: [], additions: [], deletions: [] };
      diffsByPath.set(filePath, current);
      continue;
    }

    // The old-side header — skip so it isn't counted as a deletion line.
    if (line.startsWith("--- ")) {
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("@@")) {
      const hunk = parseHunkHeader(line);
      if (hunk) {
        current.hunks.push(hunk);
      }
      continue;
    }

    // Inside a hunk: capture changed-line content without the leading marker.
    if (line.startsWith("+")) {
      current.additions.push(line.slice(1));
    } else if (line.startsWith("-")) {
      current.deletions.push(line.slice(1));
    }
  }

  return [...diffsByPath.values()];
}

/**
 * detectStagedCommit: figure out what is staged for commit when the watcher fires. Runs
 * `git diff --cached -U0` once and parses it into FileDiff[] (repo-relative path + new-side hunks),
 * which is exactly the input the analysis engine consumes. On failure logs descriptively, returns [].
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

  return parseStagedDiff(diffOutput);
}

/**
 * getCommittedFiles: list the repo-relative files that landed in the most recent commit (HEAD), via
 * `git diff-tree --no-commit-id --name-only -r HEAD`. On failure logs descriptively and returns [].
 */
function getCommittedFiles(repoRoot: string): string[] {
  let output: string;
  try {
    // --root makes the very first (parentless) commit list its full tree instead of nothing;
    // it has no effect on ordinary commits, which diff against their parent as usual.
    output = execSync("git diff-tree --no-commit-id --name-only -r --root HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Error: failed to read committed files via 'git diff-tree'. ${message}`,
    );
    return [];
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Ask a single yes/no question on its own short-lived readline interface. Used only for the startup
// graph-build prompt, before the long-lived session interface is created.
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

  // The analysis engine needs the build config and the dependency graph (for blast radius).
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

  // The interactive loop resolves only when the user quits (command or SIGINT), so main() blocks on
  // `await runWatch()` until then.
  await watchInteractively(repoRoot, config);
}

/**
 * watchInteractively: the long-running session. Sets up the two watchers and a single readline
 * interface, serializes events so prompts never overlap, and resolves when the user quits.
 */
function watchInteractively(
  repoRoot: string,
  config: ConfigSnapshot,
): Promise<void> {
  const session: WatchSession = {
    catches: 0,
    lastCaughtFiles: [],
    commitsVerified: 0,
    accurateCount: 0,
    inaccurateCount: 0,
  };

  const indexPath = path.join(repoRoot, ".git", "index");
  const headLogPath = path.join(repoRoot, ".git", "logs", "HEAD");

  return new Promise<void>((resolve) => {
    let stopped = false;
    let indexDebounce: ReturnType<typeof setTimeout> | null = null;
    let headDebounce: ReturnType<typeof setTimeout> | null = null;
    let indexWatcher: FSWatcher | null = null;
    let headWatcher: FSWatcher | null = null;
    // Serializes async handlers so only one prompt is ever open at a time.
    let queue: Promise<void> = Promise.resolve();

    const rl = createInterface({ input: stdin, output: stdout });

    // Single graceful teardown, shared by the `quit` command and Ctrl+C. Idempotent via `stopped`.
    const stopWatching = (): void => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (indexDebounce) {
        clearTimeout(indexDebounce);
      }
      if (headDebounce) {
        clearTimeout(headDebounce);
      }
      indexWatcher?.close();
      headWatcher?.close();
      unwatchFile(indexPath);
      unwatchFile(headLogPath);
      process.removeListener("SIGINT", onSigint);
      rl.close();
      console.log("\nGoodbye.");
      resolve();
    };

    const onSigint = (): void => stopWatching();
    rl.on("SIGINT", onSigint);
    process.on("SIGINT", onSigint);

    // Ask a question on the session interface. Returns "" if the session has stopped or the
    // interface closed mid-question (e.g. Ctrl+C during a prompt) — that is expected on shutdown,
    // not an error to surface; any other failure is logged.
    const ask = async (questionText: string): Promise<string> => {
      if (stopped) {
        return "";
      }
      try {
        return (await rl.question(questionText)).trim().toLowerCase();
      } catch (error) {
        if (!stopped) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Error reading input: ${message}`);
        }
        return "";
      }
    };

    // Optional, gated LLM heuristic step. Runs only when the developer opted in (llmConfig.enabled)
    // AND a key is available (non-prompting lookup). It feeds Veiny's deterministic facts INTO the
    // model — diff content, blast radius, import seams, project context — and asks for judgment only.
    // Any failure (network, parse, etc.) is logged but never aborts the watch loop; if disabled or no
    // key, it returns silently and watch behaves exactly as before.
    const runHeuristicStep = async (
      diffs: FileDiff[],
      report: ReportEntry[],
    ): Promise<void> => {
      const llmConfig = readLLMConfig(repoRoot);
      const apiKey = loadApiKey(repoRoot);
      if (!llmConfig?.enabled || !apiKey) {
        return;
      }
      try {
        const blastEntry = report.find((entry) => entry.type === "blastRadius");
        const blastRadius: BlastRadiusEntry[] =
          blastEntry && blastEntry.type === "blastRadius" ? blastEntry.data : [];
        const ctx: AnalysisContext = {
          userContext: readUserContext(repoRoot),
          changedFiles: diffs,
          blastRadius,
          imports: readImports(repoRoot),
        };
        const provider = getProvider(llmConfig, apiKey);
        const result = await runHeuristicAnalysis(ctx, provider);
        reportToTerminal(result);

        const save = await ask("Save this report? (y/n): ");
        if (save === "y" || save === "yes") {
          const reportPath = writeHeuristicReport(
            repoRoot,
            formatReportMarkdown(result),
          );
          console.log(`Report saved to ${reportPath}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: LLM analysis failed for this change. ${message}`);
      }
    };

    // Handle a staged change: analyze it, show headline metrics, run the optional LLM step, offer
    // keep/quit.
    const handleStagedCatch = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      const diffs = detectStagedCommit(repoRoot);
      if (diffs.length === 0) {
        // The index changed but nothing is staged (e.g. right after a commit clears it) — ignore.
        return;
      }

      session.catches += 1;
      session.lastCaughtFiles = diffs.map((diff) => diff.filePath);

      // Capture the deterministic report so the LLM step can reuse its blast radius. Stays null if
      // analysis throws, in which case the LLM step is skipped (it has no facts to feed the model).
      let report: ReportEntry[] | null = null;
      let metrics: string;
      try {
        report = runDiffAnalysis(diffs, repoRoot, config);
        const summary = summarizeReport(report);
        metrics = `${diffs.length} file(s) caught · ${summary.errors} error(s) · ${summary.warnings} warning(s) · ${summary.affectedFiles} affected file(s)`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: analysis failed for this change. ${message}`);
        metrics = `${diffs.length} file(s) caught · analysis failed`;
      }

      console.log(`\n[caught] ${metrics}`);
      for (const file of session.lastCaughtFiles) {
        console.log(`  • ${file}`);
      }

      if (report !== null) {
        await runHeuristicStep(diffs, report);
      }

      const answer = await ask("[Enter] keep watching · type 'quit' to stop: ");
      if (answer === "quit" || answer === "q") {
        stopWatching();
      }
    };

    // Handle a commit: compare what we caught to what was committed and record accuracy feedback.
    const handleCommit = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      if (session.lastCaughtFiles.length === 0) {
        // Nothing was caught this session, so there is nothing to verify against the commit.
        return;
      }
      const committed = getCommittedFiles(repoRoot);
      if (committed.length === 0) {
        return;
      }

      const comparison = compareCaughtToCommitted(
        session.lastCaughtFiles,
        committed,
      );
      console.log(
        `\n[commit] ${comparison.committedAndCaught.length} of ${session.lastCaughtFiles.length} caught file(s) are in this commit.`,
      );
      if (comparison.committedAndCaught.length > 0) {
        console.log(`  matched: ${comparison.committedAndCaught.join(", ")}`);
      }

      const answer = await ask(
        "Was Veiny's detection accurate for this commit? (y/n, or 'quit'): ",
      );
      if (answer === "quit" || answer === "q") {
        stopWatching();
        return;
      }

      // Treat y/yes as accurate; anything else is "not accurate" for this simple feedback signal.
      const accurate = answer === "y" || answer === "yes";
      session.commitsVerified += 1;
      if (accurate) {
        session.accurateCount += 1;
      } else {
        session.inaccurateCount += 1;
      }

      const entry: VerificationEntry = {
        timestamp: new Date().toISOString(),
        caughtFiles: session.lastCaughtFiles,
        committedFiles: committed,
        accurate,
      };
      recordVerification(repoRoot, entry);
      console.log(
        `Recorded. Session accuracy: ${session.accurateCount} accurate / ${session.inaccurateCount} not.`,
      );
    };

    // Append a handler to the serialization queue, logging (never swallowing) any failure.
    const enqueue = (handler: () => Promise<void>): void => {
      queue = queue.then(handler).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error in watch handler: ${message}`);
      });
    };

    const onIndexChange = (): void => {
      if (stopped) {
        return;
      }
      if (indexDebounce) {
        clearTimeout(indexDebounce);
      }
      indexDebounce = setTimeout(() => enqueue(handleStagedCatch), 100);
    };

    const onHeadChange = (): void => {
      if (stopped) {
        return;
      }
      if (headDebounce) {
        clearTimeout(headDebounce);
      }
      headDebounce = setTimeout(() => enqueue(handleCommit), 100);
    };

    // Attach watchers to a target: fs.watchFile (unconditional poll, tolerates a missing file) plus a
    // best-effort fs.watch (lower latency; a failure is a warning, not fatal — the poll still covers).
    const attachWatchers = (
      target: string,
      onChange: () => void,
    ): FSWatcher | null => {
      watchFile(target, { interval: 1000 }, onChange);
      try {
        const watcher = watch(target, onChange);
        watcher.on("error", (error: Error) => {
          console.error(
            `Warning: live watcher on ${target} stopped. ${error.message} (still polling every 1000ms)`,
          );
        });
        return watcher;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `Warning: could not attach a live watcher to ${target}. ${message} (falling back to the 1000ms poll)`,
        );
        return null;
      }
    };

    indexWatcher = attachWatchers(indexPath, onIndexChange);
    headWatcher = attachWatchers(headLogPath, onHeadChange);

    if (watchVerbosity === "periodic") {
      console.log("Watching for changes periodically... (Ctrl+C to quit)");
    } else {
      console.log("Watching for changes... (Ctrl+C to quit)");
    }
  });
}

export { detectStagedCommit, getCommittedFiles, runWatch };
