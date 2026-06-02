# Veiny

Veiny is a TypeScript CLI developer tool that parses a codebase into a dependency graph
and analyzes staged git diffs for heuristic issues before commits land. The name reflects
the core concept — tracing how changes flow through a codebase like veins.

## Architecture

- `src/index.ts` — entry point, reads process.argv and dispatches to commands
- `src/commands/` — one file per CLI command, thin orchestrators only, no business logic
- `src/core/` — all business logic (parser, graph, analyzer, differ)
- `src/git/` — git operations (repo validation, hook installation)
- `src/state/` — all reads and writes to the .agent/ directory
- `src/utils/` — shared helpers with no dependencies on the rest of the app

## The .agent/ Directory

Runtime state persisted inside the target repo. Contains:

- `repoInfo.json` — repo root path from validateGitRepo
- `configInfo.json` — build config snapshot from captureConfig
- `userContext.md` — developer-provided codebase context from promptForContext
- `dependencyGraph.json` — serialized dependency graph (not yet implemented)

## Current Functions

### src/git/repo.ts

- `validateGitRepo(): string`
  Runs `git rev-parse --show-toplevel` via child_process.execSync.
  Returns the absolute repo root path or exits with an error message.

### src/state/configSnapshot.ts

- `captureConfig(repoRoot: string): object`
  Reads nodeVersion, packageManager, tsconfig, pathAliases, and workspaces.
  Returns a structured object. Null for any field not found, never throws.

### src/state/agentState.ts

- `promptForContext(): Promise<string>`
  Uses Node readline to ask the developer for project context via y/n prompt.
  Returns their input as a string or empty string if they decline.
- `writeAgentState(repoRoot: string, config: object, context: string): void`
  Creates .agent/ directory and writes repoInfo.json, configInfo.json,
  and userContext.md. Skips userContext.md if context string is empty.

### src/commands/init.ts

- `runInit(): Promise<void>`
  Orchestrator only. Calls validateGitRepo → captureConfig → promptForContext
  → writeAgentState in sequence, threading return values between functions.

## Conventions

- TypeScript with ES modules (`"type": "module"` in package.json)
- No external libraries — Node.js built-ins only unless explicitly discussed
- All async operations use async/await, never raw Promise chains
- Explicit error handling on every operation that can fail
- One concern per file — each file has a single clearly defined responsibility
- Function names are verbs: `validateGitRepo`, `captureConfig`, `writeAgentState`
- Return data from functions, do not write files inside functions unless the
  function's sole responsibility is file I/O (like writeAgentState)
- Commands are thin orchestrators — all logic lives in core/, git/, or state/

## What Never to Do

- Never put business logic in command files
- Never read or write .agent/ files outside of src/state/
- Never install external libraries without flagging it first
- Never use `any` in TypeScript
- Never use CommonJS require() — ES modules only
- Never hardcode file paths — always derive them from repoRoot
- Never swallow errors silently — always log a descriptive message before exiting

## Current Focus

Implementing the init command sequence. Starting with validateGitRepo, then
captureConfig, then promptForContext, then writeAgentState, then runInit.
Implement one function at a time. Do not move to the next function until the
current one is complete and reviewed.
