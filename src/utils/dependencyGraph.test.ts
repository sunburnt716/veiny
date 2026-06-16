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
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigSnapshot } from "../commands/init.js";
import {
  buildDependencyGraph,
  dependencyGraphExists,
  extractImports,
  resolveImport,
} from "./dependencyGraph.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "veiny-graph-")));
  tempDirs.push(dir);
  return dir;
}

// A complete-but-empty ConfigSnapshot for tests that don't exercise path aliases.
function emptyConfig(): ConfigSnapshot {
  return {
    nodeVersion: process.version,
    packageManager: "unknown",
    languageSpecificConfigs: {},
    pathAliasses: {},
    packageManagerSettings: {},
    workspaces: [],
  };
}

function write(dir: string, relativePath: string, contents: string): string {
  const full = path.join(dir, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return full;
}

function readMap(repoRoot: string, file: string): Record<string, string[]> {
  return JSON.parse(readFileSync(path.join(repoRoot, ".agent", file), "utf8"));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("extractImports", () => {
  it("captures static imports, re-exports, dynamic imports, and require calls", () => {
    const dir = makeTempDir();
    const file = write(
      dir,
      "entry.ts",
      [
        'import def from "./mod-a";',
        'import { named } from "./mod-b";',
        'export { re } from "./mod-c";',
        'export * from "./mod-d";',
        'const dyn = import("./mod-e");',
        'const req = require("./mod-f");',
      ].join("\n"),
    );

    const specifiers = extractImports(file).sort();

    expect(specifiers).toEqual(
      ["./mod-a", "./mod-b", "./mod-c", "./mod-d", "./mod-e", "./mod-f"].sort(),
    );
  });

  it("returns an empty array for a file that fails to parse", () => {
    const dir = makeTempDir();
    const file = write(dir, "broken.ts", "import { from 'oops' this is not valid");

    expect(extractImports(file)).toEqual([]);
  });
});

describe("resolveImport", () => {
  it("resolves a relative specifier to a repo-relative path", () => {
    const dir = makeTempDir();
    const importer = write(dir, "src/a.ts", "");
    write(dir, "src/b.ts", "");

    const resolved = resolveImport("./b", importer, dir, emptyConfig());

    expect(resolved).toBe("src/b.ts");
  });

  it("resolves a .js specifier to its TypeScript twin (nodenext imports)", () => {
    const dir = makeTempDir();
    const importer = write(dir, "src/a.ts", "");
    write(dir, "src/b.ts", "");

    const resolved = resolveImport("./b.js", importer, dir, emptyConfig());

    expect(resolved).toBe("src/b.ts");
  });

  it("resolves a configured path alias", () => {
    const dir = makeTempDir();
    const importer = write(dir, "src/a.ts", "");
    write(dir, "src/b.ts", "");
    const config: ConfigSnapshot = {
      ...emptyConfig(),
      pathAliasses: { "@app/*": ["src/*"] },
    };

    const resolved = resolveImport("@app/b", importer, dir, config);

    expect(resolved).toBe("src/b.ts");
  });

  it("returns null for bare/external specifiers", () => {
    const dir = makeTempDir();
    const importer = write(dir, "src/a.ts", "");

    expect(resolveImport("react", importer, dir, emptyConfig())).toBeNull();
    expect(resolveImport("node:fs", importer, dir, emptyConfig())).toBeNull();
  });
});

describe("buildDependencyGraph", () => {
  it("writes a dependency map and its exact inverse, skipping external and node_modules", () => {
    const repoRoot = makeTempDir();
    write(repoRoot, "a.ts", 'import { thing } from "./b";\nexport const a = 1;');
    write(repoRoot, "b.ts", 'import { c } from "./c.js";\nexport const thing = c;');
    write(repoRoot, "c.ts", 'import os from "node:os";\nexport const c = 3;');
    // Should never be walked.
    write(repoRoot, "node_modules/pkg/index.js", 'import "./other";');

    buildDependencyGraph(repoRoot, emptyConfig());

    const dependencyMap = readMap(repoRoot, "dependencyMap.json");
    const dependentMap = readMap(repoRoot, "dependentMap.json");

    expect(dependencyMap["a.ts"]).toEqual(["b.ts"]);
    expect(dependencyMap["b.ts"]).toEqual(["c.ts"]);
    expect(dependencyMap["c.ts"]).toEqual([]); // node:os is external -> no edge, but still a node

    // Inverse mirrors the forward edges.
    expect(dependentMap["b.ts"]).toEqual(["a.ts"]);
    expect(dependentMap["c.ts"]).toEqual(["b.ts"]);

    // node_modules content excluded entirely.
    const allKeys = [...Object.keys(dependencyMap), ...Object.keys(dependentMap)];
    expect(allKeys.some((key) => key.includes("node_modules"))).toBe(false);
  });
});

describe("dependencyGraphExists", () => {
  it("is false before a build and true after", () => {
    const repoRoot = makeTempDir();
    write(repoRoot, "a.ts", "export const a = 1;");

    expect(dependencyGraphExists(repoRoot)).toBe(false);

    buildDependencyGraph(repoRoot, emptyConfig());

    expect(dependencyGraphExists(repoRoot)).toBe(true);
  });
});

/*
 * Coverage gap flagged (testingAgent): the index.ts "start" reparse prompt is interactive
 * (readline on stdin). Exercising the y/n branch would require simulating stdin, which the
 * testingAgent rules avoid; it is left to the manual smoke test (npm run start -> start twice)
 * described in the plan.
 */
