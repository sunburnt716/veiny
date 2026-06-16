/* This file is a little different because it is using functions a little differently than we have been using
in other files in this codebase. The functions specifically are going to be actions taken after a trigger,
that are primarily based off of fs.watch and fs.watchFile. What we are trying to do here is watch for changes
in the git folder specifically in the index file, and then trigger functionalities for what the staged files
are and how to analyze them based off the codebase. We watch repoRoot/.git/index to know when a file gets
staged, and run fs.watchFile every 1000ms on the same file as a backup (git rewrites .git/index atomically on
`git add`, which can silently break a lone fs.watch watcher). */

import { execSync } from "node:child_process";
import { watch, watchFile, type FSWatcher } from "node:fs";
import * as path from "node:path";
import { validateGitRepo } from "./init.js";

// Verbosity for watch output. Defaults to "periodic" so we don't spam "Watching for
// changes" when it isn't useful.
// TODO: move this into .agent/ config (via src/state) so the user can change it later.
type WatchVerbosity = "verbose" | "periodic";
const watchVerbosity: WatchVerbosity = "periodic";

function detectStagedCommit(repoRoot: string): string[] {
  /* This function is responsible for understanding what files are staged for a commit when the logic earlier
understands that a change has happened in the codebase. This will help us to begin running our analysis on the
staged files. We use "git diff --cached --name-only" to understand what files are staged for commit. */
  try {
    const output = execSync("git diff --cached --name-only", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stagedFiles = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (stagedFiles.length > 0) {
      console.log(
        `Detected staged change — ${stagedFiles.length} file(s) staged for commit:`,
      );
      for (const file of stagedFiles) {
        console.log(`  • ${file}`);
      }
    } else {
      console.log("Index changed, but no files are currently staged for commit.");
    }

    return stagedFiles;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Error: failed to read staged files via 'git diff --cached --name-only'. ${message}`,
    );
    return [];
  }
}

function runDiffAnalysis(): void {
  // This is a placeholder function. Do not make any changes here for now.
}

async function runWatch(): Promise<void> {
  const repoRoot = validateGitRepo();

  if (repoRoot.startsWith("Error:")) {
    console.error(repoRoot);
    return;
  }

  const indexPath = path.join(repoRoot, ".git", "index");

  // Debounce the two watch sources (fs.watch + fs.watchFile) through a single handler so a
  // single `git add` doesn't trigger duplicate analysis passes.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const onIndexChange = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      const stagedFiles = detectStagedCommit(repoRoot);
      if (stagedFiles.length > 0) {
        runDiffAnalysis();
      }
    }, 100);
  };

  // Backup poll every 1000ms. watchFile tolerates the index not existing yet (a brand-new
  // repo has no .git/index until the first `git add`) and fires once it appears, so it is set
  // up first and unconditionally as the guaranteed safety net.
  watchFile(indexPath, { interval: 1000 }, onIndexChange);

  // Primary watcher: lower latency than the poll, but fs.watch throws if .git/index does not
  // exist yet and can be broken by git's atomic index replacement. If it cannot attach we log
  // a warning and keep going — the 1000ms poll above still covers us.
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

export { detectStagedCommit, runDiffAnalysis, runWatch };
