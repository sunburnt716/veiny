/*
 * credentials.ts
 * --------------
 * Sole owner of .agent/credentials.json — the on-disk fallback for the LLM API key.
 *
 * This is an approved, deliberate deviation from "all .agent/ I/O goes through agentState.ts":
 * the secret has its own concern (tiered lookup, no-echo prompting, restrictive file mode,
 * .gitignore safety) and is kept isolated in its own module. agentState.ts never touches this file
 * and this module never calls into agentState.ts — each owns its own files, one concern per file.
 *
 * Path discipline: every path is derived from the caller-supplied repoRoot via path.join. Nothing
 * here is hardcoded to an absolute location.
 *
 * Security posture:
 *   - The key is preferentially read from the environment so it need never hit disk at all.
 *   - When we DO persist it, we ensure .agent/ is gitignored FIRST, then write with mode 0o600.
 *   - The interactive prompt never echoes the key to the terminal when stdin is a TTY.
 *
 * Depends on: Node built-ins only (node:fs, node:path, node:process, node:readline). No network.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as process from "node:process";
import * as readline from "node:readline";

// Canonical .agent/ layout for the credentials file — the one place these strings live in this
// module. Mirrors the style in agentState.ts (AGENT_DIR + a named file) without sharing code.
const AGENT_DIR = ".agent";
const CREDENTIALS_FILE = "credentials.json";
const GITIGNORE_FILE = ".gitignore";

// The line we ensure is present in the target repo's .gitignore so the secret is never committed.
const GITIGNORE_ENTRY = ".agent/";

// Environment variables checked, in priority order, before falling back to disk.
const ENV_KEYS = ["VEINY_LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

/** The on-disk shape of .agent/credentials.json. */
interface StoredCredentials {
  apiKey: string;
}

// --- Path helpers (all derived from repoRoot, never hardcoded) -----------------------------------

function agentDir(repoRoot: string): string {
  return path.join(repoRoot, AGENT_DIR);
}

function credentialsPath(repoRoot: string): string {
  return path.join(agentDir(repoRoot), CREDENTIALS_FILE);
}

function gitignorePath(repoRoot: string): string {
  return path.join(repoRoot, GITIGNORE_FILE);
}

// --- Defensive narrowing -------------------------------------------------------------------------

/**
 * Narrows an arbitrary parsed JSON value to a non-empty StoredCredentials, or null if it does not
 * match. Kept separate so the parse/read logic in loadApiKey stays readable. No `any`: we accept
 * `unknown` and narrow with explicit type guards.
 */
function asStoredCredentials(value: unknown): StoredCredentials | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // Index into the object only after confirming it is a plain object.
  const candidate = value as { apiKey?: unknown };
  if (typeof candidate.apiKey === "string" && candidate.apiKey.length > 0) {
    return { apiKey: candidate.apiKey };
  }
  return null;
}

// --- Public API ----------------------------------------------------------------------------------

/**
 * loadApiKey: tiered, NON-PROMPTING lookup used at watch time.
 *
 *   1. Environment — VEINY_LLM_API_KEY, then ANTHROPIC_API_KEY, then OPENAI_API_KEY. First
 *      non-empty value wins. This lets CI / shells supply the key without it ever touching disk.
 *   2. Disk — .agent/credentials.json ({ apiKey: string }). Parsed defensively; corrupt JSON or a
 *      bad shape logs a descriptive warning and falls through rather than crashing the watch loop.
 *   3. null — no key available anywhere. The caller (e.g. promptForLLM) decides whether to prompt.
 *
 * This function NEVER prompts; it is safe to call on a hot path.
 */
export function loadApiKey(repoRoot: string): string | null {
  // Tier 1: environment variables, in priority order.
  for (const name of ENV_KEYS) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  // Tier 2: the on-disk credentials file, if it exists.
  const file = credentialsPath(repoRoot);
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const stored = asStoredCredentials(parsed);
      if (stored !== null) {
        return stored.apiKey;
      }
      // File exists but is the wrong shape — warn and fall through to null.
      console.warn(
        `Warning: ${file} did not contain a valid { apiKey: string }; ignoring it.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Warning: could not parse ${file}; ignoring it. ${message}`,
      );
    }
  }

  // Tier 3: nothing found.
  return null;
}

/**
 * ensureGitignored: make certain the target repo ignores .agent/ BEFORE any secret is written.
 *
 * Reads the repo's .gitignore (if present) and appends ".agent/" only when neither ".agent/" nor
 * ".agent" already appears as a trimmed line. If .gitignore is missing it is created containing the
 * entry. Idempotent: a repo already ignoring .agent/ is left untouched. This is the single most
 * important safety step — it runs first in saveApiKey so we never persist a key into a tracked tree.
 */
export function ensureGitignored(repoRoot: string): void {
  const file = gitignorePath(repoRoot);

  if (!existsSync(file)) {
    // No .gitignore at all — create one that ignores .agent/.
    writeFileSync(file, `${GITIGNORE_ENTRY}\n`, "utf8");
    return;
  }

  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // We cannot guarantee the secret won't be committed if we can't read .gitignore — surface it
    // loudly and abort rather than writing a key into a possibly-tracked tree.
    console.error(`Error: could not read ${file} to verify .agent/ is ignored. ${message}`);
    throw error;
  }

  // Already ignored? Match either ".agent/" or ".agent" on its own (trimmed) line.
  const alreadyIgnored = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".agent/" || line === ".agent");
  if (alreadyIgnored) {
    return;
  }

  // Append our entry, ensuring we don't glue it onto a previous non-terminated line.
  const needsLeadingNewline = contents.length > 0 && !contents.endsWith("\n");
  const prefix = needsLeadingNewline ? "\n" : "";
  writeFileSync(file, `${contents}${prefix}${GITIGNORE_ENTRY}\n`, "utf8");
}

/**
 * saveApiKey: persist the key to .agent/credentials.json with locked-down permissions.
 *
 * Order matters: we gitignore .agent/ FIRST so the secret is never written into a tracked tree,
 * then create .agent/ if needed, then write the file with mode 0o600 (owner read/write only).
 */
export function saveApiKey(repoRoot: string, apiKey: string): void {
  // 1. Safety first: never write a secret into a tree that would commit it.
  ensureGitignored(repoRoot);

  // 2. Make sure .agent/ exists.
  mkdirSync(agentDir(repoRoot), { recursive: true });

  // 3. Write the credentials file: pretty JSON + trailing newline, owner-only permissions.
  const stored: StoredCredentials = { apiKey };
  writeFileSync(
    credentialsPath(repoRoot),
    `${JSON.stringify(stored, null, 2)}\n`,
    { mode: 0o600, encoding: "utf8" },
  );
}

/**
 * promptForApiKey: read a key from stdin WITHOUT echoing it, using only Node built-ins.
 *
 * Two paths:
 *   - TTY: switch stdin into raw mode and consume "data" events character-by-character so nothing
 *     is echoed. Enter (\r / \n) submits, Backspace trims the last char, Ctrl+C () exits
 *     cleanly. We always restore raw mode and clean up listeners so the process can continue.
 *   - Non-TTY (piped input): there is no way to suppress echo on a pipe, so we fall back to a plain
 *     readline question. (Piped secrets aren't shown on a terminal anyway.)
 *
 * No `any` and no `@ts-ignore`: setRawMode/isTTY are typed on process.stdin via @types/node.
 */
export function promptForApiKey(): Promise<string> {
  process.stdout.write("Enter your API key (hidden): ");

  const stdin = process.stdin;

  // --- Non-TTY fallback: a normal readline question (echo cannot be suppressed on a pipe). -------
  if (!stdin.isTTY) {
    const rl = readline.createInterface({
      input: stdin,
      output: process.stdout,
    });
    return new Promise<string>((resolve) => {
      // We've already written the prompt above, so pass an empty question string.
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  // --- TTY path: raw mode, manual echo suppression. ---------------------------------------------
  return new Promise<string>((resolve) => {
    let entered = "";

    // Restores the terminal to a sane state and detaches our listener so nothing leaks.
    const cleanup = (): void => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (chunk: string): void => {
      // chunk is a string because we set encoding "utf8" below; iterate per character so a paste
      // (multi-char chunk) is handled correctly.
      for (const char of chunk) {
        switch (char) {
          case "\r": // Enter (CR)
          case "\n": // Enter (LF)
            cleanup();
            process.stdout.write("\n");
            resolve(entered.trim());
            return;
          case "": // Ctrl+C — exit cleanly rather than leaving the terminal in raw mode.
            cleanup();
            process.stdout.write("\n");
            process.exit(130);
            return;
          case "": // DEL (common Backspace)
          case "\b": // BS
            entered = entered.slice(0, -1);
            break;
          default:
            // Ignore other control characters (anything below space) to avoid corrupting the key.
            if (char >= " ") {
              entered += char;
            }
            break;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}
