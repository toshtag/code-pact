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
import type { PhaseEntry, PlanState } from "./state.ts";
import { collectPlanArtifacts } from "./state.ts";
import type { PlanIssue } from "./shared.ts";

const WEAK_DOD_PATTERN = /\b(TODO|FIXME|tbd)\b/i;
const WEAK_DOD_MIN_CHARS = 10;
const PLACEHOLDER_VERIFICATION_PATTERN = /^\s*(echo|true|noop)\b/i;

export type LintOptions = {
  cwd: string;
  /**
   * When true, runs subjective quality heuristics (WEAK_DOD,
   * PLACEHOLDER_VERIFICATION). Off by default so CI pipelines do not
   * fail on style judgments.
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

// Re-export for downstream module organization; the CLI layer prefers
// to import directly from `state.ts` for the PlanState type.
export type { PlanState };
