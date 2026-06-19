/*
 * report.ts
 * ---------
 * Presentation for an AnalysisResult, in two forms:
 *   - reportToTerminal: prints to the console for the interactive watch flow.
 *   - formatReportMarkdown: returns a markdown string (e.g. for a PR comment or a written report).
 *
 * Both group risks by severity in the order high → medium → low so the most important findings lead,
 * and both put the overall assessment LAST so it reads as a closing summary after the specifics.
 *
 * formatReportMarkdown is PURE: it returns a string and writes nothing to disk — disk I/O belongs to
 * the state layer, never here. reportToTerminal's only side effect is console output, which is its
 * sole reason to exist.
 *
 * Depends on: AnalysisResult, Risk, Severity (./provider.js). No network, no disk.
 */

import type { AnalysisResult, Risk, Severity } from "./provider.js";

// Fixed display order, highest-priority first. Centralized so both renderers stay consistent and a
// future severity level is added in exactly one place.
const SEVERITY_ORDER: readonly Severity[] = ["high", "medium", "low"];

// Human-facing section labels per severity, kept beside the order constant.
const SEVERITY_LABEL: Record<Severity, string> = {
  high: "HIGH",
  medium: "MEDIUM",
  low: "LOW",
};

/**
 * Returns the risks for a given severity, preserving their original order. Pure helper shared by
 * both renderers so grouping logic isn't duplicated.
 */
function risksOfSeverity(risks: Risk[], severity: Severity): Risk[] {
  return risks.filter((risk) => risk.severity === severity);
}

/**
 * Prints the analysis to the terminal: risks grouped high → medium → low, then the overall
 * assessment last. Plain console.log (no ANSI) keeps output readable in any terminal and in CI logs.
 * Side effect (printing) is this function's entire purpose.
 */
export function reportToTerminal(result: AnalysisResult): void {
  if (result.risks.length === 0) {
    console.log("No risks identified.");
  }

  for (const severity of SEVERITY_ORDER) {
    const group = risksOfSeverity(result.risks, severity);
    if (group.length === 0) {
      continue;
    }
    console.log(`\n${SEVERITY_LABEL[severity]} RISKS`);
    for (const risk of group) {
      console.log(`- ${risk.file}: ${risk.summary}`);
      console.log(`  ${risk.reasoning}`);
    }
  }

  // Overall assessment closes the report.
  console.log(`\nOverall assessment:\n${result.overallAssessment}`);
}

/**
 * Builds a markdown document for the analysis: a top heading, one section per non-empty severity
 * group (high → medium → low) listing file + summary + reasoning, and the overall assessment last.
 * Pure — returns the string; the caller decides what to do with it. Never writes to disk.
 */
export function formatReportMarkdown(result: AnalysisResult): string {
  const lines: string[] = ["# Veiny Risk Analysis", ""];

  if (result.risks.length === 0) {
    lines.push("_No risks identified._", "");
  }

  for (const severity of SEVERITY_ORDER) {
    const group = risksOfSeverity(result.risks, severity);
    if (group.length === 0) {
      continue;
    }
    lines.push(`## ${SEVERITY_LABEL[severity]} Risks`, "");
    for (const risk of group) {
      // Bold file + summary on one bullet, reasoning as an indented sub-line for scannability.
      lines.push(`- **${risk.file}** — ${risk.summary}`);
      lines.push(`  - ${risk.reasoning}`);
    }
    lines.push("");
  }

  lines.push("## Overall Assessment", "", result.overallAssessment, "");

  return lines.join("\n");
}
