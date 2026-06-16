import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureConfig, validateGitRepo, writeAgentState } from "./init.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-test-")));
  tempDirs.push(dir);
  return dir;
}

function normalize(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("captureConfig", () => {
  it("reads package manager, path aliases, and workspaces from a project", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@9.0.0",
        workspaces: ["packages/*"],
      }),
      "utf8",
    );
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@app/*": ["src/*"] } },
      }),
      "utf8",
    );

    const config = captureConfig(dir);

    expect(config.packageManager).toBe("pnpm@9.0.0");
    expect(config.pathAliasses).toEqual({ "@app/*": ["src/*"] });
    expect(config.workspaces).toEqual(["packages/*"]);
    expect(config.nodeVersion).toBe(process.version);
  });

  it("detects the package manager from a lockfile when no field is set", () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({}), "utf8");
    writeFileSync(path.join(dir, "package-lock.json"), "{}", "utf8");

    const config = captureConfig(dir);

    expect(config.packageManager).toBe("npm");
  });

  it("returns safe defaults for an empty directory", () => {
    const dir = makeTempDir();

    const config = captureConfig(dir);

    expect(config.packageManager).toBe("unknown");
    expect(config.pathAliasses).toEqual({});
    expect(config.workspaces).toEqual([]);
  });
});

describe("writeAgentState", () => {
  it("writes repoInfo and configInfo and userContext when context is provided", () => {
    const dir = makeTempDir();
    const config = captureConfig(dir);

    writeAgentState(dir, config, "some project context");

    const agentDir = path.join(dir, ".agent");
    expect(existsSync(path.join(agentDir, "repoInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "configInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "userContext.md"))).toBe(true);

    const repoInfo = JSON.parse(
      readFileSync(path.join(agentDir, "repoInfo.json"), "utf8"),
    );
    expect(repoInfo.repoRoot).toBe(dir);
    expect(readFileSync(path.join(agentDir, "userContext.md"), "utf8")).toContain(
      "some project context",
    );
  });

  it("skips userContext.md when context is empty", () => {
    const dir = makeTempDir();
    const config = captureConfig(dir);

    writeAgentState(dir, config, "");

    const agentDir = path.join(dir, ".agent");
    expect(existsSync(path.join(agentDir, "repoInfo.json"))).toBe(true);
    expect(existsSync(path.join(agentDir, "userContext.md"))).toBe(false);
  });
});

describe("validateGitRepo", () => {
  it("returns the repo root when run inside a git repository", () => {
    const dir = makeTempDir();
    execSync("git init", { cwd: dir, stdio: "ignore" });
    process.chdir(dir);

    const result = validateGitRepo();

    expect(result.startsWith("Error:")).toBe(false);
    expect(normalize(result)).toBe(normalize(dir));
  });

  it("returns an error string when run outside a git repository", () => {
    const dir = makeTempDir();
    process.chdir(dir);

    const result = validateGitRepo();

    expect(result.startsWith("Error:")).toBe(true);
  });
});

/*
 * Coverage gaps flagged (testingAgent): promptForContext() and runInit() both read
 * developer input from stdin via readline. There is no spec for non-interactive behavior,
 * and exercising them would require simulating/mocking stdin (which the testingAgent rules
 * say to avoid in favor of real I/O). They are intentionally left untested and flagged here
 * rather than tested against invented assumptions.
 */
