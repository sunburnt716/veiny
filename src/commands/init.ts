import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeAgentState } from "../state/agentState.js";

type JsonRecord = Record<string, unknown>;

type ConfigSnapshot = {
  nodeVersion: string;
  packageManager: string;
  languageSpecificConfigs: JsonRecord;
  pathAliasses: Record<string, string[]>;
  packageManagerSettings: JsonRecord;
  workspaces: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): JsonRecord | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const fileContents = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(fileContents);

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function validateGitRepo(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "Error: current directory is not inside a Git repository. Please run this command from an existing repo or initialize one with git init.";
  }
}

function captureConfig(repoRoot: string): ConfigSnapshot {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const tsconfigPath = path.join(repoRoot, "tsconfig.json");
  const packageJson = readJsonFile(packageJsonPath);
  const tsconfig = readJsonFile(tsconfigPath);

  const lockfiles: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];

  let packageManager = "unknown";
  for (const [lockfile, manager] of lockfiles) {
    if (existsSync(path.join(repoRoot, lockfile))) {
      packageManager = manager;
      break;
    }
  }

  if (packageJson && typeof packageJson.packageManager === "string") {
    packageManager = packageJson.packageManager;
  }

  const compilerOptions =
    tsconfig && isRecord(tsconfig.compilerOptions)
      ? tsconfig.compilerOptions
      : {};

  const pathAliases: Record<string, string[]> = {};
  const paths = compilerOptions.paths;
  if (isRecord(paths)) {
    for (const [alias, targets] of Object.entries(paths)) {
      pathAliases[alias] = normalizeStringArray(targets);
    }
  }

  const workspaces =
    packageJson && Array.isArray(packageJson.workspaces)
      ? normalizeStringArray(packageJson.workspaces)
      : packageJson &&
          isRecord(packageJson.workspaces) &&
          Array.isArray(packageJson.workspaces.packages)
        ? normalizeStringArray(packageJson.workspaces.packages)
        : [];

  return {
    nodeVersion: process.version,
    packageManager,
    languageSpecificConfigs: {
      tsconfig: tsconfig ?? null,
      compilerOptions,
    },
    pathAliasses: pathAliases,
    packageManagerSettings: {
      packageManagerField: packageJson?.packageManager ?? null,
      engines: packageJson?.engines ?? null,
      private: packageJson?.private ?? null,
      lockfilePresent: packageManager,
    },
    workspaces,
  };
}

async function promptForContext(): Promise<string> {
  const interfaceInstance = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    const shouldProvideContext = (
      await interfaceInstance.question(
        "Would you like to provide additional context for the agent? (y/n): ",
      )
    )
      .trim()
      .toLowerCase();

    if (shouldProvideContext !== "y" && shouldProvideContext !== "yes") {
      return "";
    }

    return (
      await interfaceInstance.question("Enter additional context: ")
    ).trim();
  } finally {
    interfaceInstance.close();
  }
}

async function runInit(): Promise<void> {
  const repoRoot = validateGitRepo();

  if (repoRoot.startsWith("Error:")) {
    console.error(repoRoot);
    return;
  }

  const config = captureConfig(repoRoot);
  const context = await promptForContext();

  writeAgentState(repoRoot, config, context);

  console.log(`Agent state saved to ${path.join(repoRoot, ".agent")}`);
}

export {
  captureConfig,
  promptForContext,
  runInit,
  validateGitRepo,
  writeAgentState,
};
export type { ConfigSnapshot };
