/*
 * parse.ts
 * --------
 * The boundary between "raw model text" and "typed Veiny data". Models are unreliable narrators:
 * even when told to return ONLY JSON, they wrap it in ```json fences, add a stray sentence, or
 * emit malformed JSON. This module is the single choke point that turns that untrusted string into
 * an AnalysisResult — or fails loudly with enough context to debug WHY the model misbehaved.
 *
 * Why this lives alone (not inside the adapters): the adapters only know transport. They return
 * whatever text the model produced and never inspect it. Parsing/validation is a separate concern
 * so a future provider needs zero parsing code, and so tests can exercise parsing on canned strings
 * without any network.
 *
 * Depends on: AnalysisResult (../provider.js). No I/O, no network.
 */

import type { AnalysisResult } from "./provider.js";

/**
 * Turns a model's raw text response into a typed AnalysisResult.
 *
 * Contract:
 *  - Strips markdown code fences (```json … ```), which models add despite instructions.
 *  - Parses the remainder as JSON inside a try/catch.
 *  - On success, returns it typed as AnalysisResult. This is a deliberate single boundary cast:
 *    the data crossed a trust boundary as `unknown`; we assert the shape the prompt demanded here
 *    rather than re-deriving validators that would duplicate the schema in the prompt. (If we ever
 *    want runtime field validation, this is the one place to add it.)
 *  - On failure, THROWS with the FULL raw output embedded so a human/agent can read exactly what
 *    the model said. We never return a partial or guessed result, and we never swallow the error —
 *    a silent wrong answer is worse than a loud failure for a pre-commit risk tool.
 */
export function parseAnalysisResponse(raw: string): AnalysisResult {
  // Models frequently wrap JSON in fenced code blocks. Remove every fence marker (opening
  // ```json / ``` and any bare ```), then trim surrounding whitespace/newlines. We strip ALL
  // occurrences rather than just the first/last so multi-fence or stray-fence output still cleans
  // up. The replace is global and case-insensitive on the language tag.
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    // JSON.parse returns `any`; immediately pin it to `unknown` so the `any` cannot leak into the
    // rest of the module. We then assert the AnalysisResult shape exactly once, at this boundary.
    const parsed: unknown = JSON.parse(cleaned);
    return parsed as AnalysisResult;
  } catch (err) {
    // Normalize the thrown value (catch is `unknown`) into a readable message without assuming it
    // is an Error instance.
    const message = err instanceof Error ? err.message : String(err);

    // Embed the FULL original raw output (not the cleaned form) plus the parse error. This is the
    // single most useful artifact when a model regresses, so we never truncate it here.
    throw new Error(
      `LLM returned unparseable output.\nRaw response:\n${raw}\n\nParse error: ${message}`,
    );
  }
}
