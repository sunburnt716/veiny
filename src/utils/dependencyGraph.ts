/*
 * dependencyGraph.ts
 * ------------------
 * Builds Veiny's two dependency-graph files inside the target repo's .agent/ folder:
 *
 *   - dependencyMap.json : each source file -> the repo-internal files it imports (depends on)
 *   - dependentMap.json  : the exact inverse -> each file -> the files that import it (depend on it)
 *
 * Both files are keyed by paths RELATIVE to repoRoot (forward slashes), so the graph is portable
 * and easy for other agents/humans to cross-reference. Parsing is done with Babel's AST so we
 * understand real import/export relationships rather than guessing with text matching.
 *
 * Flow: buildDependencyGraph() asks agentState to create the files, walkAndParse() recurses the
 * tree calling extractImports() + resolveImport() per file and addEdge() per edge (mutating
 * in-memory maps), then agentState persists the populated maps once. All .agent/ writes go through
 * src/state/agentState.ts — this module never touches the .agent/ directory directly.
 */

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import type { NodePath, TraverseOptions } from "@babel/traverse";
import type {
  CallExpression,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  Node,
} from "@babel/types";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import * as path from "node:path";
import type { ConfigSnapshot } from "../commands/init.js";
import type { DependencyMap, DependencyMaps } from "../core/types.js";
import {
  initializeDependencyGraph,
  writeDependencyMaps,
} from "../state/agentState.js";

/*
 * @babel/traverse is published as CommonJS. Imported under ESM the namespace object is what we
 * receive, and the actual callable lives on `.default`. Normalize once so the rest of the file
 * just calls `traverse(...)`. The `?? traverseExport` keeps it working if a future build exposes
 * the function directly.
 */
type TraverseFunction = (node: Node, options: TraverseOptions) => void;
const traverseExport = _traverse as unknown as TraverseFunction & {
  default?: TraverseFunction;
};
const traverse: TraverseFunction = traverseExport.default ?? traverseExport;

// Extensions we treat as source files to parse, and that we try when resolving an extensionless
// import specifier.
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
] as const;

// nodenext TypeScript imports its .ts files using a .js specifier (e.g. "./init.js" -> init.ts),
// so when a JS-ish specifier doesn't exist on disk we also look for its TypeScript twin.
const JS_TO_TS_TWINS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

// Directories we never descend into while walking.
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".agent"]);

// Absolute path -> repo-relative key with forward slashes (stable across OSes).
function toRepoRelative(absolutePath: string, repoRoot: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function isSourceFile(filename: string): boolean {
  return (SOURCE_EXTENSIONS as readonly string[]).includes(path.extname(filename));
}

/**
 * extractImports: parse a single file with Babel and return every module specifier it references
 * (static imports, re-exports, dynamic import(), and require()). Returns the RAW specifier strings
 * — resolution to repo-relative file paths happens later in resolveImport(). A read/parse failure
 * on one file logs a warning and returns [] so it can never abort the whole walk.
 */
function extractImports(filepath: string): string[] {
  let sourceCode: string;
  try {
    sourceCode = readFileSync(filepath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: could not read ${filepath} while extracting imports. ${message}`);
    return [];
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(sourceCode, {
      // "unambiguous" lets Babel auto-detect ESM vs CommonJS so we handle the whole codebase.
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: could not parse ${filepath}; skipping it. ${message}`);
    return [];
  }

  const specifiers: string[] = [];

  traverse(ast, {
    // `import x from "y"` / bare `import "y"`
    ImportDeclaration(nodePath: NodePath<ImportDeclaration>) {
      specifiers.push(nodePath.node.source.value);
    },
    // `export { x } from "y"` (only when there is a source to re-export from)
    ExportNamedDeclaration(nodePath: NodePath<ExportNamedDeclaration>) {
      if (nodePath.node.source) {
        specifiers.push(nodePath.node.source.value);
      }
    },
    // `export * from "y"`
    ExportAllDeclaration(nodePath: NodePath<ExportAllDeclaration>) {
      specifiers.push(nodePath.node.source.value);
    },
    // dynamic `import("y")` and CommonJS `require("y")`
    CallExpression(nodePath: NodePath<CallExpression>) {
      const callee = nodePath.node.callee;
      const isDynamicImport = callee.type === "Import";
      const isRequire = callee.type === "Identifier" && callee.name === "require";
      if (!isDynamicImport && !isRequire) {
        return;
      }
      const firstArg = nodePath.node.arguments[0];
      if (firstArg && firstArg.type === "StringLiteral") {
        specifiers.push(firstArg.value);
      }
    },
  });

  return specifiers;
}

/**
 * resolveImport: turn a raw specifier into a repo-relative path to an existing file, or null.
 * Only relative ("./x", "../x") and configured path-alias specifiers can point inside the repo;
 * bare specifiers ("react", "node:fs", "@scope/pkg") are external dependencies and are not edges.
 */
function resolveImport(
  specifier: string,
  importerAbsPath: string,
  repoRoot: string,
  config: ConfigSnapshot,
): string | null {
  let candidateBase: string | null = null;

  if (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    candidateBase = path.resolve(path.dirname(importerAbsPath), specifier);
  } else {
    candidateBase = resolveAlias(specifier, repoRoot, config);
  }

  if (candidateBase === null) {
    return null;
  }

  const resolvedAbs = resolveToExistingFile(candidateBase);
  if (resolvedAbs === null) {
    return null;
  }

  return toRepoRelative(resolvedAbs, repoRoot);
}

/**
 * resolveAlias: expand a tsconfig path alias (e.g. "@app/*": ["src/*"]) into an absolute base
 * path under repoRoot. Targets are resolved relative to repoRoot. Returns null if no alias matches.
 */
function resolveAlias(
  specifier: string,
  repoRoot: string,
  config: ConfigSnapshot,
): string | null {
  for (const [alias, targets] of Object.entries(config.pathAliasses)) {
    const target = targets[0];
    if (target === undefined) {
      continue;
    }

    if (alias.endsWith("/*")) {
      const aliasPrefix = alias.slice(0, -1); // drop the "*", keep the trailing slash
      if (specifier.startsWith(aliasPrefix)) {
        const remainder = specifier.slice(aliasPrefix.length);
        const targetPrefix = target.endsWith("/*") ? target.slice(0, -1) : target;
        return path.resolve(repoRoot, targetPrefix + remainder);
      }
    } else if (specifier === alias) {
      return path.resolve(repoRoot, target);
    }
  }

  return null;
}

/**
 * resolveToExistingFile: given a base absolute path (possibly without/with a JS extension), find
 * the real source file on disk by trying, in order: the path as-is, its TypeScript twin if it was
 * a JS specifier, the path plus each known source extension, then a directory index file.
 */
function resolveToExistingFile(basePath: string): string | null {
  const candidates: string[] = [basePath];

  const ext = path.extname(basePath);
  const tsTwins = JS_TO_TS_TWINS[ext];
  if (tsTwins) {
    const withoutExt = basePath.slice(0, -ext.length);
    for (const tsExt of tsTwins) {
      candidates.push(withoutExt + tsExt);
    }
  }

  for (const sourceExt of SOURCE_EXTENSIONS) {
    candidates.push(basePath + sourceExt);
  }
  for (const sourceExt of SOURCE_EXTENSIONS) {
    candidates.push(path.join(basePath, `index${sourceExt}`));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

/**
 * addEdge: record one importer -> imported relationship into BOTH in-memory maps (forward and
 * inverse). Mutates the maps only; persistence is a single write at the end of the build.
 */
function addEdge(maps: DependencyMaps, importer: string, imported: string): void {
  pushUnique(maps.dependencyMap, importer, imported); // importer depends on imported
  pushUnique(maps.dependentMap, imported, importer); // imported is depended on by importer
}

function pushUnique(map: DependencyMap, key: string, value: string): void {
  const existing = map[key];
  if (existing === undefined) {
    map[key] = [value];
    return;
  }
  if (!existing.includes(value)) {
    existing.push(value);
  }
}

// Make sure a parsed file appears as a node in the forward map even if it imports nothing.
function ensureNode(maps: DependencyMaps, file: string): void {
  if (maps.dependencyMap[file] === undefined) {
    maps.dependencyMap[file] = [];
  }
}

/**
 * walkAndParse: recurse from `dir`, skipping ignored directories, and for every source file
 * extract its imports, resolve the repo-internal ones, and record edges into `maps`. A directory
 * that can't be read logs a warning and is skipped rather than aborting the build.
 */
function walkAndParse(
  dir: string,
  repoRoot: string,
  config: ConfigSnapshot,
  maps: DependencyMaps,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: could not read directory ${dir}; skipping it. ${message}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        walkAndParse(entryPath, repoRoot, config, maps);
      }
      continue;
    }

    if (!entry.isFile() || !isSourceFile(entry.name)) {
      continue;
    }

    const importerRel = toRepoRelative(entryPath, repoRoot);
    ensureNode(maps, importerRel);

    for (const specifier of extractImports(entryPath)) {
      const importedRel = resolveImport(specifier, entryPath, repoRoot, config);
      if (importedRel !== null) {
        addEdge(maps, importerRel, importedRel);
      }
    }
  }
}

/**
 * buildDependencyGraph: the single entry point used by the "start" command. Asks agentState to
 * create the files, builds both maps in memory by walking/parsing the codebase, persists them once
 * (again via agentState), and logs a human-readable success summary.
 */
function buildDependencyGraph(repoRoot: string, config: ConfigSnapshot): void {
  initializeDependencyGraph(repoRoot);

  const maps: DependencyMaps = { dependencyMap: {}, dependentMap: {} };
  walkAndParse(repoRoot, repoRoot, config, maps);

  writeDependencyMaps(repoRoot, maps);

  const fileCount = Object.keys(maps.dependencyMap).length;
  const edgeCount = Object.values(maps.dependencyMap).reduce(
    (sum, list) => sum + list.length,
    0,
  );
  console.log(
    `Dependency graph built: ${fileCount} source file(s), ${edgeCount} internal import edge(s).`,
  );
  console.log("  Written to .agent/dependencyMap.json and .agent/dependentMap.json.");
}

export { addEdge, buildDependencyGraph, extractImports, resolveImport, walkAndParse };
// dependencyGraphExists lives in the state layer; re-exported here for existing callers/tests.
export { dependencyGraphExists } from "../state/agentState.js";
