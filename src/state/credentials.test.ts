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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureGitignored, loadApiKey, saveApiKey } from "./credentials.js";

const tempDirs: string[] = [];

// The env vars loadApiKey consults, in priority order. We snapshot and clear them before each test
// so a CI environment that already exports e.g. ANTHROPIC_API_KEY can't taint the file-fallback /
// null cases, and restore them afterwards.
const ENV_KEYS = [
  "VEINY_LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-creds-")));
  tempDirs.push(dir);
  return dir;
}

function writeCredentialsFile(repoRoot: string, contents: string): void {
  mkdirSync(path.join(repoRoot, ".agent"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".agent", "credentials.json"), contents, "utf8");
}

function readGitignore(repoRoot: string): string {
  return readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = savedEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadApiKey", () => {
  it("prefers VEINY_LLM_API_KEY over an on-disk credentials file", () => {
    const repoRoot = makeTempDir();
    writeCredentialsFile(repoRoot, JSON.stringify({ apiKey: "file-key" }));
    process.env.VEINY_LLM_API_KEY = "env-key";

    expect(loadApiKey(repoRoot)).toBe("env-key");
  });

  it("falls back to the credentials file when no env var is set", () => {
    const repoRoot = makeTempDir();
    writeCredentialsFile(repoRoot, JSON.stringify({ apiKey: "file-key" }));

    expect(loadApiKey(repoRoot)).toBe("file-key");
  });

  it("returns null when neither env var nor file is present", () => {
    const repoRoot = makeTempDir();

    expect(loadApiKey(repoRoot)).toBeNull();
  });
});

describe("ensureGitignored", () => {
  it("creates .gitignore containing .agent/ when none exists", () => {
    const repoRoot = makeTempDir();

    ensureGitignored(repoRoot);

    expect(existsSync(path.join(repoRoot, ".gitignore"))).toBe(true);
    expect(readGitignore(repoRoot)).toContain(".agent/");
  });

  it("appends .agent/ when missing from an existing .gitignore", () => {
    const repoRoot = makeTempDir();
    writeFileSync(path.join(repoRoot, ".gitignore"), "node_modules\n", "utf8");

    ensureGitignored(repoRoot);

    const contents = readGitignore(repoRoot);
    expect(contents).toContain("node_modules");
    expect(contents).toContain(".agent/");
  });

  it("is a no-op (idempotent) when .agent/ is already present", () => {
    const repoRoot = makeTempDir();
    writeFileSync(
      path.join(repoRoot, ".gitignore"),
      "node_modules\n.agent/\n",
      "utf8",
    );

    ensureGitignored(repoRoot);

    const contents = readGitignore(repoRoot);
    // Exactly one occurrence of the .agent/ entry — it was not appended a second time.
    const occurrences = contents
      .split(/\r?\n/)
      .filter((line) => line.trim() === ".agent/").length;
    expect(occurrences).toBe(1);
  });
});

describe("saveApiKey", () => {
  it("writes credentials.json containing the key and ensures .agent/ is gitignored", () => {
    const repoRoot = makeTempDir();

    saveApiKey(repoRoot, "my-secret-key");

    const credPath = path.join(repoRoot, ".agent", "credentials.json");
    expect(existsSync(credPath)).toBe(true);
    const stored: unknown = JSON.parse(readFileSync(credPath, "utf8"));
    expect(stored).toEqual({ apiKey: "my-secret-key" });

    // Safety: .agent/ must be gitignored so the secret is never committed.
    expect(readGitignore(repoRoot)).toContain(".agent/");

    // And it round-trips through loadApiKey (no env var set in this test).
    expect(loadApiKey(repoRoot)).toBe("my-secret-key");
  });
});

/*
 * Coverage gap flagged (testingAgent): promptForApiKey() reads a key from stdin with no echo
 * (raw-mode TTY handling / readline on a pipe). Exercising it would require simulating stdin and
 * raw-mode terminal events, which the testingAgent rules avoid in favor of real I/O. It is left to
 * a manual smoke test rather than asserted against invented stdin behavior.
 */
