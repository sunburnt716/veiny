/*
 * analyze.ts
 * ----------
 * The orchestrator that ties the LLM layer together into one call: build the prompt → send it →
 * parse the result. Intentionally thin — it contains no logic of its own, only sequencing. Each step
 * lives in its own focused module (prompt.ts, the adapter behind LLMProvider, parse.ts).
 *
 * Crucially, it takes `provider` as the LLMProvider INTERFACE, not a concrete adapter. That means:
 *  - production code passes the result of getProvider() (a real adapter that hits the network), and
 *  - tests pass a fake provider whose complete() returns a canned string — so the entire pipeline
 *    can be exercised end to end with zero API calls or keys.
 *
 * Depends on: AnalysisContext, AnalysisResult, LLMProvider (./provider.js),
 * buildAnalysisPrompt (./prompt.js), parseAnalysisResponse (./parse.js). No I/O of its own.
 */

import { parseAnalysisResponse } from "./parse.js";
import { buildAnalysisPrompt } from "./prompt.js";
import type {
  AnalysisContext,
  AnalysisResult,
  LLMProvider,
} from "./provider.js";

/**
 * Runs the full heuristic analysis: deterministic context → typed risk assessment.
 *
 * Errors from any stage (transport in provider.complete, malformed output in parseAnalysisResponse)
 * propagate to the caller unchanged — we never catch and swallow here, so the caller decides how to
 * surface a failure to the developer.
 */
export async function runHeuristicAnalysis(
  ctx: AnalysisContext,
  provider: LLMProvider,
): Promise<AnalysisResult> {
  const req = buildAnalysisPrompt(ctx);
  const raw = await provider.complete(req);
  return parseAnalysisResponse(raw);
}
