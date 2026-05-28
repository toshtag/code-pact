import {
  detectDuplicatePhaseIds,
  detectDuplicateTaskIds,
  detectMissingPhaseFiles,
  detectOrphanPhaseFiles,
  detectPhaseIdMismatches,
  detectPhaseIdNaming,
  detectTaskIdPhasePrefix,
  detectTaskDependsOnUnresolved,
  detectTaskDependsOnSelfReference,
  detectTaskDependsOnCycle,
  detectTaskDecisionRefUnsafePath,
  detectTaskDecisionRefNotFound,
  detectTaskReadsUnsafePath,
  detectTaskReadsGlobInvalid,
  detectTaskReadsNoMatch,
  detectTaskWritesUnsafePath,
  detectTaskWritesGlobInvalid,
  detectTaskWritesOverBroad,
  detectTaskWritesProtectedPath,
  detectTaskAcceptanceRefUnsafePath,
  detectTaskAcceptanceRefNotFound,
} from "./checks.ts";
import { loadProtectedPaths } from "../rules/protected-paths.ts";
import { makeDecisionResolver, classifyDecisionAdrs } from "../decisions/adr.ts";
import type { PhaseEntry, PlanState } from "./state.ts";
import { collectPlanArtifacts } from "./state.ts";
import type { PlanIssue } from "./shared.ts";

const WEAK_DOD_PATTERN = /\b(TODO|FIXME|tbd)\b/i;
const WEAK_DOD_MIN_CHARS = 10;
const PLACEHOLDER_VERIFICATION_PATTERN = /^\s*(echo|true|noop)\b/i;

export type LintOptions = {
  cwd: string;
  /**
   * When true, runs opt-in quality/readiness advisories (WEAK_DOD,
   * PLACEHOLDER_VERIFICATION, TASK_DECISION_UNRESOLVED, PHASE_CONFIDENCE_LOW,
   * TASK_DESCRIPTION_MISSING). Off by default so the base lint stays lean;
   * the P31 advisories are also `affects_exit: false`, so they never fail
   * `--strict` even when this is on.
   */
  includeQuality?: boolean;
};

export type LintResult = {
  issues: PlanIssue[];
  skippedChecks: string[];
  includeQuality: boolean;
};

/**
 * plan lint orchestrator. Collects parse/schema issues via the lenient
 * loader, then runs structural detectors over whatever phases were
 * parseable. When the roadmap itself was unparseable the loader hands
 * back a best-effort scan of design/phases/ plus the list of
 * roadmap-dependent checks that had to be skipped — those are returned
 * verbatim so the CLI surface can advertise them in `--json`.
 *
 * `ORPHAN_PROGRESS_EVENT` is intentionally NOT reported here. That
 * cross-artifact comparison belongs to `plan analyze` (T4). Reporting
 * it from both commands would produce duplicate output for the same
 * underlying issue.
 */
export async function runLint(opts: LintOptions): Promise<LintResult> {
  const includeQuality = opts.includeQuality === true;
  const { state, fallbackPhases, fileIssues, skippedChecks } =
    await collectPlanArtifacts(opts.cwd);

  const issues: PlanIssue[] = [...fileIssues];
  const phases: PhaseEntry[] = state?.phases ?? fallbackPhases;

  // Structural integrity that works on whatever phases parsed cleanly.
  issues.push(...detectDuplicateTaskIds(phases));
  issues.push(...detectDuplicatePhaseIds(phases));
  issues.push(...detectPhaseIdNaming(phases));
  issues.push(...detectTaskIdPhasePrefix(phases));

  // P10 — Task Readiness Schema. All twelve detectors are no-ops for
  // tasks that declare none of the optional fields. Sync detectors run
  // first; async detectors that touch the filesystem run after so a
  // configuration error in the sync set is visible quickly.
  issues.push(...detectTaskDependsOnUnresolved(phases));
  issues.push(...detectTaskDependsOnSelfReference(phases));
  issues.push(...detectTaskDependsOnCycle(phases));
  issues.push(...detectTaskDecisionRefUnsafePath(phases));
  issues.push(...detectTaskReadsUnsafePath(phases));
  issues.push(...detectTaskReadsGlobInvalid(phases));
  issues.push(...detectTaskWritesUnsafePath(phases));
  issues.push(...detectTaskWritesGlobInvalid(phases));
  issues.push(...detectTaskWritesOverBroad(phases));
  // v1.6 P15-T3: protected-paths list is configurable. Load once per
  // lint run, then inject into the detector. Falls back to the
  // hardcoded constant when `design/rules/protected-paths.md` is
  // absent — v1.5 behaviour is preserved by default.
  const { paths: protectedPaths } = await loadProtectedPaths(opts.cwd);
  issues.push(...detectTaskWritesProtectedPath(phases, protectedPaths));
  issues.push(...detectTaskAcceptanceRefUnsafePath(phases));
  issues.push(...(await detectTaskDecisionRefNotFound(opts.cwd, phases)));
  issues.push(...(await detectTaskReadsNoMatch(opts.cwd, phases)));
  issues.push(...(await detectTaskAcceptanceRefNotFound(opts.cwd, phases)));

  // Roadmap-dependent checks. Only run when we have a roadmap; the
  // lenient loader has already recorded the skipped check names when
  // it does not.
  if (state) {
    issues.push(...detectPhaseIdMismatches(state.phases));
    issues.push(...(await detectMissingPhaseFiles(opts.cwd, state.roadmap)));
    issues.push(...(await detectOrphanPhaseFiles(opts.cwd, state.roadmap)));
  }

  if (includeQuality) {
    issues.push(...detectWeakDoD(phases));
    issues.push(...detectPlaceholderVerification(phases));
    // P31 clarify advisories. All `affects_exit: false` — they surface
    // uncertainty for human review and never fail `--strict`.
    issues.push(...(await detectUnresolvedDecision(opts.cwd, phases)));
    issues.push(...(await detectAdrStatusUnrecognized(opts.cwd)));
    issues.push(...detectLowConfidencePhase(phases));
    issues.push(...detectMissingTaskDescription(phases));
  }

  return { issues, skippedChecks, includeQuality };
}

/** Quality heuristic: DoD bullets that look unfinished. */
function detectWeakDoD(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    phase.definition_of_done.forEach((bullet, index) => {
      const trimmed = bullet.trim();
      if (trimmed.length < WEAK_DOD_MIN_CHARS || WEAK_DOD_PATTERN.test(trimmed)) {
        issues.push({
          code: "WEAK_DOD",
          severity: "warning",
          message: `Phase "${phase.id}" DoD item #${index + 1} looks unfinished: "${trimmed}"`,
          file: ref.path,
          phase_id: phase.id,
          path: `definition_of_done[${index}]`,
        });
      }
    });
  }
  return issues;
}

/**
 * Quality heuristic: verification commands that obviously do not
 * verify anything (echo / true / noop).
 */
function detectPlaceholderVerification(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    phase.verification.commands.forEach((cmd, index) => {
      if (PLACEHOLDER_VERIFICATION_PATTERN.test(cmd)) {
        issues.push({
          code: "PLACEHOLDER_VERIFICATION",
          severity: "warning",
          message: `Phase "${phase.id}" verification command #${index + 1} is a placeholder: "${cmd}"`,
          file: ref.path,
          phase_id: phase.id,
          path: `verification.commands[${index}]`,
        });
      }
    });
  }
  return issues;
}

/**
 * Clarify advisory: a task (or its phase) is marked `requires_decision`
 * but no ADR resolves it yet. Shares `verify`'s resolution predicate via
 * the `design/decisions/` helper, so what counts as "resolved" cannot
 * diverge between lint and verify. Advisory (`affects_exit: false`): it
 * surfaces the decision early (verify blocks completion later) without
 * failing CI on a deliberately-unresolved design point.
 */
async function detectUnresolvedDecision(
  cwd: string,
  phases: PhaseEntry[],
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  // Read design/decisions/ once and memoize file reads across the N
  // requires_decision tasks. The resolver is shared with verify/record-done
  // (same parseAdrStatus + classifyAdr + matchesTaskId), so what counts as
  // "resolved" cannot diverge.
  const resolver = await makeDecisionResolver(cwd);
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      const requiresDecision =
        task.requires_decision === true || phase.requires_decision === true;
      if (!requiresDecision) continue;
      const res = await resolver.resolve(task.id, task.decision_refs);
      if (res.resolved) continue;
      issues.push({
        code: "TASK_DECISION_UNRESOLVED",
        severity: "warning",
        affects_exit: false,
        message: `Task "${task.id}" requires a decision that is not resolved: ${res.reason}. Add or accept an ADR (verify will block completion until it resolves).`,
        file: ref.path,
        phase_id: phase.id,
        task_id: task.id,
        path: "requires_decision",
        details: {
          source: task.requires_decision === true ? "task" : "phase",
          via: res.via,
          reason: res.reason,
          considered: res.considered,
        },
      });
    }
  }
  return issues;
}

/**
 * Clarify advisory: an ADR in `design/decisions/` declares an explicit status
 * word that is not recognized (e.g. a typo `**Status:** acceptd`). Since v1.22
 * the gate treats an unrecognized status as `unknown_status` — it does NOT
 * resolve — so a typo silently keeps a decision blocked with no obvious cause.
 * This surfaces the typo and which channel to fix (`details.status_source`).
 * Advisory (`affects_exit: false`); does not change gate behavior.
 */
async function detectAdrStatusUnrecognized(cwd: string): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const adr of await classifyDecisionAdrs(cwd)) {
    if (adr.acceptance !== "unknown_status") continue;
    issues.push({
      code: "ADR_STATUS_UNRECOGNIZED",
      severity: "warning",
      affects_exit: false,
      message: `ADR "${adr.file}" has an unrecognized status "${adr.status}" (${adr.statusSource}) — expected one of accepted | proposed | draft | rejected | superseded. A typo here keeps the decision gate blocked (it never resolves as accepted).`,
      file: adr.file,
      details: {
        status: adr.status,
        status_source: adr.statusSource,
      },
    });
  }
  return issues;
}

/**
 * Clarify advisory: a phase is `confidence: low`. Nothing else consumes
 * this field as a surfaced signal, so the advisory is the only place a
 * reviewer is told to settle the design before driving the phase.
 */
function detectLowConfidencePhase(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    if (phase.confidence === "low") {
      issues.push({
        code: "PHASE_CONFIDENCE_LOW",
        severity: "warning",
        affects_exit: false,
        message: `Phase "${phase.id}" has confidence: low — review the design before treating its tasks as ready (split, clarify, or raise confidence once resolved).`,
        file: ref.path,
        phase_id: phase.id,
        path: "confidence",
      });
    }
  }
  return issues;
}

/**
 * Readiness advisory: a task has no description at all. Deterministic
 * (empty/unset only — no subjective length floor) so it never fires on a
 * terse-but-present description.
 */
function detectMissingTaskDescription(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      if (
        task.description === undefined ||
        task.description.trim().length === 0
      ) {
        issues.push({
          code: "TASK_DESCRIPTION_MISSING",
          severity: "warning",
          affects_exit: false,
          message: `Task "${task.id}" has no description — add one sentence stating what the task changes and why.`,
          file: ref.path,
          phase_id: phase.id,
          task_id: task.id,
          path: "description",
        });
      }
    }
  }
  return issues;
}

// Re-export for downstream module organization; the CLI layer prefers
// to import directly from `state.ts` for the PlanState type.
export type { PlanState };
