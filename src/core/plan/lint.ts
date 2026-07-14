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
import { projectRegularFilePresence } from "./checks/fs.ts";
import {
  makeDecisionResolver,
  classifyDecisionAdrs,
  readDecisionAdrFiles,
  readLiveDecisionFile,
  classifyAdr,
  parseAdrCommitments,
} from "../decisions/adr.ts";
import { parseFrontMatter } from "../pack/front-matter.ts";
import { resolveDecisionReadPath } from "../project-fs/index.ts";
import { readOwnedText } from "../project-fs/operations.ts";
import { parse as parseYaml } from "yaml";
import { Project } from "../schemas/project.ts";
import { detectContextFitAdvisories } from "../context-fit/advisories.ts";
import { loadAgentContextBudgetBestEffort } from "../context-fit/load-context-budget.ts";
import { readProjectTextOrNull } from "../project-read.ts";
import type { PhaseEntry, PlanState } from "./state.ts";
import { collectPlanArtifacts } from "./state.ts";
import type { PlanIssue } from "./shared.ts";
import { readPackSources } from "../progress/all-sources.ts";
import { validateSnapshotEventEvidence } from "../archive/snapshot-evidence.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";

const WEAK_DOD_PATTERN = /\b(TODO|FIXME|tbd)\b/i;
const WEAK_DOD_MIN_CHARS = 10;
const PLACEHOLDER_VERIFICATION_PATTERN = /^\s*(echo|true|noop)\b/i;
const REGRESSION_EVIDENCE_DIRECTORIES = new Set([
  "tests",
  "test",
  "__tests__",
  "spec",
  "specs",
  "fixtures",
  "reproductions",
]);

// ADR_ACCEPTED_BODY_THIN fires only when an accepted ADR's substantive
// body is below this AND the body has zero h2 headings. Calibrated against the
// real ADR corpus — the smallest legitimate ADR in this repo is ~3610 bytes
// with 3 h2 headings, so 400 chars leaves a wide margin: only empty-to-a-few-
// lines stubs (no headings, a few dozen chars) can fire. NO heading-name
// matching — see design/decisions/adr-quality-advisory-rfc.md.
const ADR_THIN_BODY_CHARS = 400;
// Lines that are status declarations or the h1 title — stripped before
// measuring substantive body length so a stub that is *just* a status line
// (the case this most wants to catch) measures as empty.
const ADR_STATUS_LINE_PATTERN = /^\s*(?:[-*]\s*)?(?:\*\*Status:\*\*|Status:)/i;
const ADR_H1_PATTERN = /^\s*#\s/;
const ADR_H2_PATTERN = /^\s*##\s/;

export type LintOptions = {
  cwd: string;
  /**
   * When true, runs opt-in quality/readiness advisories (WEAK_DOD,
   * PLACEHOLDER_VERIFICATION, TASK_DECISION_UNRESOLVED, PHASE_CONFIDENCE_LOW,
   * TASK_DESCRIPTION_MISSING, TASK_REGRESSION_EVIDENCE_MISSING, and the
   * Context Fit advisories
   * TASK_CONTEXT_PACK_LARGE, TASK_CONTEXT_BUDGET_UNACHIEVABLE,
   * TASK_DECLARED_DECISION_LARGE, TASK_READS_MATCH_TOO_MANY). Off by default so
   * the base lint stays lean; all of these advisories are `affects_exit:
   * false`, so they never fail `--strict` even when this is on.
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
 * cross-artifact comparison belongs to `plan analyze`. Reporting
 * it from both commands would produce duplicate output for the same
 * underlying issue.
 */
export async function runLint(opts: LintOptions): Promise<LintResult> {
  const includeQuality = opts.includeQuality === true;
  const {
    state,
    archivedTaskIndex,
    fallbackPhases,
    fileIssues,
    skippedChecks,
  } = await collectPlanArtifacts(opts.cwd);

  const issues: PlanIssue[] = [...fileIssues];
  const phases: PhaseEntry[] = state?.phases ?? fallbackPhases;
  // Archived task ids (step 4a) — existence-only, collision-checked. Empty in the
  // no-roadmap fallback. Lets a cross-phase depends_on into a hand-deleted
  // COMPLETED phase resolve instead of falsely firing TASK_DEPENDS_ON_UNRESOLVED.
  const archivedKnownTaskIds = new Set(archivedTaskIndex.keys());

  // Structural integrity that works on whatever phases parsed cleanly.
  issues.push(...detectDuplicateTaskIds(phases));
  issues.push(...detectDuplicatePhaseIds(phases));
  issues.push(...detectPhaseIdNaming(phases));
  issues.push(...detectTaskIdPhasePrefix(phases));

  // Task Readiness Schema. All twelve detectors are no-ops for
  // tasks that declare none of the optional fields. Sync detectors run
  // first; async detectors that touch the filesystem run after so a
  // configuration error in the sync set is visible quickly.
  issues.push(...detectTaskDependsOnUnresolved(phases, archivedKnownTaskIds));
  issues.push(...detectTaskDependsOnSelfReference(phases));
  issues.push(...detectTaskDependsOnCycle(phases));
  issues.push(...detectTaskDecisionRefUnsafePath(phases));
  issues.push(...detectTaskReadsUnsafePath(phases));
  issues.push(...detectTaskReadsGlobInvalid(phases));
  issues.push(...detectTaskWritesUnsafePath(phases));
  issues.push(...detectTaskWritesGlobInvalid(phases));
  issues.push(...detectTaskWritesOverBroad(phases));
  // protected-paths list is configurable. Load once per
  // lint run, then inject into the detector. Falls back to the
  // hardcoded constant when `design/rules/protected-paths.md` is
  // absent.
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
    // Snapshot evidence: every archived snapshot's progress_events evidence must
    // resolve from the durable ledger (loose ∪ validated packs) — NOT legacy.
    // Closes the silent-provenance-loss gap. Snapshots unreadable during the scan
    // become a skipped check, not a failure.
    const evidenceSkips = await appendSnapshotEvidenceIssues(opts.cwd, issues);
    for (const skip of evidenceSkips) skippedChecks.push(skip);
  }

  if (includeQuality) {
    issues.push(...detectWeakDoD(phases));
    issues.push(...detectPlaceholderVerification(phases));
    issues.push(...detectPhaseDocsWriteNoDocCheck(phases));
    // Clarify advisories. All `affects_exit: false` — they surface
    // uncertainty for human review and never fail `--strict`.
    issues.push(...(await detectUnresolvedDecision(opts.cwd, phases)));
    issues.push(...(await detectAdrStatusUnrecognized(opts.cwd)));
    issues.push(...(await detectAdrAcceptedBodyThin(opts.cwd)));
    issues.push(...(await detectAdrCommitmentsEmpty(opts.cwd, phases)));
    issues.push(...detectLowConfidencePhase(phases));
    issues.push(...detectMissingTaskDescription(phases));
    issues.push(
      ...(await detectMissingBugfixRegressionEvidence(opts.cwd, phases)),
    );
    // Context Fit advisories. All `affects_exit: false`; they
    // reuse the explain metrics (natural / minimum-achievable floor) and
    // the budget mapping, read decision files, and expand reads globs —
    // local and deterministic, no network/model/tokenizer. The pack-size
    // advisories need an agent name for the build, resolved best-effort from
    // project.yaml's default_agent; the default agent's `context_budget`
    // profiles (also best-effort) let `TASK_CONTEXT_BUDGET_UNACHIEVABLE` judge
    // against the same recommended byte value `recommend` / `task prepare`
    // surface (a same-name override wins over the built-in fallback). A
    // malformed block must not fail an advisory pass, so it degrades to the
    // built-in fallback rather than throwing.
    const agentName = await resolveDefaultAgent(opts.cwd);
    let agentContextBudgetProfiles:
      | Record<string, { max_bytes: number }>
      | undefined;
    try {
      agentContextBudgetProfiles = (
        await loadAgentContextBudgetBestEffort(opts.cwd, undefined)
      )?.profiles;
    } catch {
      agentContextBudgetProfiles = undefined;
    }
    issues.push(
      ...(await detectContextFitAdvisories({
        cwd: opts.cwd,
        phases,
        agentName,
        ...(agentContextBudgetProfiles !== undefined
          ? { agentContextBudgetProfiles }
          : {}),
      })),
    );
  }

  return { issues, skippedChecks, includeQuality };
}

/**
 * Best-effort resolution of the project's default agent name, used only by the
 * pack-size advisories to build a task's context pack. Returns undefined
 * when project.yaml is absent or unparseable — the advisory pass then skips the
 * pack-size advisories rather than failing the lint.
 */
async function resolveDefaultAgent(cwd: string): Promise<string | undefined> {
  try {
    const raw = await readProjectTextOrNull(cwd, ".code-pact/project.yaml");
    if (raw === null) return undefined;
    return Project.parse(parseYaml(raw) as unknown).default_agent;
  } catch {
    return undefined;
  }
}

/**
 * Validate archived-snapshot `progress_events` evidence against the DURABLE
 * ledger (loose ∪ Tier-2-validated packs — never legacy). Pushes one
 * `SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE` error per unresolved/wrong evidence
 * reference; returns the names of any skipped checks (snapshots that could not
 * be read). Lenient pack read: a corrupt pack does not abort the lint.
 */
async function appendSnapshotEvidenceIssues(
  cwd: string,
  issues: PlanIssue[],
): Promise<string[]> {
  let packSources;
  try {
    packSources = await readPackSources(cwd, "lenient");
  } catch {
    // The pack read failing entirely is surfaced elsewhere (collectPlanArtifacts);
    // skip the evidence check rather than double-reporting.
    return ["SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE"];
  }
  const resolved = new Map<string, ProgressEvent>();
  for (const f of packSources.looseFiles) resolved.set(f.id, f.event);
  for (const f of packSources.validatedPackFiles) resolved.set(f.id, f.event);

  const { result, skipped } = await validateSnapshotEventEvidence(
    cwd,
    resolved,
  );
  if (!result.ok) {
    for (const issue of result.issues) {
      issues.push({
        code: "SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE",
        severity: "error",
        message: issue.message,
        phase_id: issue.phase_id,
        task_id: issue.task_id,
        details: { event_id: issue.event_id, reason: issue.reason },
      });
    }
  }
  return skipped.length > 0 ? ["SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE"] : [];
}

/** Quality heuristic: DoD bullets that look unfinished. */
function detectWeakDoD(phases: PhaseEntry[]): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    phase.definition_of_done.forEach((bullet, index) => {
      const trimmed = bullet.trim();
      if (
        trimmed.length < WEAK_DOD_MIN_CHARS ||
        WEAK_DOD_PATTERN.test(trimmed)
      ) {
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
 *  (`ROOT_SOURCE_SKIP` in scripts/check-doc-links.ts), so a CHANGELOG write is
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
 * public docs without verifying them — the docs-drift class this was meant to
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
    const hasDocCheck = phase.verification.commands.some(c =>
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
 * word that is not recognized (e.g. a typo `**Status:** acceptd`). The gate
 * treats an unrecognized status as `unknown_status` — it does NOT
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
 * Quality advisory: an `accepted` ADR whose body is an empty stub — an
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
export async function detectAdrAcceptedBodyThin(
  cwd: string,
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const path of await readDecisionAdrFiles(cwd)) {
    if (!path.endsWith(".md")) continue;
    // Project-contained read + degrade-on-error: a `design/decisions` symlinked
    // outside is `unsafe` → skip; an unreadable entry (e.g. a directory named
    // `*.md` → readFile EISDIR) is caught and skipped, not thrown uncoded which
    // would crash `plan lint` (exit 3). Best-effort advisory, like the loaders.
    let content: string;
    try {
      const r = await readLiveDecisionFile(cwd, path);
      if (r.kind !== "ok") continue;
      content = r.content;
    } catch {
      continue;
    }
    // Only accepted ADRs carry the "approved but empty" contradiction. A 0-byte
    // file classifies as "empty" (a different concern); a `**Status:** accepted`
    // line — even with no other body — classifies as "accepted" and IS in scope.
    if (classifyAdr(content).acceptance !== "accepted") continue;

    const { body } = parseFrontMatter(content);
    const lines = body.split(/\r?\n/);
    // h2 count is taken from the raw body (before stripping) so the structure
    // signal is stable regardless of the substantive-text computation.
    const headingCount = lines.filter(l => ADR_H2_PATTERN.test(l)).length;
    const substantive = lines
      .filter(l => !ADR_STATUS_LINE_PATTERN.test(l) && !ADR_H1_PATTERN.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const bodyChars = substantive.length;

    if (bodyChars < ADR_THIN_BODY_CHARS && headingCount === 0) {
      issues.push({
        code: "ADR_ACCEPTED_BODY_THIN",
        severity: "warning",
        affects_exit: false,
        message: `ADR "${path}" is accepted but its body is nearly empty (${bodyChars} chars, no sections) — an accepted decision with no recorded reasoning. Add the decision and its rationale, or revert the status to proposed.`,
        file: path,
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
 * Quality advisory: an ACCEPTED ADR that resolves a `requires_decision`
 * task's decision gate records no implementation commitments — no
 * `## Implementation commitments` section, or the section is present but has
 * zero checkbox items. Surfaces "you recorded a decision but committed to no
 * follow-through".
 *
 * Scope: accepted ADRs from a RESOLVED requires_decision gate (via the shared
 * resolver — the same one `detectUnresolvedDecision` / verify use; we skip the
 * task unless `res.resolved`). This is deliberately narrower than the
 * file-centric advisories: a pure file-centric scope would fire on every
 * historical accepted ADR (none carry the section yet). It is also narrower than
 * "referenced by a gated task": a historical/unreferenced ADR never fires, and
 * an accepted ref inside an UNRESOLVED explicit decision_refs set (one proposed
 * ref leaves the gate unresolved) does not fire either — the message says the
 * ADR "resolves the gate", so it must. One issue per ADR file (first task wins).
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
      content = await readOwnedText(
        await resolveDecisionReadPath(cwd, adrPath),
      );
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

function isSafeRegressionEvidencePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.includes("\0")) return false;
  if (path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  if (path.includes("\\")) return false;
  const segments = path.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}

function matchesRegressionEvidenceFilename(filename: string): boolean {
  if (/^.+\.test\..+$/.test(filename)) return true;
  if (/^.+\.spec\..+$/.test(filename)) return true;
  if (/^.+_test\..+$/.test(filename)) return true;
  return /^test_.+\..+$/.test(filename);
}

function isUnderRegressionEvidenceDirectory(
  segments: readonly string[],
): boolean {
  return segments.some(
    (segment, index) =>
      REGRESSION_EVIDENCE_DIRECTORIES.has(segment) &&
      index < segments.length - 1,
  );
}

function isRegressionEvidenceDeclaration(path: string): boolean {
  if (!isSafeRegressionEvidencePath(path)) return false;
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? "";
  return (
    isUnderRegressionEvidenceDirectory(segments) ||
    matchesRegressionEvidenceFilename(filename)
  );
}

async function detectMissingBugfixRegressionEvidence(
  cwd: string,
  phases: PhaseEntry[],
): Promise<PlanIssue[]> {
  const issues: PlanIssue[] = [];
  for (const { phase, ref } of phases) {
    for (const task of phase.tasks ?? []) {
      if (task.type !== "bugfix") continue;
      if (task.status !== "planned" && task.status !== "in_progress") continue;

      const declaredNewEvidence =
        task.writes?.some(isRegressionEvidenceDeclaration) === true;
      if (declaredNewEvidence) continue;

      let existingEvidence = false;
      for (const acceptanceRef of task.acceptance_refs ?? []) {
        if (!isRegressionEvidenceDeclaration(acceptanceRef)) continue;
        if (
          (await projectRegularFilePresence(cwd, acceptanceRef)) === "present"
        ) {
          existingEvidence = true;
          break;
        }
      }
      if (existingEvidence) continue;

      issues.push({
        code: "TASK_REGRESSION_EVIDENCE_MISSING",
        severity: "warning",
        affects_exit: false,
        message: `Task "${task.id}" is a bugfix but declares no static regression evidence. Add a new test, fixture, or reproduction artifact to writes, or reference an existing one from acceptance_refs.`,
        file: ref.path,
        phase_id: phase.id,
        task_id: task.id,
        details: {
          accepted_sources: ["writes", "acceptance_refs"],
          accepted_forms: ["test", "fixture", "reproduction"],
          acceptance_refs_must_exist: true,
        },
        recovery: {
          manual_action:
            "Add a new test, fixture, or reproduction path to writes, or add an existing artifact path to acceptance_refs.",
          confirm: "code-pact plan lint --include-quality --json",
          reference:
            "docs/concepts/task-readiness-fields.md#regression-evidence-for-bugfix-tasks",
        },
      });
    }
  }
  return issues;
}

// Re-export for downstream module organization; the CLI layer prefers
// to import directly from `state.ts` for the PlanState type.
export type { PlanState };
