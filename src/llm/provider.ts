/*
 * provider.ts
 * -----------
 * The provider-agnostic contract for Veiny's optional LLM layer, plus the data types that flow
 * through it. No runtime logic lives here — this is the single place prompt.ts, parse.ts, the
 * adapters, and the analyze orchestrator all import from, so every piece agrees on the same shapes.
 *
 * Design rule: ONE interface (`LLMProvider`), many implementations (one class per provider). The
 * caller depends on the interface and stays provider-blind; the factory in client.ts picks the
 * concrete adapter.
 */

import type { BlastRadiusEntry, FileDiff, ImportEdge } from "../core/types.js";

// What an adapter sends to a model. `system` and `user` are the two prompt halves; `maxTokens`
// caps the response.
interface LLMRequest {
  system: string;
  user: string;
  maxTokens: number;
}

// The one interface every provider implements.
interface LLMProvider {
  /**
   * Sends a prompt and returns the model's raw text response. Throws only on transport/auth
   * failure — never on a well-formed but unhelpful response (parsing/validation is parse.ts's job).
   */
  complete(req: LLMRequest): Promise<string>;
}

// --- Analysis result shape (what the model is asked to return, and what parse.ts produces) ---

type Severity = "high" | "medium" | "low";

interface Risk {
  severity: Severity;
  file: string; // relative to repoRoot
  summary: string; // one line
  reasoning: string; // why this is risky
}

interface AnalysisResult {
  risks: Risk[];
  overallAssessment: string;
}

// --- Prompt input: everything Veiny computed deterministically, fed INTO the model ---
// The model is asked for judgment only; these facts are never asked of it.
interface AnalysisContext {
  userContext: string; // contents of userContext.md (developer-written project context)
  changedFiles: FileDiff[]; // the WHAT-changed (parsed staged diff)
  blastRadius: BlastRadiusEntry[]; // the WHAT's-affected (who imports the changed files)
  imports: ImportEdge[]; // the seam — symbols crossing each affected edge
}

export type {
  AnalysisContext,
  AnalysisResult,
  LLMProvider,
  LLMRequest,
  Risk,
  Severity,
};
