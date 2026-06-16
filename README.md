# Veiny

![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

A command-line developer tool that maps how a codebase fits together and watches for staged
changes so they can be analyzed **before a commit lands** — not after CI fails. The name reflects
the core idea: tracing how a change flows through a project the way blood moves through veins.

> **Status:** active development. The codebase parser and the git-staging watcher are implemented
> and tested; the diff-analysis engine that consumes them is the current focus (see [Roadmap](#roadmap)).

---

## Overview

Most pre-commit tooling treats a changeset as a flat list of files. That misses the question that
actually matters during review: *what else does this change affect?* A one-line edit to a widely
imported module is not the same risk as an edit to a leaf file, but a plain `git diff` presents
them identically.

Veiny builds a **dependency graph** of the project from its real import/export relationships, then
**watches the git index** so that the moment files are staged it knows both *what* changed and
*which other files depend on it*. That graph is the foundation the analysis layer will use to flag
high-impact or risky changes ahead of time.

## Features

- **Interactive CLI shell** with `start`, `watch`, and `quit` commands.
- **Project initialization (`start`)** — validates the git repository, captures a build-config
  snapshot (package manager, TypeScript config, path aliases, workspaces), optionally records
  developer-supplied context, and persists everything under `.agent/`.
- **Dependency graph builder** — parses every source file with the Babel AST and produces two
  complementary maps: a *dependency map* (each file → the files it imports) and its exact inverse,
  a *dependent map* (each file → the files that import it).
- **Git-staging watcher (`watch`)** — observes `.git/index` and reports which files are staged for
  commit as they change, ready to hand off to analysis.
- **Tested and CI-backed** — a Vitest suite covering the parser, graph builder, and command logic,
  run on every push and pull request via GitHub Actions.

## How it works

### 1. The dependency graph

`buildDependencyGraph` walks the repository (skipping `node_modules`, `.git`, `dist`, and `.agent`)
and parses each source file with [`@babel/parser`](https://babeljs.io/docs/babel-parser). Using the
AST rather than text matching means it captures real module relationships across every form they
take:

- static `import` / `import x from "y"`
- re-exports (`export { x } from "y"`, `export * from "y"`)
- dynamic `import("y")`
- CommonJS `require("y")`

Each specifier is resolved to a repository-relative path. Resolution handles extensionless imports,
directory `index` files, configured `tsconfig` path aliases, and the Node.js/TypeScript convention
of importing a `.ts` file via its `.js` specifier. External packages (`react`, `node:fs`, …) are
intentionally excluded — the graph models *internal* structure only.

The result is written to two files keyed by repository-relative paths (forward slashes, for
portability):

```jsonc
// .agent/dependencyMap.json — each file → what it imports
{
  "src/index.ts": [
    "src/commands/init.ts",
    "src/commands/watch.ts",
    "src/utils/dependencyGraph.ts"
  ],
  "src/commands/watch.ts": ["src/commands/init.ts"]
}
```

```jsonc
// .agent/dependentMap.json — the exact inverse: each file → what imports it
{
  "src/commands/init.ts": [
    "src/index.ts",
    "src/commands/watch.ts"
  ]
}
```

The inverse map is what makes impact analysis cheap: given a staged file, its dependents are a
direct lookup rather than a full-graph traversal.

### 2. The staging watcher

When a file is staged, git rewrites `.git/index`. The `watch` command observes that file with
`fs.watch` for low-latency notifications and backs it with a 1000 ms `fs.watchFile` poll — git
replaces the index atomically, which can silently detach a lone `fs.watch` watcher, so the poll
guarantees coverage (and tolerates the index not existing yet in a brand-new repository). Events
from both sources are debounced through a single handler, which runs `git diff --cached --name-only`
to report exactly which files are staged.

### 3. The `.agent/` state directory

Veiny persists its runtime state inside the target repository under `.agent/` (git-ignored):

| File | Purpose |
| --- | --- |
| `repoInfo.json` | Resolved repository root |
| `configInfo.json` | Build-config snapshot captured at init |
| `userContext.md` | Optional developer-supplied project context |
| `dependencyMap.json` | Each file → the files it imports |
| `dependentMap.json` | Each file → the files that import it |

## Getting started

### Prerequisites

- Node.js 20 or newer
- A git repository to run against (Veiny operates on the repo it is launched in)

### Installation

```bash
git clone https://github.com/sunburnt716/veiny.git
cd veiny
npm install
```

### Usage

Veiny runs as an interactive shell:

```bash
npm start
```

```text
Welcome to Veiny — a codebase dependency analyzer

Type a command (start|watch|quit):
```

- **`start`** — initialize agent state and build the dependency graph. If a graph already exists,
  Veiny asks before reparsing and updating it.
- **`watch`** — begin watching the git index and report staged files as they change.
- **`quit`** — exit.

## Project structure

```text
src/
  index.ts                  # CLI entry point and command loop
  commands/
    init.ts                 # `start`: repo validation, config snapshot, agent state
    watch.ts                # `watch`: git-index watcher and staged-file detection
  utils/
    dependencyGraph.ts      # Babel-based dependency graph builder
  **/*.test.ts              # Vitest suites, colocated with their sources
.github/workflows/ci.yml    # Build + test on push and pull request
```

The project follows a few consistent conventions: TypeScript with ES modules, Node.js built-ins
plus Babel only, explicit error handling on every fallible operation, and a clear separation
between command orchestration and the logic it calls.

## Development

| Script | Description |
| --- | --- |
| `npm start` | Run the CLI via `tsx` |
| `npm run dev` | Run the CLI in watch mode |
| `npm run build` | Type-check and compile to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |

### Testing

Tests are written with [Vitest](https://vitest.dev) and live next to the code they cover. Suites
that touch the filesystem create real temporary directories (and real temporary git repositories)
rather than mocking I/O, and clean them up afterward, so they exercise the same code paths used in
production.

```bash
npm test
```

### Continuous integration

Every push and pull request to `main` runs the build and the full test suite on Node.js via
GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Roadmap

**Implemented**

- Interactive CLI shell (`start` / `watch` / `quit`)
- Repository validation, build-config snapshot, and `.agent/` state management
- Dependency graph builder with full import/export/dynamic/require coverage and alias resolution
- Git-index watcher with staged-file detection
- Vitest test suite and GitHub Actions CI

**Next**

- **Diff-analysis engine** — the immediate focus. Consume the staged-file list from `watch` and the
  dependency graph to surface the blast radius of a change (its dependents) and run heuristic checks
  before a commit lands.

**Planned**

- Pre-commit hook integration so analysis runs automatically on `git commit`
- User-configurable watch verbosity persisted in `.agent/`
- Expanded heuristics built on top of the dependent map

## Tech stack

- **Language:** TypeScript (ES modules)
- **Runtime:** Node.js
- **Parsing:** `@babel/parser` and `@babel/traverse`
- **Tooling:** `tsx` for execution, Vitest for testing, GitHub Actions for CI

## License

Released under the [MIT License](LICENSE).
