import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { FileDiff } from "../core/types.js";
import { detectStagedCommit, getCommittedFiles } from "./watch.js";

const tempDirs: string[] = [];

function makeTempGitRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-watch-")));
  tempDirs.push(dir);
  execSync("git init", { cwd: dir, stdio: "ignore" });
  // Identity so commits succeed in a clean CI environment.
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Veiny Test"', { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-watch-")));
  tempDirs.push(dir);
  return dir;
}

function findDiff(diffs: FileDiff[], filePath: string): FileDiff {
  const match = diffs.find((d) => d.filePath === filePath);
  if (!match) {
    throw new Error(`expected a FileDiff for ${filePath}, got: ${JSON.stringify(diffs)}`);
  }
  return match;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("detectStagedCommit", () => {
  it("returns FileDiff[] with repo-relative paths for newly staged files", () => {
    const dir = makeTempGitRepo();
    writeFileSync(path.join(dir, "alpha.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(path.join(dir, "beta.ts"), "export const b = 2;\n", "utf8");
    execSync("git add alpha.ts beta.ts", { cwd: dir, stdio: "ignore" });

    const diffs = detectStagedCommit(dir);

    const paths = diffs.map((d) => d.filePath).sort();
    expect(paths).toEqual(["alpha.ts", "beta.ts"]);
  });

  it("parses new-side hunk ranges (startLine/lineCount) for a staged edit", () => {
    const dir = makeTempGitRepo();
    // Commit a baseline so the modification produces a real hunk header.
    const baseline = [
      "export const one = 1;",
      "export const two = 2;",
      "export const three = 3;",
      "",
    ].join("\n");
    writeFileSync(path.join(dir, "mod.ts"), baseline, "utf8");
    execSync("git add mod.ts", { cwd: dir, stdio: "ignore" });
    execSync("git commit -m baseline", { cwd: dir, stdio: "ignore" });

    // Change line 2 only, then stage it.
    const edited = [
      "export const one = 1;",
      "export const two = 22;",
      "export const three = 3;",
      "",
    ].join("\n");
    writeFileSync(path.join(dir, "mod.ts"), edited, "utf8");
    execSync("git add mod.ts", { cwd: dir, stdio: "ignore" });

    const diffs = detectStagedCommit(dir);

    const modDiff = findDiff(diffs, "mod.ts");
    expect(modDiff.hunks.length).toBeGreaterThanOrEqual(1);
    // With -U0, the changed line 2 is reported as a single new-side line at startLine 2.
    expect(modDiff.hunks).toContainEqual({ startLine: 2, lineCount: 1 });
  });

  it("returns an empty array when nothing is staged", () => {
    const dir = makeTempGitRepo();
    // Present but unstaged -> not in `git diff --cached`.
    writeFileSync(path.join(dir, "unstaged.ts"), "export const u = 0;\n", "utf8");

    const diffs = detectStagedCommit(dir);

    expect(diffs).toEqual([]);
  });

  it("returns an empty array when the directory is not a git repository", () => {
    const dir = makeTempDir();

    const diffs = detectStagedCommit(dir);

    expect(diffs).toEqual([]);
  });
});

describe("getCommittedFiles", () => {
  it("returns the repo-relative files from the most recent commit", () => {
    const dir = makeTempGitRepo();
    // A baseline commit first: getCommittedFiles uses `git diff-tree HEAD`, which compares HEAD to
    // its parent. The watch feature only ever observes commits in an established repo, so the
    // realistic case is a commit that HAS a parent. (See the flagged root-commit gap below.)
    writeFileSync(path.join(dir, "baseline.ts"), "export const base = 0;\n", "utf8");
    execSync("git add baseline.ts", { cwd: dir, stdio: "ignore" });
    execSync("git commit -m baseline", { cwd: dir, stdio: "ignore" });

    writeFileSync(path.join(dir, "alpha.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(path.join(dir, "beta.ts"), "export const b = 2;\n", "utf8");
    execSync("git add alpha.ts beta.ts", { cwd: dir, stdio: "ignore" });
    execSync("git commit -m feature", { cwd: dir, stdio: "ignore" });

    const committed = getCommittedFiles(dir);

    // Only the files from the most recent commit (HEAD vs its parent), not the baseline.
    expect(committed.sort()).toEqual(["alpha.ts", "beta.ts"]);
  });

  it("returns [] for a directory that is not a git repository", () => {
    const dir = makeTempDir();

    expect(getCommittedFiles(dir)).toEqual([]);
  });

  it("returns the files of a root (first) commit via --root", () => {
    const dir = makeTempGitRepo();
    // A parentless first commit: with the --root flag getCommittedFiles still lists its full tree.
    writeFileSync(path.join(dir, "first.ts"), "export const f = 1;\n", "utf8");
    execSync("git add first.ts", { cwd: dir, stdio: "ignore" });
    execSync("git commit -m first", { cwd: dir, stdio: "ignore" });

    expect(getCommittedFiles(dir)).toEqual(["first.ts"]);
  });

  it("returns [] for a git repository with no commits", () => {
    const dir = makeTempGitRepo();
    // Staged but never committed -> HEAD does not resolve.
    writeFileSync(path.join(dir, "alpha.ts"), "export const a = 1;\n", "utf8");
    execSync("git add alpha.ts", { cwd: dir, stdio: "ignore" });

    expect(getCommittedFiles(dir)).toEqual([]);
  });
});

/*
 * Coverage gap flagged (testingAgent): runWatch() sets up fs.watch + fs.watchFile and reacts
 * to filesystem events asynchronously. A direct test would depend on watcher timing (event
 * coalescing, the 1000ms poll interval, and the debounce window) and would be flaky in CI.
 * The git/staged-detection logic it relies on is covered above via detectStagedCommit; the
 * watcher wiring itself is intentionally left for the manual smoke test (npm run start ->
 * watch -> git add) described in the plan, rather than asserted with a timing-dependent test.
 *
 * Resolved (was a flagged gap): getCommittedFiles originally used `git diff-tree ... HEAD`, which
 * compares HEAD to its parent and prints nothing for a parentless ROOT commit. The source now passes
 * `--root`, so first commits list their full tree too — asserted by the "root (first) commit" test
 * above. `--root` has no effect on ordinary (parented) commits.
 */
