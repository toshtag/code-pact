// Explain machinery. `renderSections` returns the structured
// intermediate form of the rendered pack; `computeExplainSections` annotates
// each section with a reason code derived from the task readiness flags,
// attaches a `Buffer.byteLength(..., "utf8")` byte count, and appends a
// synthetic `format_overhead` section capturing the inter-section newlines so
// the acceptance invariant `sum(sections[].bytes) === totalBytes` holds.
// `computeExplainExcluded` lists the sections policy left out and why.

import { type RenderedSection } from "./formatters/markdown.ts";

/**
 * Closed enum of reason codes attached to included sections in the
 * explain output. New variants require an RFC.
 *
 * `budget_reserved_for_later` is intentionally absent here — it lives
 * in {@link ContextExcludedReasonCode} and is reserved for budget enforcement.
 */
export type ContextSectionReasonCode =
  | "always_included"
  | "declared_by_task"
  | "referenced_decision"
  | "glob_match"
  | "write_surface_high"
  | "context_size_large"
  | "ambiguity_high"
  | "format_overhead";

/**
 * Closed enum of reason codes attached to excluded sections in the
 * explain output. New variants require an RFC.
 *
 * `budget_reserved_for_later` is reserved for budget enforcement;
 * a non-budget explain pass MUST NOT emit it. A unit test asserts the
 * absence in every no-budget output.
 */
export type ContextExcludedReasonCode =
  | "context_size_small_and_ambiguity_low"
  | "not_declared_by_task"
  | "glob_no_match"
  | "budget_reserved_for_later";

export type ContextExplainSection = {
  name: string;
  bytes: number;
  reason_code: ContextSectionReasonCode;
  details?: Record<string, unknown>;
};

export type ContextExplainExcluded = {
  name: string;
  reason_code: ContextExcludedReasonCode;
  details?: Record<string, unknown>;
};

/**
 * Additive, byte-based explain metrics surfaced
 * on `task context --explain --json`. Every value is a UTF-8 byte count
 * computed with `Buffer.byteLength(..., "utf8")` (never tokens), derived
 * locally and deterministically: no tokenizer, summarization, model call, or
 * network access is involved.
 *
 * These are an OBSERVABILITY layer over the budget path; they
 * never change the rendered `content`. The no-flag pack stays byte-identical,
 * and only an explicit `--budget-bytes` / `--context-budget` invocation elides
 * sections.
 */
export type ContextExplainMetrics = {
  /** Pre-elision pack size: the bytes the no-budget builder renders for this task. */
  naturalBytes: number;
  /** Post-budget pack size. Equals the result's `totalBytes` (== context_pack_bytes). */
  finalBytes: number;
  /** Present only when a budget was applied (via --budget-bytes / --context-budget). */
  budgetBytes?: number;
  /** `naturalBytes - finalBytes`; 0 when no section was elided. */
  savedBytes: number;
  /** `savedBytes / naturalBytes`; 0 when `naturalBytes === 0`. */
  savedRatio: number;
  /**
   * The floor after all budget-ELIGIBLE elisions for this task — the SAME
   * value `CONTEXT_OVER_BUDGET` reports, computed by the same shared helper
   * (honoring the conditional eligibility).
   */
  minimumAchievableBytes: number;
  /** Budget-elided sections only, in actual elision order. */
  elidedSections: Array<{ name: string; bytes: number }>;
};

export type ExplainFlags = {
  isSmall: boolean;
  isLarge: boolean;
  isHighAmbiguity: boolean;
  isLargeWriteSurface: boolean;
};

export type ExplainDeclared = {
  dependsOn: boolean;
  reads: boolean;
  writes: boolean;
  declaredDecisions: boolean;
  acceptanceRefs: boolean;
};

function reasonForSection(
  name: string,
  flags: ExplainFlags,
): ContextSectionReasonCode {
  switch (name) {
    case "header":
    case "phase_contract":
    case "task_definition":
    case "verification_commands":
    case "progress_event_schema":
      return "always_included";
    case "constitution":
      // includeConstitution = isLarge || isHighAmbiguity. When both
      // are true, attribute to the more specific signal (isLarge),
      // matching the precedence the renderer uses implicitly.
      return flags.isLarge ? "context_size_large" : "ambiguity_high";
    case "rules":
      return flags.isLargeWriteSurface ? "write_surface_high" : "always_included";
    case "depends_on":
    case "writes":
    case "acceptance_refs":
      return "declared_by_task";
    case "reads":
      return "glob_match";
    case "declared_decisions":
      return "referenced_decision";
    case "related_decisions":
      return flags.isLarge ? "context_size_large" : "always_included";
    case "completed_tasks":
      return "ambiguity_high";
    default:
      return "always_included";
  }
}

export function computeExplainSections(
  rendered: RenderedSection[],
  flags: ExplainFlags,
  totalBytes: number,
): ContextExplainSection[] {
  const result: ContextExplainSection[] = [];
  let attributed = 0;
  for (const s of rendered) {
    const sectionContent = s.lines.join("\n");
    const bytes = Buffer.byteLength(sectionContent, "utf8");
    attributed += bytes;
    result.push({
      name: s.name,
      bytes,
      reason_code: reasonForSection(s.name, flags),
      ...(s.details ? { details: s.details } : {}),
    });
  }
  const overhead = totalBytes - attributed;
  // Synthetic format_overhead section captures the `(n-1)` inter-
  // section newlines introduced by the final `flatMap.join("\n")`.
  // For multi-byte UTF-8 content the value is still correct because
  // both totalBytes and the per-section bytes use Buffer.byteLength.
  if (overhead > 0) {
    result.push({
      name: "format_overhead",
      bytes: overhead,
      reason_code: "format_overhead",
      details: { kind: "inter_section_newlines" },
    });
  }
  return result;
}

export function computeExplainExcluded(
  flags: ExplainFlags,
  declared: ExplainDeclared,
): ContextExplainExcluded[] {
  const excluded: ContextExplainExcluded[] = [];

  // Constitution is excluded when neither isLarge nor isHighAmbiguity.
  if (!flags.isLarge && !flags.isHighAmbiguity) {
    excluded.push({
      name: "constitution",
      reason_code: "context_size_small_and_ambiguity_low",
    });
  }

  // Rules are excluded when context_size is small (no rules loaded).
  if (flags.isSmall) {
    excluded.push({
      name: "rules",
      reason_code: "context_size_small_and_ambiguity_low",
    });
  }

  // Declared-section excluded entries — only emit when the task
  // did not declare the corresponding field.
  if (!declared.dependsOn) {
    excluded.push({ name: "depends_on", reason_code: "not_declared_by_task" });
  }
  if (!declared.reads) {
    excluded.push({ name: "reads", reason_code: "not_declared_by_task" });
  }
  if (!declared.writes) {
    excluded.push({ name: "writes", reason_code: "not_declared_by_task" });
  }
  if (!declared.declaredDecisions) {
    excluded.push({
      name: "declared_decisions",
      reason_code: "not_declared_by_task",
    });
  }
  if (!declared.acceptanceRefs) {
    excluded.push({
      name: "acceptance_refs",
      reason_code: "not_declared_by_task",
    });
  }

  // Completed-task histogram is excluded when ambiguity is not high.
  if (!flags.isHighAmbiguity) {
    excluded.push({
      name: "completed_tasks",
      reason_code: "context_size_small_and_ambiguity_low",
    });
  }

  return excluded;
}
