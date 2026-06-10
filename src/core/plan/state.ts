import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadYaml, ParseError } from "../../io/load.ts";
import { Phase, type Phase as PhaseT } from "../schemas/phase.ts";
import {
  ProgressLog,
  type ProgressEvent,
} from "../schemas/progress-event.ts";
import { Roadmap, type PhaseRef, type Roadmap as RoadmapT } from "../schemas/roadmap.ts";
import type { Task as TaskT } from "../schemas/task.ts";
import { mergeProgressStreams, progressPath } from "../progress/io.ts";
import {
  eventsDir,
  type LoadedEventFile,
  readEventFiles,
} from "../progress/events-io.ts";
import type { FileIssue } from "./shared.ts";

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
};

export type LenientLoadResult = {
  /** Populated when the roadmap parsed successfully; null otherwise. */
  state: PlanState | null;
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
const PHASES_DIR_SEGMENTS = ["design", "phases"] as const;

function roadmapPath(cwd: string): string {
  return join(cwd, ...ROADMAP_REL_PATH);
}

function phasesDirPath(cwd: string): string {
  return join(cwd, ...PHASES_DIR_SEGMENTS);
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
  const rmPath = roadmapPath(cwd);
  const roadmap = await loadYaml(rmPath, Roadmap);

  const phases: PhaseEntry[] = [];
  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    const phase = await loadPlanStatePhase(absPath);
    phases.push({ ref, absPath, phase });
  }

  let progress: PlanState["progress"] = null;
  const progPath = progressPath(cwd);
  let legacyEvents: ProgressEvent[] = [];
  let hasLegacy = false;
  try {
    const raw = await readFile(progPath, "utf8");
    const parsed = ProgressLog.safeParse(parseYaml(raw) as unknown);
    if (!parsed.success) {
      throw new ParseError(progPath, parsed.error.issues);
    }
    legacyEvents = parsed.data.events;
    hasLegacy = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  // Merge the per-event ledger (strict: a corrupt event file propagates).
  const eventFiles = await readEventFiles(cwd);
  if (hasLegacy || eventFiles.length > 0) {
    progress = { path: progPath, events: mergeProgressStreams(legacyEvents, eventFiles) };
  }

  return {
    cwd,
    roadmapPath: rmPath,
    roadmap,
    phases,
    progress,
    taskIndex: buildTaskIndex(phases),
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
  const rmPath = roadmapPath(cwd);

  let roadmap: RoadmapT | null = null;
  try {
    roadmap = await loadYaml(rmPath, Roadmap);
  } catch (err) {
    pushParseIssue(fileIssues, err, rmPath);
    skippedChecks.push(
      "MISSING_PHASE_FILE",
      "ORPHAN_PHASE_FILE",
      "PHASE_ID_MISMATCH",
    );
  }

  if (!roadmap) {
    // Roadmap is unparseable. Scan design/phases/ directly so we can
    // still report duplicate-id / naming issues on parseable files.
    const fallback = await scanPhasesDirBestEffort(cwd, fileIssues);
    return { state: null, fallbackPhases: fallback, fileIssues, skippedChecks };
  }

  const phases: PhaseEntry[] = [];
  for (const ref of roadmap.phases) {
    const absPath = join(cwd, ref.path);
    try {
      const phase = await loadPlanStatePhase(absPath);
      phases.push({ ref, absPath, phase });
    } catch (err) {
      pushParseIssue(fileIssues, err, ref.path);
    }
  }

  let progress: PlanState["progress"] = null;
  const progPath = progressPath(cwd);
  let legacyEvents: ProgressEvent[] = [];
  let hasLegacy = false;
  try {
    const raw = await readFile(progPath, "utf8");
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
  // Merge the per-event ledger (lenient: a corrupt event file is collected, not
  // thrown, so the rest of plan lint still runs).
  let eventFiles: LoadedEventFile[] = [];
  try {
    eventFiles = await readEventFiles(cwd);
  } catch (err) {
    pushParseIssue(fileIssues, err, eventsDir(cwd));
  }
  if (hasLegacy || eventFiles.length > 0) {
    progress = { path: progPath, events: mergeProgressStreams(legacyEvents, eventFiles) };
  }

  const state: PlanState = {
    cwd,
    roadmapPath: rmPath,
    roadmap,
    phases,
    progress,
    taskIndex: buildTaskIndex(phases),
  };

  return { state, fallbackPhases: [], fileIssues, skippedChecks };
}

async function scanPhasesDirBestEffort(
  cwd: string,
  fileIssues: FileIssue[],
): Promise<PhaseEntry[]> {
  const phasesDir = phasesDirPath(cwd);
  let entries: string[] = [];
  try {
    entries = await readdir(phasesDir);
  } catch {
    return [];
  }

  const phases: PhaseEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const absPath = join(phasesDir, entry);
    const relPath = `design/phases/${entry}`;
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
