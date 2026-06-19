/*
 * prompt.ts
 * ---------
 * Turns the deterministic facts Veiny already computed (the diff, the blast radius, the import
 * seams, the developer's project context) into the two halves of an LLM request: a `system` string
 * that fixes the model's job + output contract, and a `user` string that carries the actual case.
 *
 * Division of labor (important): Veiny computes the WHAT — what files changed, who imports them,
 * which symbols cross each seam — deterministically and without a model. The model is asked only for
 * JUDGMENT about risk. So this module never asks the model for facts; it hands them over and asks
 * for an assessment in a strict JSON schema.
 *
 * This file is PURE: no I/O, no network, no clock, no randomness. Same context in → same request
 * out. That makes buildAnalysisPrompt trivially testable and keeps prompt wording reviewable in one
 * place. formatDiffs is exported solely so tests can assert the diff-rendering/truncation behavior.
 *
 * Depends on: AnalysisContext, LLMRequest (./provider.js); FileDiff, BlastRadiusEntry, ImportEdge
 * (../core/types.js). No runtime dependencies on adapters or parse.
 */

import type { BlastRadiusEntry, FileDiff, ImportEdge } from "../core/types.js";
import type { AnalysisContext, LLMRequest } from "./provider.js";

// Per-file cap on how many diff lines we render into the prompt. Diffs can be enormous; a single
// generated/lockfile change could blow the token budget and bury the signal. We show the first
// MAX_DIFF_LINES combined add/delete lines per file and summarize the rest. 60 is a pragmatic
// balance: enough to convey intent, small enough that many files still fit in one request.
const MAX_DIFF_LINES = 60;

// Caps the model's response. The schema is small (a list of risks + one assessment), so 2048 tokens
// is generous headroom without inviting rambling.
const MAX_RESPONSE_TOKENS = 2048;

/**
 * Renders a list of FileDiffs into a compact, human-readable block for the prompt.
 *
 * We render from the structured `additions`/`deletions` arrays — NOT any raw unified-diff text —
 * because those arrays are already normalized (leading +/- stripped, hunk headers removed). We
 * re-add a `+`/`-` prefix purely for readability so the model can tell added from removed lines.
 *
 * Truncation guard: deletions then additions are concatenated; if the combined count exceeds
 * MAX_DIFF_LINES we show the first MAX_DIFF_LINES and append a `… +N more lines` note so the model
 * knows the view is partial rather than silently believing it saw the whole change.
 *
 * Exported for testing.
 */
export function formatDiffs(diffs: FileDiff[]): string {
  if (diffs.length === 0) {
    return "(no changed files)";
  }

  const blocks: string[] = [];

  for (const diff of diffs) {
    // Build the full prefixed line list (deletions first, then additions) so the truncation guard
    // operates on what the reader will actually see.
    const prefixedLines: string[] = [
      ...diff.deletions.map((line) => `-${line}`),
      ...diff.additions.map((line) => `+${line}`),
    ];

    const totalLines = prefixedLines.length;

    // Apply the per-file cap. slice() is safe past the end, and when total <= cap nothing is hidden.
    const shown = prefixedLines.slice(0, MAX_DIFF_LINES);
    const body = shown.length > 0 ? shown.join("\n") : "(no line content)";

    // Only emit the truncation note when we actually hid lines.
    const hidden = totalLines - shown.length;
    const note = hidden > 0 ? `\n… +${hidden} more lines` : "";

    blocks.push(`### ${diff.filePath}\n${body}${note}`);
  }

  // Blank line between files keeps the block scannable for both humans and the model.
  return blocks.join("\n\n");
}

/**
 * Renders blast-radius entries as `affectedFile ← changedFile` lines. The arrow points from the
 * file that will feel the change back to the file that changed, mirroring "who depends on what".
 */
function formatBlastRadius(entries: BlastRadiusEntry[]): string {
  if (entries.length === 0) {
    return "(no downstream files affected)";
  }
  return entries
    .map((entry) => `${entry.affectedFile} ← ${entry.changedFile}`)
    .join("\n");
}

/**
 * Renders import seams as `importer → imported : symbols`. These are the exact symbols crossing
 * each edge, which is the signal the model needs to reason about whether a changed export will
 * break a consumer.
 */
function formatImports(edges: ImportEdge[]): string {
  if (edges.length === 0) {
    return "(no import seams)";
  }
  return edges
    .map((edge) => `${edge.importer} → ${edge.imported} : ${edge.symbols.join(", ")}`)
    .join("\n");
}

/**
 * Assembles the full LLMRequest from an AnalysisContext.
 *
 * The `system` string pins three things: the model's role, the EXACT output JSON schema (kept in
 * sync by hand with AnalysisResult in provider.ts), and a hard instruction to return ONLY JSON.
 * parse.ts will still defensively strip fences, but stating the contract here reduces malformed
 * output in the first place.
 *
 * The `user` string lays out the case in four clearly labeled sections so the model can attribute
 * each fact to its source: PROJECT CONTEXT, CHANGED FILES, BLAST RADIUS, IMPORT SEAMS.
 *
 * Pure: depends only on `ctx`.
 */
export function buildAnalysisPrompt(ctx: AnalysisContext): LLMRequest {
  // NOTE: the schema below MUST stay structurally identical to AnalysisResult/Risk/Severity in
  // provider.ts. If those change, update this literal — parse.ts trusts the model to follow it.
  const system = [
    "You are a senior code reviewer assessing the RISK of a set of staged changes before they are committed.",
    "You are given deterministic facts (the diff, the downstream blast radius, and the import seams). Do NOT restate the facts — provide judgment about risk only.",
    "",
    "Return ONLY a single JSON object. No markdown, no code fences, no prose before or after. The object MUST match this schema exactly:",
    "{",
    '  "risks": [',
    "    {",
    '      "severity": "high" | "medium" | "low",',
    '      "file": string,        // repo-relative path the risk concerns',
    '      "summary": string,     // one short line',
    '      "reasoning": string    // why this is risky',
    "    }",
    "  ],",
    '  "overallAssessment": string',
    "}",
    "",
    'If you find no meaningful risks, return an empty "risks" array and explain why in "overallAssessment".',
  ].join("\n");

  const user = [
    "PROJECT CONTEXT",
    ctx.userContext.trim().length > 0 ? ctx.userContext : "(none provided)",
    "",
    "CHANGED FILES",
    formatDiffs(ctx.changedFiles),
    "",
    "BLAST RADIUS",
    formatBlastRadius(ctx.blastRadius),
    "",
    "IMPORT SEAMS",
    formatImports(ctx.imports),
  ].join("\n");

  return {
    system,
    user,
    maxTokens: MAX_RESPONSE_TOKENS,
  };
}
