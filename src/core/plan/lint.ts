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
import {
  makeDecisionResolver,
  classifyDecisionAdrs,
  readDecisionAdrFiles,
  classifyAdr,
  parseAdrCommitments,
} from "../decisions/adr.ts";
import { parseFrontMatter } from "../pack/front-matter.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PhaseEntry, PlanState } from "./state.ts";
import { collectPlanArtifacts } from "./state.ts";
import type { PlanIssue } from "./shared.ts";

const WEAK_DOD_PATTERN = /\b(TODO|FIXME|tbd)\b/i;
const WEAK_DOD_MIN_CHARS = 10;
const PLACEHOLDER_VERIFICATION_PATTERN = /^\s*(echo|true|noop)\b/i;

// P36: ADR_ACCEPTED_BODY_THIN fires only when an accepted ADR's substantive
// body is below this AND the body has zero h2 headings. Calibrated against the
// real ADR corpus — the smallest legitimate ADR in this repo is ~3610 bytes
// with 3 h2 headings, so 400 chars leaves a wide margin: only empty-to-a-few-
// lines stubs (no headings, a few dozen chars) can fire. NO heading-name
// matching — see design/decisions/adr-quality-advisory-rfc.md.
const ADR_THIN_BODY_CHARS = 400;
// Lines that are status declarations or the h1 title — stripped before
// measuring substantive body length so a stub that is *just* a status line
// (the case P36 most wants to catch) measures as empty.
const ADR_STATUS_LINE_PATTERN = /^\s*(?:[-*]\s*)?(?:\*\*Status:\*\*|Status:)/i;
const ADR_H1_PATTERN = /^\s*#\s/;
const ADR_H2_PATTERN = /^\s*##\s/;

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
    issues.push(...detectPhaseDocsWriteNoDocCheck(phases));
    // P31 clarify advisories. All `affects_exit: false` — they surface
    // uncertainty for human review and never fail `--strict`.
    issues.push(...(await detectUnresolvedDecision(opts.cwd, phases)));
    issues.push(...(await detectAdrStatusUnrecognized(opts.cwd)));
    issues.push(...(await detectAdrAcceptedBodyThin(opts.cwd)));
    issues.push(...(await detectAdrCommitmentsEmpty(opts.cwd, phases)));
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

/** A write target that `pnpm check:docs` (links + invariants) actually guards.
 *  Only `docs/**` and root-level public docs other than CHANGELOG.md qualify:
 *  CHANGELOG.md is explicitly EXCLUDED from check:docs's source scan
 *  (`ROOT_SOURCE_SKIP` in scripts/check-doc-links.mjs), so a CHANGELOG write is
 *  not something check:docs verifies — requiring a doc check for it would be a
 *  false positive. `design/**` is also excluded — that tree is validated by
 *  `validate` / `plan lint`, not the public-docs checker. */
function isPublicDocWrite(path: string): boolean {
  if (path.startsWith("docs/")) return true;
  if (path.includes("/")) return false; // not root-level
  if (path === "CHANGELOG.md") return false; // not scanned by check:docs
  return path.toLowerCase().endsWith(".md");
}

/**
 * Control-plane integrity: if a NOT-yet-done phase has a task whose `writes`
 * includes a public doc that `pnpm check:docs` guards (a `docs/` file or a
 * root-level public `.md`, excluding CHANGELOG.md), the phase's
 * `verification.commands` must include a doc check (`check:docs` /
 * `check:doc-links` / `check:doc-invariants`). Otherwise the phase will edit
 * public docs without verifying them — the docs-drift class P43 was meant to
 * stop recurring. Scoped to phases that are not yet `done`: this is a
 * forward-looking guard for work still to be done, so it never retroactively
 * scolds historical phases (which can't be changed and would be pure noise).
 * Deterministic and structural (phase YAML only — no free-text parsing), so it
 * cannot misfire. Advisory (`affects_exit: false`).
 */
function detectPhaseDocsWriteNoDocCheck(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    if (phase.status === "done") continue; // forward-looking only
    const hasDocCheck = phase.verification.commands.some((c) =>
      c.includes("check:doc"),
    );
    if (hasDocCheck) continue;
    for (const task of phase.tasks ?? []) {
      const docWrite = (task.writes ?? []).find(isPublicDocWrite);
      if (docWrite === undefined) continue;
      issues.push({
        code: "PHASE_DOCS_WRITE_NO_DOC_CHECK",
        severity: "warning",
        affects_exit: false,
        message: `Phase "${phase.id}" has a task ("${task.id}") that writes a public doc ("${docWrite}") but the phase's verification.commands run no doc check — add \`pnpm check:docs\` so doc edits are verified (the docs-drift guard).`,
        file: ref.path,
        phase_id: phase.id,
        task_id: task.id,
        path: "verification.commands",
        details: { doc_write: docWrite },
      });
      break; // one issue per phase is enough
    }
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
 * Quality advisory (P36): an `accepted` ADR whose body is an empty stub — an
 * accepted decision with no recorded reasoning. Structure-independent and
 * heading-name-agnostic by design: this repo's legitimate ADRs use a wide
 * variety of heading sets (decision/goals/rationale, never ## Consequences /
 * ## Alternatives), so name-matching would false-positive. Fires only when
 * BOTH the substantive body (frontmatter removed; status line + h1 stripped;
 * whitespace normalized) is below `ADR_THIN_BODY_CHARS` AND the raw body has
 * zero h2 headings. Advisory (`affects_exit: false`); does not change the
 * decision gate. See design/decisions/adr-quality-advisory-rfc.md.
 */
// Exported so a regression test can run it directly against the live
// `design/decisions/` corpus without paying for a full `runLint` (which also
// globs every phase's reads/writes against the filesystem). This detector only
// reads the ADR files, so the direct call is fast and deterministic.
export async function detectAdrAcceptedBodyThin(cwd: string): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const name of await readDecisionAdrFiles(cwd)) {
    if (!name.endsWith(".md")) continue;
    const content = await readFile(
      join(cwd, "design", "decisions", name),
      "utf8",
    );
    // Only accepted ADRs carry the "approved but empty" contradiction. A 0-byte
    // file classifies as "empty" (a different concern); a `**Status:** accepted`
    // line — even with no other body — classifies as "accepted" and IS in scope.
    if (classifyAdr(content).acceptance !== "accepted") continue;

    const { body } = parseFrontMatter(content);
    const lines = body.split(/\r?\n/);
    // h2 count is taken from the raw body (before stripping) so the structure
    // signal is stable regardless of the substantive-text computation.
    const headingCount = lines.filter((l) => ADR_H2_PATTERN.test(l)).length;
    const substantive = lines
      .filter(
        (l) => !ADR_STATUS_LINE_PATTERN.test(l) && !ADR_H1_PATTERN.test(l),
      )
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const bodyChars = substantive.length;

    if (bodyChars < ADR_THIN_BODY_CHARS && headingCount === 0) {
      issues.push({
        code: "ADR_ACCEPTED_BODY_THIN",
        severity: "warning",
        affects_exit: false,
        message: `ADR "design/decisions/${name}" is accepted but its body is nearly empty (${bodyChars} chars, no sections) — an accepted decision with no recorded reasoning. Add the decision and its rationale, or revert the status to proposed.`,
        file: `design/decisions/${name}`,
        details: {
          body_chars: bodyChars,
          heading_count: headingCount,
        },
      });
    }
  }
  return issues;
}

/**
 * Quality advisory (P43): an ACCEPTED ADR that resolves a `requires_decision`
 * task's decision gate records no implementation commitments — no
 * `## Implementation commitments` section, or the section is present but has
 * zero checkbox items. Surfaces "you recorded a decision but committed to no
 * follow-through".
 *
 * Scope: accepted ADRs that are REFERENCED by a gated task (via the shared
 * resolver — the same one `detectUnresolvedDecision` / verify use). This is
 * deliberately narrower than the file-centric P31/P36 advisories: a pure
 * file-centric scope would fire on every historical accepted ADR (none carry
 * the section yet), so it is scoped to gated-task-referenced ADRs to stay
 * signal, not noise. One issue per ADR file (first referencing task wins).
 * Advisory (`affects_exit: false`); never gates completion, even under
 * `--strict`.
 */
async function detectAdrCommitmentsEmpty(
  cwd: string,
  phases: PhaseEntry[],
): Promise<PlanIssue[]> {
  const resolver = await makeDecisionResolver(cwd);
  // Unique accepted ADR path -> the first gated task that referenced it.
  const accepted = new Map<string, { task_id: string; phase_id: string }>();
  for (const { phase } of phases) {
    for (const task of phase.tasks ?? []) {
      const requiresDecision =
        task.requires_decision === true || phase.requires_decision === true;
      if (!requiresDecision) continue;
      const res = await resolver.resolve(task.id, task.decision_refs);
      // Only an ADR that actually RESOLVES the gate is in scope — the message
      // says "resolves the decision gate", so a partially-accepted explicit
      // `decision_refs` set (all-must-be-accepted, hence unresolved) must not
      // fire on its one accepted ref. `TASK_DECISION_UNRESOLVED` covers that
      // unresolved case instead.
      if (!res.resolved) continue;
      for (const considered of res.considered) {
        if (!considered.accepted) continue;
        if (accepted.has(considered.path)) continue; // first referencing task wins
        accepted.set(considered.path, {
          task_id: task.id,
          phase_id: phase.id,
        });
      }
    }
  }

  const issues: PlanIssue[] = [];
  for (const [adrPath, { task_id, phase_id }] of accepted) {
    let content: string;
    try {
      content = await readFile(join(cwd, adrPath), "utf8");
    } catch {
      continue; // referenced ADR vanished — nothing to advise on
    }
    const { hasSection, items } = parseAdrCommitments(content);
    if (hasSection && items.length > 0) continue; // has real commitments — fine
    const reason = hasSection
      ? "the section has no checkbox items"
      : "no ## Implementation commitments section";
    issues.push({
      code: "ADR_COMMITMENTS_EMPTY",
      severity: "warning",
      affects_exit: false,
      message: `Accepted ADR "${adrPath}" resolves the decision gate for task "${task_id}" but records no implementation commitments (${reason}). Add a "## Implementation commitments" checkbox list; if the decision genuinely implies no downstream work, record that explicitly as a checked item (e.g. "- [x] No downstream implementation work.").`,
      file: adrPath,
      phase_id,
      task_id,
      details: {
        has_section: hasSection,
        item_count: items.length,
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
