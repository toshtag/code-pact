import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadYaml, ParseError } from "../../io/load.ts";
import { resolveOwnedProjectPath, resolveWithinProject } from "../path-safety.ts";
import { Phase, type Phase as PhaseT } from "../schemas/phase.ts";
import {
  ProgressLog,
  type ProgressEvent,
} from "../schemas/progress-event.ts";
import { Roadmap, type PhaseRef, type Roadmap as RoadmapT } from "../schemas/roadmap.ts";
import type { Task as TaskT } from "../schemas/task.ts";
import { mergeProgressStreams, progressPath, resolveProgressPath } from "../progress/io.ts";
import {
  eventsDir,
  type LoadedEventFile,
} from "../progress/events-io.ts";
import {
  readAllProgressEventSources,
  readPackSources,
  durableIdsAndArchivedTasks,
  filterArchivedTaskLegacyConflicts,
} from "../progress/all-sources.ts";
import type { FileIssue } from "./shared.ts";
import {
  archivedEntriesFromSnapshot,
  discoverUnreferencedSnapshots,
  mergeArchivedTaskIndex,
  resolveMissingPhaseRef,
  type ArchivedTaskEntry,
  type UnreferencedSnapshotInvalid,
} from "../archive/load-phase-snapshot.ts";

export type PhaseEntry = {
  ref: PhaseRef;
  absPath: string;
  phase: PhaseT;
};

export type PlanState = {
  cwd: string;
  roadmapPath: string;
  roadmap: RoadmapT;
  phases: PhaseEntry[];
  progress: { path: string; events: ProgressEvent[] } | null;
  taskIndex: Map<string, { phaseId: string; task: TaskT }>;
  /**
   * design-docs-ephemeral (step 4a): task ids recovered from the archive
   * snapshots of hand-deleted COMPLETED phases whose roadmap ref still points at
   * them. EXISTENCE-ONLY — consulted by `detectTaskDependsOnUnresolved` and the
   * orphan-progress-event detector so a cross-phase `depends_on` into / a ledger
   * event for a deleted phase's task is not falsely flagged. NEVER a satisfaction
   * source (dependency satisfaction stays event-based) and NEVER merged into
   * `phases` (which is live-only). Collision-checked: an id that collides with a
   * live id or another snapshot is EXCLUDED here and surfaced as
   * `PHASE_SNAPSHOT_INVALID`, so it can never silence a real diagnostic.
   */
  archivedTaskIndex: Map<string, ArchivedTaskEntry>;
};

/** The live-task-id set (existence side) consulted alongside the live taskIndex. */
export function archivedKnownTaskIds(state: PlanState): Set<string> {
  return new Set(state.archivedTaskIndex.keys());
}

export type LenientLoadResult = {
  /** Populated when the roadmap parsed successfully; null otherwise. */
  state: PlanState | null;
  /**
   * Archived task ids (step 4a) — same as `state.archivedTaskIndex` when `state`
   * is set, so the lenient lint path can consult it even though it also exposes
   * `state`. Empty in the no-roadmap fallback (no ref to tolerate against).
   */
  archivedTaskIndex: Map<string, ArchivedTaskEntry>;
  /** Best-effort phase entries when the roadmap failed; empty when state is set. */
  fallbackPhases: PhaseEntry[];
  /** File-level issues collected during loading (parse/schema errors). */
  fileIssues: FileIssue[];
  /**
   * Names of cross-artifact checks that lint should skip because their
   * inputs are missing. Communicated back to the lint orchestrator so it
   * can record them under `data.skipped_checks` in JSON output.
   */
  skippedChecks: string[];
};

const ROADMAP_REL_PATH = ["design", "roadmap.yaml"] as const;

function roadmapPath(cwd: string): string {
  return join(cwd, ...ROADMAP_REL_PATH);
}

/**
 * The single phase-read site for the PlanState family — `loadPlanState`
 * (strict), `collectPlanArtifacts` (lenient), and `scanPhasesDirBestEffort`.
 * Distinct from the raw-throwing `core/plan/load-phase.ts` seam ON PURPOSE: it
 * throws a file-tagged `ParseError` on a schema-invalid phase so the lenient
 * loader can collect a `FileIssue` pointing at the offending file.
 *
 * SCOPE — live phase YAML ONLY; returns a full `Phase`. It must NOT coerce an
 * archived snapshot into `Phase` (a snapshot is intentionally smaller — no
 * objective / definition_of_done / verification / prose — so it is not a
 * `Phase`). This helper takes only `absPath`; archived-phase support needs at
 * least the roadmap ref (`id` / `path`), and `PlanState.phases` is typed
 * `PhaseEntry { phase: Phase }`. So the design-docs-ephemeral archived support
 * (step 4) must EITHER wrap this read with roadmap-ref-aware archived-resolution
 * logic OR widen the PlanState representation to a `live | archived`
 * discriminated union — never by silently returning a snapshot from here. (A
 * missing file still surfaces as raw ENOENT here, same as the other seam, which
 * is the natural place such a wrapper would intercept.)
 */
function loadPlanStatePhase(absPath: string): Promise<PhaseT> {
  return loadYaml(absPath, Phase);
}

function planStateConfigError(file: string, err: unknown): Error {
  if ((err as NodeJS.ErrnoException).code === "CONFIG_ERROR") return err as Error;
  const msg = err instanceof Error ? err.message : String(err);
  const e = new Error(`${file} cannot be read or parsed as plan state: ${msg}`);
  (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
  return e;
}

async function loadPlanStateRoadmap(absPath: string): Promise<RoadmapT> {
  try {
    return await loadYaml(absPath, Roadmap);
  } catch (err) {
    throw planStateConfigError("design/roadmap.yaml", err);
  }
}

async function loadPlanStatePhaseStrict(ref: PhaseRef, absPath: string): Promise<PhaseT> {
  try {
    return await loadPlanStatePhase(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
    throw planStateConfigError(ref.path, err);
  }
}

/**
 * Resolve a project-relative control-plane path (the roadmap, or a roadmap-
 * referenced phase) to an OWNED absolute path for the STRICT loader. A `..` /
 * symlink component is mapped to CONFIG_ERROR (fail-closed) so a hostile repo
 * cannot point the roadmap/phase graph at another project file or an external
 * target and have it read as the control plane. The actual `loadYaml` then
 * operates on the owned path, so its ParseError-on-malformed contract is
 * unchanged. (CWE-59.)
 */
async function resolveGraphPathStrict(cwd: string, relPath: string): Promise<string> {
  try {
    return await resolveOwnedProjectPath(cwd, relPath);
  } catch (err) {
    const e = new Error(
      `"${relPath}" is not a safe project-relative path: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
}

/**
 * Thrown by the strict loader when a tolerated archive snapshot is corrupt /
 * identity-mismatched / collides — fail-closed, distinct from a plain missing file.
 */
export class PhaseSnapshotInvalidError extends Error {
  readonly code = "PHASE_SNAPSHOT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "PhaseSnapshotInvalidError";
  }
}

/**
 * design-docs-ephemeral (step 4a) — handle a roadmap ref whose live phase file is
 * MISSING (ENOENT). Returns one of:
 *   - `{ tolerated: true, entries }`  — a valid archive snapshot proves a completed
 *     phase; `entries` are its archived task candidates (collision-checked later).
 *   - `{ tolerated: false, invalid: <reason> }` — a snapshot exists but cannot
 *     release the phase (PHASE_SNAPSHOT_INVALID, fail-closed).
 *   - `{ tolerated: false }` — no snapshot at all; the caller keeps its original
 *     missing-file behavior (re-throw ENOENT / push a parse issue).
 * Never reads or coerces a snapshot into `Phase`; entries are existence-only.
 */
async function resolveDeletedPhaseRef(
  cwd: string,
  ref: PhaseRef,
): Promise<
  | { tolerated: true; entries: ArchivedTaskEntry[] }
  | { tolerated: false; invalid?: string }
> {
  const res = await resolveMissingPhaseRef(cwd, ref);
  if (res.kind === "tolerated") {
    return { tolerated: true, entries: archivedEntriesFromSnapshot(res.snapshot) };
  }
  if (res.kind === "fail_invalid") return { tolerated: false, invalid: res.reason };
  return { tolerated: false };
}

/**
 * design-docs-ephemeral (step 4b): a soft discovery failure (an unreadable archive
 * dir, or a corrupt / unsafe-stem unreferenced snapshot file) → an ADVISORY
 * `PHASE_SNAPSHOT_INVALID` FileIssue at `warning` severity with `affects_exit:false`,
 * so `plan lint --strict` never fails on the advisory itself (A5). This surface (the
 * lenient loader → `plan lint`) is the ONLY place the `PHASE_SNAPSHOT_INVALID`
 * advisory appears; doctor/validate do not emit it.
 *
 * SCOPE of "silent": only the `PHASE_SNAPSHOT_INVALID` advisory is suppressed
 * outside `plan lint`. INDEPENDENT diagnostics still fire on the CONSEQUENCES of a
 * soft-invalid snapshot supplying no ids — a live `depends_on` to a would-be id →
 * `TASK_DEPENDS_ON_UNRESOLVED`; a leftover progress event for one →
 * `ORPHAN_PROGRESS_EVENT`. Those are NOT silenced (silencing them would hide real
 * dependency / progress-ledger drift), so `validate --strict` is green only when no
 * such independent issue remains.
 */
function unreferencedInvalidToFileIssue(inv: UnreferencedSnapshotInvalid): FileIssue {
  return {
    code: "PHASE_SNAPSHOT_INVALID",
    severity: "warning",
    affects_exit: false,
    message:
      inv.scope === "directory"
        ? `archive snapshots could not be discovered (advisory): ${inv.reason}`
        : `archive snapshot "${inv.fileStem}.json" is invalid and was skipped (advisory): ${inv.reason}`,
    file:
      inv.scope === "directory"
        ? ".code-pact/state/archive/phases"
        : `.code-pact/state/archive/phases/${inv.fileStem}.json`,
  };
}

function buildTaskIndex(
  phases: PhaseEntry[],
): Map<string, { phaseId: string; task: TaskT }> {
  const index = new Map<string, { phaseId: string; task: TaskT }>();
  for (const entry of phases) {
    for (const task of entry.phase.tasks ?? []) {
      if (!index.has(task.id)) {
        index.set(task.id, { phaseId: entry.phase.id, task });
      }
    }
  }
  return index;
}

/**
 * Strict loader for plan analyze and any consumer that needs a complete,
 * schema-valid snapshot. Throws ParseError on the first invalid file.
 * Progress log is optional: when the file is missing, `progress` is null
 * and analyze treats every task as historical / planned.
 */
export async function loadPlanState(cwd: string): Promise<PlanState> {
  // Contained roadmap read (CONFIG_ERROR on `..`/symlink escape) so this strict
  // graph — behind task/phase runbook, status, plan analyze — can never be read
  // from an out-of-project roadmap.
  const rmPath = await resolveGraphPathStrict(cwd, "design/roadmap.yaml");
  const roadmap = await loadPlanStateRoadmap(rmPath);

  const phases: PhaseEntry[] = [];
  const archivedCandidates: ArchivedTaskEntry[] = [];
  for (const ref of roadmap.phases) {
    // Contain each roadmap-referenced phase path too; a symlink-escaping ref is a
    // hard CONFIG_ERROR (NOT an ENOENT archive-toleration candidate).
    const absPath = await resolveGraphPathStrict(cwd, ref.path);
    try {
      phases.push({ ref, absPath, phase: await loadPlanStatePhaseStrict(ref, absPath) });
    } catch (err) {
      // design-docs-ephemeral (step 4a): ONLY a missing file (ENOENT) is a
      // candidate for archive toleration; a ParseError (schema-invalid live file)
      // is already mapped to CONFIG_ERROR by loadPlanStatePhaseStrict.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const r = await resolveDeletedPhaseRef(cwd, ref);
      if (r.tolerated) {
        archivedCandidates.push(...r.entries);
        continue; // skip the entry — the phase is gone and terminal
      }
      if (r.invalid !== undefined) {
        throw new PhaseSnapshotInvalidError(
          `${ref.path} is missing and its archive snapshot cannot release it: ${r.invalid}`,
        );
      }
      throw err; // no snapshot — fail closed exactly as before
    }
  }

  // design-docs-ephemeral (step 4b): also discover UNREFERENCED archived phases
  // (roadmap ref gone) so a cross-phase depends_on into one still resolves. Strict
  // loader IGNORES discovery's soft `invalid[]` (no throw — an unreadable dir / a
  // corrupt unreferenced file supplies no ids; the plan-lint advisory surface is the
  // only place it's reported). A live dep on a missing id still fails via
  // TASK_DEPENDS_ON_UNRESOLVED. Only a VALID snapshot's collision is a hard error,
  // caught by the merge below.
  const discovered = await discoverUnreferencedSnapshots(
    cwd,
    new Set(roadmap.phases.map((r) => r.id)),
  );
  archivedCandidates.push(...discovered.entries);

  const taskIndex = buildTaskIndex(phases);
  // Collision-checked merge: an archived id that collides with a live id or
  // another snapshot is excluded AND fail-closed (never a silencer).
  const merge = mergeArchivedTaskIndex(new Set(taskIndex.keys()), archivedCandidates);
  if (merge.collisions.length > 0) {
    throw new PhaseSnapshotInvalidError(
      `archive snapshot task ids collide with the live plan: ${merge.collisions
        .map((c) => c.reason)
        .join("; ")}`,
    );
  }

  let progress: PlanState["progress"] = null;
  const progPath = progressPath(cwd);
  // Shared reader (strict): legacy + loose + Tier-2-bound packs, with the
  // LEGACY_EVENT_FOR_ARCHIVED_TASK gate. A corrupt event file / unbound pack /
  // legacy conflict propagates (this is the strict artifact path behind validate).
  const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
  const hasLegacy = sources.rawLegacyEvents.length > 0;
  const allFiles = [...sources.looseFiles, ...sources.validatedPackFiles];
  if (hasLegacy || allFiles.length > 0) {
    progress = {
      path: progPath,
      events: mergeProgressStreams(sources.mergeableLegacyEvents, allFiles),
    };
  }

  return {
    cwd,
    roadmapPath: rmPath,
    roadmap,
    phases,
    progress,
    taskIndex,
    archivedTaskIndex: merge.index,
  };
}

function pushParseIssue(issues: FileIssue[], err: unknown, file: string): void {
  if (err instanceof ParseError) {
    issues.push({
      code: "SCHEMA_ERROR",
      severity: "error",
      message: `${file} failed schema validation`,
      file,
      details: { issues: err.issues },
    });
    return;
  }
  // A corrupt per-event file keeps the diagnostic code that
  // validateEventFileContent tagged it with (EVENT_FILE_ID_MISMATCH for the
  // filename↔content invariant, SCHEMA_ERROR for a parseable-but-invalid event)
  // so `plan lint` matches what `doctor` reports, rather than collapsing both to
  // a generic INVALID_YAML. A genuinely unparseable body keeps INVALID_YAML below.
  const tag = (err as NodeJS.ErrnoException).code;
  if (tag === "EVENT_FILE_ID_MISMATCH" || tag === "SCHEMA_ERROR") {
    issues.push({
      code: tag,
      severity: "error",
      message: err instanceof Error ? err.message : String(err),
      file,
    });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  issues.push({
    code: "INVALID_YAML",
    severity: "error",
    message: `Cannot read or parse ${file}: ${msg}`,
    file,
  });
}

/**
 * Lenient loader for plan lint. Collects parse/schema errors per file
 * instead of stopping at the first failure so a single run can surface
 * as many independent issues as possible.
 *
 * When roadmap.yaml itself is invalid, the loader scans design/phases/
 * directly (best-effort) so duplicate-id and naming checks can still
 * run on parseable phase files. Roadmap-dependent checks are reported
 * back via `skippedChecks` and the orchestrator records them in JSON.
 */
export async function collectPlanArtifacts(
  cwd: string,
): Promise<LenientLoadResult> {
  const fileIssues: FileIssue[] = [];
  const skippedChecks: string[] = [];
  const rmPath = roadmapPath(cwd); // display label for the returned field

  let roadmap: RoadmapT | null = null;
  try {
    // Contain the roadmap read. A `..`/symlink escape OR a parse/schema error
    // both become a FileIssue on `design/roadmap.yaml` → planArtifactsUnreadable
    // fail-closes (so decision prune/retire cannot be authorized off an
    // out-of-project roadmap that hides the current project's referencing tasks).
    // pushParseIssue tags the containment refusal (a non-ParseError CONFIG_ERROR)
    // as an INVALID_YAML error FileIssue.
    const rmAbs = await resolveWithinProject(cwd, "design/roadmap.yaml");
    roadmap = await loadYaml(rmAbs, Roadmap);
  } catch (err) {
    pushParseIssue(fileIssues, err, "design/roadmap.yaml");
    skippedChecks.push(
      "MISSING_PHASE_FILE",
      "ORPHAN_PHASE_FILE",
      "PHASE_ID_MISMATCH",
    );
  }

  if (!roadmap) {
    // Roadmap is unparseable. Scan design/phases/ directly so we can
    // still report duplicate-id / naming issues on parseable files. No roadmap
    // ref ⇒ nothing to tolerate against ⇒ empty archived index.
    const fallback = await scanPhasesDirBestEffort(cwd, fileIssues);
    return {
      state: null,
      archivedTaskIndex: new Map(),
      fallbackPhases: fallback,
      fileIssues,
      skippedChecks,
    };
  }

  const phases: PhaseEntry[] = [];
  const archivedCandidates: ArchivedTaskEntry[] = [];
  for (const ref of roadmap.phases) {
    let absPath: string;
    try {
      // Contain each phase ref; a symlink-escaping ref becomes a graph-file
      // FileIssue (fail-closed for prune/retire), not an out-of-project read.
      absPath = await resolveWithinProject(cwd, ref.path);
    } catch (err) {
      pushParseIssue(fileIssues, err, ref.path);
      continue;
    }
    try {
      const phase = await loadPlanStatePhase(absPath);
      phases.push({ ref, absPath, phase });
    } catch (err) {
      // design-docs-ephemeral (step 4a): only a missing file (ENOENT) is a
      // toleration candidate; a ParseError keeps its existing FileIssue.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const r = await resolveDeletedPhaseRef(cwd, ref);
        if (r.tolerated) {
          archivedCandidates.push(...r.entries);
          continue; // skip the entry; detectMissingPhaseFiles reports nothing either
        }
        if (r.invalid !== undefined) {
          // Skip the entry but do NOT push a PHASE_SNAPSHOT_INVALID FileIssue here:
          // `detectMissingPhaseFiles` runs over the same roadmap refs in the lint
          // orchestrator and emits the single PHASE_SNAPSHOT_INVALID for this ref.
          // Pushing it here too would double-report the same code for one phase.
          continue;
        }
        // no snapshot — fall through to the original missing-file FileIssue.
      }
      pushParseIssue(fileIssues, err, ref.path);
    }
  }

  let progress: PlanState["progress"] = null;
  const progPath = progressPath(cwd);
  // Keep the lenient loader's OWN legacy parse so a corrupt legacy file surfaces
  // as a SCHEMA_ERROR FileIssue (and lint keeps running) — the shared reader's
  // strict legacy parse would throw. Packs + the legacy-conflict gate come from
  // the shared pack reader in lenient mode.
  let legacyEvents: ProgressEvent[] = [];
  let hasLegacy = false;
  try {
    const progReadPath = await resolveProgressPath(cwd);
    const raw = await readFile(progReadPath, "utf8");
    const parsed = ProgressLog.safeParse(parseYaml(raw) as unknown);
    if (parsed.success) {
      legacyEvents = parsed.data.events;
      hasLegacy = true;
    } else {
      fileIssues.push({
        code: "SCHEMA_ERROR",
        severity: "error",
        message: `${progPath} failed schema validation`,
        file: progPath,
        details: { issues: parsed.error.issues },
      });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") pushParseIssue(fileIssues, err, progPath);
  }
  // Loose + Tier-2-bound packs (lenient: a corrupt event file / unbound pack is
  // collected as a FileIssue, not thrown, so the rest of plan lint still runs).
  let packSources;
  try {
    packSources = await readPackSources(cwd, "lenient");
  } catch (err) {
    pushParseIssue(fileIssues, err, eventsDir(cwd));
    packSources = { looseFiles: [], packs: [], validatedPackFiles: [], issues: [] };
  }
  for (const issue of packSources.issues) {
    fileIssues.push({ code: issue.code, severity: "error", message: issue.message });
  }
  // Archived-task legacy conflict gate (lenient: collect as FileIssue + exclude
  // the offending legacy event from the merged stream so state stays reproducible).
  const { durableIds, archivedTaskIds, archivedEnumerationComplete } =
    await durableIdsAndArchivedTasks(cwd, packSources);
  const { mergeableLegacyEvents, issues: legacyIssues } = filterArchivedTaskLegacyConflicts(
    legacyEvents,
    durableIds,
    archivedTaskIds,
    "lenient",
    archivedEnumerationComplete,
  );
  for (const issue of legacyIssues) {
    fileIssues.push({ code: issue.code, severity: "error", message: issue.message });
  }
  const eventFiles: LoadedEventFile[] = [
    ...packSources.looseFiles,
    ...packSources.validatedPackFiles,
  ];
  if (hasLegacy || eventFiles.length > 0) {
    progress = {
      path: progPath,
      events: mergeProgressStreams(mergeableLegacyEvents, eventFiles),
    };
  }

  // design-docs-ephemeral (step 4b): discover UNREFERENCED archived phases. This is
  // the ONLY surface that reports discovery's soft `invalid[]` — as a WARNING with
  // `affects_exit: false`, so the advisory itself never fails `plan lint --strict`.
  // (doctor/validate do not emit the advisory.) Independent diagnostics still fire on
  // the consequences of a soft-invalid snapshot supplying no ids: TASK_DEPENDS_ON_UNRESOLVED
  // for a live dep, ORPHAN_PROGRESS_EVENT for a leftover event — those are NOT silenced.
  const discovered = await discoverUnreferencedSnapshots(
    cwd,
    new Set(roadmap.phases.map((r) => r.id)),
  );
  archivedCandidates.push(...discovered.entries);
  for (const inv of discovered.invalid) {
    fileIssues.push(unreferencedInvalidToFileIssue(inv));
  }

  const taskIndex = buildTaskIndex(phases);
  // Collision-checked merge (lenient: collision → FileIssue, colliding ids
  // excluded; never thrown, never a silencer).
  const merge = mergeArchivedTaskIndex(new Set(taskIndex.keys()), archivedCandidates);
  for (const c of merge.collisions) {
    fileIssues.push({
      code: "PHASE_SNAPSHOT_INVALID",
      severity: "error",
      message: `archive snapshot task id collides with the live plan: ${c.reason}`,
      file: c.phase_ids.map((id) => `design/phases (archived ${id})`).join(", "),
    });
  }

  const state: PlanState = {
    cwd,
    roadmapPath: rmPath,
    roadmap,
    phases,
    progress,
    taskIndex,
    archivedTaskIndex: merge.index,
  };

  return { state, archivedTaskIndex: merge.index, fallbackPhases: [], fileIssues, skippedChecks };
}

async function scanPhasesDirBestEffort(
  cwd: string,
  fileIssues: FileIssue[],
): Promise<PhaseEntry[]> {
  let entries: string[] = [];
  try {
    // Require an owned directory BEFORE enumerating it: no symlink alias may
    // turn the control-plane phase namespace into a view of another directory.
    const phasesDir = await resolveOwnedProjectPath(cwd, "design/phases");
    entries = await readdir(phasesDir);
  } catch {
    return [];
  }

  const phases: PhaseEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const relPath = `design/phases/${entry}`;
    let absPath: string;
    try {
      absPath = await resolveOwnedProjectPath(cwd, relPath);
    } catch (err) {
      pushParseIssue(fileIssues, err, relPath);
      continue;
    }
    try {
      const phase = await loadPlanStatePhase(absPath);
      // Without a roadmap, ref.id is unknown — fall back to the phase id
      // so downstream checks can still refer to the phase by id.
      phases.push({
        ref: { id: phase.id, path: relPath, weight: phase.weight },
        absPath,
        phase,
      });
    } catch (err) {
      pushParseIssue(fileIssues, err, relPath);
    }
  }
  return phases;
}
