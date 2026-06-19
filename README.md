# Veiny

![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Vitest-6E9F18?logo=vitest&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

A command-line developer tool that maps how a codebase fits together and analyzes staged changes
**before a commit lands** — not after CI fails. The name reflects the core idea: tracing how a change
flows through a project the way blood moves through veins.

> **Status:** v1 complete. Dependency graph, the deterministic analysis engine (type-check + blast
> radius), the interactive watcher with commit verification, and an optional provider-agnostic LLM
> risk report are all implemented and tested.

---

## Overview

Most pre-commit tooling treats a changeset as a flat list of files. That misses the question that
actually matters during review: *what else does this change affect?* A one-line edit to a widely
imported module is not the same risk as an edit to a leaf file, but a plain `git diff` presents them
identically.

Veiny builds a **dependency graph** of the project from its real import/export relationships, then
**watches the git index** so the moment files are staged it knows both *what* changed and *which
other files depend on it*. On each staged change it runs a **deterministic analysis** (a real
TypeScript type-check scoped to the change, plus the change's blast radius) and — if you opt in — asks
an **LLM for a human-readable risk report**. The LLM is scoped to *judgment only*: every fact it sees
is computed by Veiny and fed into the prompt; it is never asked to invent them.

## Features

- **Global `veiny` command** that runs against whatever git repository it's launched in.
- **Project initialization (`start`)** — validates the git repo, captures a build-config snapshot
  (package manager, TypeScript config, path aliases, workspaces), optionally records developer
  context, builds the dependency graph, then flows straight into watch mode.
- **Dependency graph + import seams** — Babel-AST parsing produces a *dependency map* (file → what it
  imports), its exact inverse *dependent map* (file → what imports it), and an *import-seam map*
  (which symbols cross each edge).
- **Deterministic analysis engine** — on each staged change, runs the TypeScript compiler and reports
  diagnostics scoped to the changed files (flagging which sit inside the edited lines), and computes
  the change's **blast radius** (the files that import what you touched).
- **Interactive watch** — surfaces metrics on every catch, verifies after each commit whether the
  files it flagged were the ones committed (recording your y/n as accuracy feedback), and stops on
  `quit` or Ctrl+C.
- **Optional, provider-agnostic LLM risk report** — opt-in; works with Anthropic and any
  OpenAI-compatible endpoint (OpenAI, xAI/Grok, Groq, Together, OpenRouter, Ollama, …) via native
  `fetch` and no SDKs. Saved reports are human artifacts, never fed back into future prompts.
- **Tested and CI-backed** — a Vitest suite (95 tests) run on every push and pull request.

## How it works

### 1. The dependency graph and import seams

`buildDependencyGraph` walks the repository (skipping `node_modules`, `.git`, `dist`, `.agent`) and
parses each source file with [`@babel/parser`](https://babeljs.io/docs/babel-parser). Using the AST
rather than text matching captures real module relationships across every form they take — static
`import`, re-exports (`export … from`), dynamic `import()`, and CommonJS `require()`.

Each specifier is resolved to a repository-relative path, handling extensionless imports, directory
`index` files, `tsconfig` path aliases, and the nodenext convention of importing a `.ts` file via its
`.js` specifier. External packages (`react`, `node:fs`, …) are excluded — the graph models *internal*
structure only.

Three files are written (keyed by repo-relative paths, forward slashes):

```jsonc
// .agent/dependencyMap.json — each file → what it imports
{ "src/index.ts": ["src/commands/init.ts", "src/commands/watch.ts"] }

// .agent/dependentMap.json — the exact inverse: each file → what imports it
{ "src/commands/init.ts": ["src/index.ts", "src/commands/watch.ts"] }

// .agent/imports.json — the seams: which symbols cross each edge
[ { "importer": "src/index.ts", "imported": "src/commands/init.ts",
    "symbols": ["runInit", "captureConfig", "validateGitRepo"] } ]
```

The inverse map makes impact analysis cheap: a staged file's dependents are a direct lookup, not a
full-graph traversal.

### 2. The deterministic analysis engine

When a change is staged, [`core/analysis.ts`](src/core/analysis.ts) runs two checks and writes
`.agent/report.json`:

- **Type-check** — builds a TypeScript program from the repo's `tsconfig.json`, collects syntactic +
  semantic diagnostics, and keeps only those in the changed files. Each diagnostic is flagged with
  `inChangedHunk` — whether it sits on a line you actually edited — without filtering the rest out (an
  edit on line 10 can surface an error at a call site on line 80).
- **Blast radius** — for each changed file, the files that import it (depth-1, file-level). This is
  the "what else does this affect?" signal, computed from the dependent map.

"Deterministic" is the contract: same diff + same repo state → same report. No network, no model.

### 3. The interactive watch

`watch` observes two files inside `.git`, each with a low-latency `fs.watch` plus a 1000 ms
`fs.watchFile` poll as a safety net (git rewrites these atomically, which can detach a lone watcher):

- **`.git/index`** — rewritten on `git add`. On change, Veiny runs the analysis above and prints a
  metrics line (files caught, errors, warnings, affected files), then prompts you to keep watching or
  quit. With the LLM enabled, it also renders the risk report and offers to save it.
- **`.git/logs/HEAD`** — appended to on commit. Veiny compares the files it caught against the files
  in the commit and asks *"was that accurate? (y/n)"*, recording your answer to
  `.agent/verifications.json` as an accuracy-feedback log.

Events from both sources are debounced and serialized so prompts never overlap. `quit` at any prompt
or Ctrl+C tears everything down cleanly.

### 4. The optional LLM risk report

If you opt in at init and a key is available, each staged-change analysis is followed by an LLM pass
([`src/llm/`](src/llm/)). Veiny assembles one prompt from data it already computed — the parsed diff,
the blast radius, the import seams, and your project context — and asks the model for a structured
risk report (per-file severity, summary, reasoning, and an overall assessment). It then prints the
report and offers to save it under `.agent/reports/`.

The layer is provider-agnostic by design: one `LLMProvider` interface with one adapter per provider
(`AnthropicAdapter`, and a single `OpenAIAdapter` whose configurable base URL serves every
OpenAI-compatible endpoint). It uses the native global `fetch` — no SDKs, no extra dependencies. If
the LLM is disabled or no key is found, this step is skipped silently and watch behaves exactly as
before. A failed LLM call logs and is shrugged off; it never aborts the watch loop.

### The `.agent/` state directory

Veiny persists its runtime state inside the target repository under `.agent/`, which it adds to your
`.gitignore` automatically:

| File | Purpose |
| --- | --- |
| `repoInfo.json` | Resolved repository root |
| `configInfo.json` | Build-config snapshot captured at init |
| `userContext.md` | Optional developer-supplied project context |
| `dependencyMap.json` | Each file → the files it imports |
| `dependentMap.json` | Each file → the files that import it |
| `imports.json` | Per-edge import seams (symbols crossing each edge) |
| `report.json` | Latest deterministic analysis result |
| `verifications.json` | Commit-accuracy feedback log |
| `llmConfig.json` | LLM preferences (`enabled`, `provider`, `model`, `baseURL`) |
| `credentials.json` | API key — **secret**, written with mode `0600`, may be absent |
| `reports/` | Saved human-readable LLM reports (`report-<timestamp>.md`) |

---

## Getting started

### Prerequisites

- **Node.js 20 or newer** and **git**.
- A git repository to run Veiny against (it analyzes the repo it's launched in).
- *(Optional)* an LLM API key, only if you want the AI risk report. Everything else works without one.
- The type-check step expects a `tsconfig.json` at the repo root. Non-TypeScript projects still get
  the dependency graph and blast radius; the type-check is simply reported as skipped.

### 1. Install Veiny

```bash
git clone https://github.com/sunburnt716/veiny.git
cd veiny
npm install
npm run build      # compiles to dist/
npm link           # installs a global `veiny` command pointing at dist/
```

> `npm link` requires `dist/` to exist, so always `npm run build` first. After pulling new changes,
> re-run `npm run build` to refresh the linked command. (To remove it later: `npm unlink -g veiny`.)

### 2. Run it on your codebase

```bash
cd /path/to/your/project
veiny
```

```text
Welcome to Veiny — a codebase dependency analyzer

Would you like a quick walkthrough of Veiny? (y/n) n
Type a command (start|watch|quit): start
```

### 3. First run (`start`)

`start` walks you through setup, then enters watch mode automatically:

1. **Project context** *(optional)* — free-text notes about the codebase, saved to `userContext.md`
   and included in LLM prompts.
2. **LLM analysis** *(optional)* — choose to enable it, pick a provider and model (and base URL for
   OpenAI-compatible providers), and enter your API key (hidden input; stored at `0600`). See
   [LLM configuration](#llm-configuration).
3. **Dependency graph** — built (or, if one exists, Veiny asks before reparsing).
4. **Watch mode** — `start` flows straight into watching; no second command needed.

### 4. Day-to-day use

- **Stage changes** (`git add …`) → Veiny prints the metrics line for the change; with the LLM on, it
  also prints the risk report and asks whether to save it to `.agent/reports/`.
- **Commit** (`git commit …`) → Veiny asks whether the files it flagged were accurate (y/n) and logs
  your answer.
- **Stop** → type `quit` at a prompt, or press Ctrl+C.

> Run your own `git` commands in a separate terminal — Veiny holds the one it's running in.

---

## LLM configuration

The LLM layer is **off by default**. When enabled, configuration lives in `.agent/llmConfig.json`
and the key is resolved (without prompting, at watch time) in this order:

1. `VEINY_LLM_API_KEY` environment variable
2. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` environment variables
3. `.agent/credentials.json`

Pick the provider, model, and base URL that match your key. The `openai` provider speaks the
OpenAI-compatible format, which most hosts implement — the **base URL** is what points it at each one:

| Service | Provider | Base URL | Example model | Key prefix |
| --- | --- | --- | --- | --- |
| Anthropic | `anthropic` | *(built in)* | `claude-opus-4-8` | `sk-ant-…` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `gpt-4o` | `sk-…` |
| xAI (Grok) | `openai` | `https://api.x.ai/v1` | `grok-3` | `xai-…` |
| Groq | `openai` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | `gsk_…` |
| Ollama (local) | `openai` | `http://localhost:11434/v1` | `llama3.1` | *(any)* |

> **Grok ≠ Groq.** They're different companies: **Grok** is xAI's model (keys `xai-…`, base URL
> `api.x.ai`); **Groq** is a separate inference host (keys `gsk_…`, base URL `api.groq.com`). Using
> one's key against the other's URL returns `401 Invalid API Key`.

**Security:** your key is written to `.agent/credentials.json` with mode `0600`, and Veiny adds
`.agent/` to your repo's `.gitignore` *before* writing it, so the key can't be committed.

## Commands

Inside the `veiny` shell:

| Command | What it does |
| --- | --- |
| `start` | Initialize agent state, build the dependency graph, and enter watch mode |
| `watch` | Enter watch mode directly (prompts to build the graph if it's missing) |
| `quit` | Exit |

## Project structure

```text
src/
  index.ts                  # CLI entry point and command loop
  commands/
    init.ts                 # `start`: repo validation, config snapshot, LLM/init prompts
    watch.ts                # `watch`: dual git watchers, staged-diff parsing, orchestration
  core/
    analysis.ts             # deterministic engine: type-check + blast radius
    watchSession.ts         # pure helpers: report summary, caught-vs-committed comparison
    types.ts                # shared type definitions (single source of truth)
  llm/
    provider.ts             # LLMProvider interface + analysis types
    anthropicAdapter.ts     # Anthropic Messages API adapter (fetch)
    openaiAdapter.ts        # OpenAI-compatible adapter (configurable baseURL)
    client.ts               # getProvider() factory
    prompt.ts  parse.ts     # prompt assembly / response parsing (pure)
    analyze.ts  report.ts   # orchestrator / terminal + markdown formatters
  state/
    agentState.ts           # the .agent/ I/O boundary
    credentials.ts          # API-key load/save + .gitignore guard
    llmConfig.ts            # LLM preferences + the init prompt
  utils/
    dependencyGraph.ts      # Babel-based graph + import-seam builder
  **/*.test.ts              # Vitest suites, colocated with their sources
.github/workflows/ci.yml    # Build + test on push and pull request
```

## Development

| Script | Description |
| --- | --- |
| `npm run start` | Run the CLI from source via `tsx` (dev entry point) |
| `npm run dev` | Run the CLI in `tsx` watch mode |
| `npm run build` | Type-check and compile to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |

Conventions: TypeScript with ES modules; Node built-ins plus Babel and the TypeScript compiler only
(no other runtime libraries — the LLM layer uses native `fetch`); explicit error handling on every
fallible operation; `.agent/` I/O confined to the state layer.

### Testing & CI

Tests use [Vitest](https://vitest.dev) and live next to the code they cover. Filesystem-touching
suites create real temporary directories and git repositories (cleaned up afterward) rather than
mocking I/O. Every push and pull request to `main` runs the build and full suite via GitHub Actions
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Troubleshooting

- **`OpenAI request failed (401): Invalid API Key`** — the provider, base URL, and key must match
  (see the [Grok ≠ Groq](#llm-configuration) note), and make sure you entered a *model id* in the
  Model field, not your key.
- **Re-running `start` doesn't ask for a new key** — a saved key is reused. Delete
  `.agent/credentials.json` (and `.agent/llmConfig.json` to reset preferences), then run `start`.
- **"analysis failed" on a non-TypeScript repo** — the type-check needs a `tsconfig.json` at the repo
  root; without one it's reported as failed, but the dependency graph and blast radius still work.
- **`LF will be replaced by CRLF` warnings on Windows** — harmless git line-ending notices.

## Roadmap

**Implemented (v1)**

- Global `veiny` command; interactive shell (`start` / `watch` / `quit`)
- Repo validation, build-config snapshot, and `.agent/` state management
- Dependency graph + import-seam capture (full import/export/dynamic/require coverage, alias resolution)
- Deterministic analysis engine: TypeScript type-check scoped to changed files + depth-1 blast radius
- Interactive watch: per-catch metrics, commit verification with accuracy feedback, clean quit/SIGINT
- Optional provider-agnostic LLM risk report (Anthropic + any OpenAI-compatible endpoint)
- Vitest suite (95 tests) and GitHub Actions CI

**Next**

- Pre-commit hook integration so analysis runs automatically on `git commit`
- Symbol-precise (v2) blast radius using the import seams already captured in `imports.json`
- User-configurable watch verbosity persisted in `.agent/`

## Tech stack

- **Language:** TypeScript (ES modules)
- **Runtime:** Node.js
- **Parsing & analysis:** `@babel/parser` / `@babel/traverse` (graph), the TypeScript compiler API (type-check)
- **LLM transport:** native `fetch` (no SDKs)
- **Tooling:** `tsx` for execution, Vitest for testing, GitHub Actions for CI

## License

Released under the [MIT License](LICENSE).
