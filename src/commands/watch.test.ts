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

import { detectStagedCommit } from "./watch.js";

const tempDirs: string[] = [];

function makeTempGitRepo(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-watch-")));
  tempDirs.push(dir);
  execSync("git init", { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-watch-")));
  tempDirs.push(dir);
  return dir;
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
  it("returns the list of files staged for commit", () => {
    const dir = makeTempGitRepo();
    writeFileSync(path.join(dir, "alpha.txt"), "hello", "utf8");
    writeFileSync(path.join(dir, "beta.txt"), "world", "utf8");
    execSync("git add alpha.txt beta.txt", { cwd: dir, stdio: "ignore" });

    const staged = detectStagedCommit(dir);

    expect(staged.sort()).toEqual(["alpha.txt", "beta.txt"]);
  });

  it("returns an empty array when nothing is staged", () => {
    const dir = makeTempGitRepo();
    writeFileSync(path.join(dir, "unstaged.txt"), "data", "utf8");

    const staged = detectStagedCommit(dir);

    expect(staged).toEqual([]);
  });

  it("returns an empty array when the directory is not a git repository", () => {
    const dir = makeTempDir();

    const staged = detectStagedCommit(dir);

    expect(staged).toEqual([]);
  });
});

/*
 * Coverage gap flagged (testingAgent): runWatch() sets up fs.watch + fs.watchFile and reacts
 * to filesystem events asynchronously. A direct test would depend on watcher timing (event
 * coalescing, the 1000ms poll interval, and the debounce window) and would be flaky in CI.
 * The git/staged-detection logic it relies on is covered above via detectStagedCommit; the
 * watcher wiring itself is intentionally left for the manual smoke test (npm run start ->
 * watch -> git add) described in the plan, rather than asserted with a timing-dependent test.
 */
