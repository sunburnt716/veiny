/*
 * agentState.ts
 * -------------
 * The single boundary for all reads and writes of the .agent/ runtime directory. Every other
 * module derives nothing about .agent/ on its own — it calls in here. Centralizing this keeps
 * file-path construction in one place (all derived from repoRoot, never hardcoded) and makes the
 * persistence format easy to evolve.
 *
 * Files owned here:
 *   - repoInfo.json       : resolved repo root (from init)
 *   - configInfo.json     : build-config snapshot (from init)
 *   - userContext.md      : optional developer-supplied context (from init)
 *   - dependencyMap.json  : each file -> what it imports (from the graph builder)
 *   - dependentMap.json   : each file -> what imports it (from the graph builder)
 *   - report.json         : latest deterministic analysis result (from the analysis engine)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ConfigSnapshot } from "../commands/init.js";
import type {
  DependencyMaps,
  DependentMap,
  ReportEntry,
  VerificationEntry,
} from "../core/types.js";

// Canonical .agent/ filenames — the one place these strings live.
const AGENT_DIR = ".agent";
const FILES = {
  repoInfo: "repoInfo.json",
  configInfo: "configInfo.json",
  userContext: "userContext.md",
  dependencyMap: "dependencyMap.json",
  dependentMap: "dependentMap.json",
  report: "report.json",
  verifications: "verifications.json",
} as const;

function agentDir(repoRoot: string): string {
  return path.join(repoRoot, AGENT_DIR);
}

function agentFile(repoRoot: string, name: string): string {
  return path.join(agentDir(repoRoot), name);
}

function ensureAgentDir(repoRoot: string): void {
  mkdirSync(agentDir(repoRoot), { recursive: true });
}

// Pretty-print JSON with a trailing newline (matches the project's existing on-disk format).
function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * writeAgentState: persist the init-time state. Skips userContext.md when no context was given.
 * (Migrated unchanged from init.ts so all .agent/ writes live here.)
 */
function writeAgentState(
  repoRoot: string,
  config: ConfigSnapshot,
  context: string,
): void {
  ensureAgentDir(repoRoot);
  writeJson(agentFile(repoRoot, FILES.repoInfo), { repoRoot });
  writeJson(agentFile(repoRoot, FILES.configInfo), config);
  if (context.trim().length > 0) {
    writeFileSync(
      agentFile(repoRoot, FILES.userContext),
      `${context.trim()}\n`,
      "utf8",
    );
  }
}

/**
 * initializeDependencyGraph: create .agent/ and write both graph files initialized to {} so they
 * always exist after a build is started. (Migrated from dependencyGraph.ts.)
 */
function initializeDependencyGraph(repoRoot: string): void {
  ensureAgentDir(repoRoot);
  writeJson(agentFile(repoRoot, FILES.dependencyMap), {});
  writeJson(agentFile(repoRoot, FILES.dependentMap), {});
}

/**
 * writeDependencyMaps: persist the populated graph maps — one write per file, no per-edge I/O.
 * (Migrated from dependencyGraph.ts.)
 */
function writeDependencyMaps(repoRoot: string, maps: DependencyMaps): void {
  ensureAgentDir(repoRoot);
  writeJson(agentFile(repoRoot, FILES.dependencyMap), maps.dependencyMap);
  writeJson(agentFile(repoRoot, FILES.dependentMap), maps.dependentMap);
}

// True only when BOTH graph files already exist in .agent/.
function dependencyGraphExists(repoRoot: string): boolean {
  return (
    existsSync(agentFile(repoRoot, FILES.dependencyMap)) &&
    existsSync(agentFile(repoRoot, FILES.dependentMap))
  );
}

/**
 * readDependentMap: load dependentMap.json (file -> who imports it) for the analysis engine.
 * Returns {} if the file is absent (the caller decides whether to prompt to build it). A corrupt
 * file logs a descriptive warning and degrades to {} rather than crashing the watch loop.
 */
function readDependentMap(repoRoot: string): DependentMap {
  const file = agentFile(repoRoot, FILES.dependentMap);
  if (!existsSync(file)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as DependentMap;
    }
    console.warn(`Warning: ${file} is not a valid dependent map; treating it as empty.`);
    return {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: could not read ${file}; treating it as empty. ${message}`);
    return {};
  }
}

/**
 * writeReport: persist the deterministic analysis result. This is the SINGLE write at the end of
 * an analysis pass — analysis functions never touch disk themselves.
 */
function writeReport(repoRoot: string, report: ReportEntry[]): void {
  ensureAgentDir(repoRoot);
  writeJson(agentFile(repoRoot, FILES.report), report);
}

/**
 * readVerifications: load the accumulated accuracy-feedback log. Returns [] when the file is absent;
 * a corrupt/non-array file logs a descriptive warning and degrades to [] (consistent with
 * readDependentMap) rather than crashing the watch loop.
 */
function readVerifications(repoRoot: string): VerificationEntry[] {
  const file = agentFile(repoRoot, FILES.verifications);
  if (!existsSync(file)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) {
      return parsed as VerificationEntry[];
    }
    console.warn(`Warning: ${file} is not a valid verification log; treating it as empty.`);
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: could not read ${file}; treating it as empty. ${message}`);
    return [];
  }
}

/**
 * recordVerification: append one accuracy-feedback record to .agent/verifications.json, preserving
 * prior entries. The verification log is an append-only history of "did Veiny's catches match what
 * was committed, per the developer".
 */
function recordVerification(repoRoot: string, entry: VerificationEntry): void {
  const entries = readVerifications(repoRoot);
  entries.push(entry);
  ensureAgentDir(repoRoot);
  writeJson(agentFile(repoRoot, FILES.verifications), entries);
}

export {
  dependencyGraphExists,
  initializeDependencyGraph,
  readDependentMap,
  readVerifications,
  recordVerification,
  writeAgentState,
  writeDependencyMaps,
  writeReport,
};
