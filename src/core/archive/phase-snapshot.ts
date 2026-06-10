import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Phase } from "../schemas/phase.ts";
import {
  PhaseSnapshot,
  PHASE_SNAPSHOT_SCHEMA_VERSION,
  type SnapshotTask,
  type TerminalEvidence,
} from "../schemas/phase-snapshot.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import { resolvePhaseRef } from "../plan/resolve-phase.ts";
import { loadPhase } from "../plan/load-phase.ts";
import { loadMergedProgress } from "../progress/io.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { computeEventId } from "../progress/event-id.ts";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { phaseSnapshotPath, sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// Phase snapshot writer (record layer — NO CLI, NO reader changes).
//
// Pure `.code-pact/state` writes: this module never deletes a design file,
// never edits the roadmap, never rewrites a doc link. Writing a snapshot does
// NOT make hand deletion safe until the reader layers land — the record exists
// so those later layers have an authority to resolve against.
//
// LIVE DESIGN FILE WINS: while the phase YAML exists it is the truth; the
// record is fallback authority only once the file is gone. Hence the locked
// idempotency/staleness table (pinned by the unit tests):
//   no record + live file + eligible            → write
//   record    + same source_sha256              → noop_same_source
//   record    + different source_sha256         → ineligible (record_stale)
//   record    + different sha + explicit refresh
//     (expected old AND new hashes both match)  → refresh (rewrite from live)
//   live file missing + record exists           → noop_record_authoritative
//                                                  (read-only; NEVER regenerate)
//   live file missing + record missing          → ineligible (live_file_missing)
// There is no generic --force.
// ---------------------------------------------------------------------------

export type PhaseSnapshotBlock =
  | { kind: "record_invalid"; detail: string }
  | { kind: "phase_not_terminal"; status: string }
  | { kind: "task_not_terminal"; task_id: string; status: string }
  | { kind: "task_done_without_done_event"; task_id: string }
  | { kind: "attestation_not_applicable"; task_id: string; detail: string }
  | {
      kind: "active_dependant_on_non_done_task";
      dependant_task_id: string;
      dependant_phase_id: string;
      depends_on_task_id: string;
    }
  | { kind: "record_stale"; existing_source_sha256: string; current_source_sha256: string }
  | {
      kind: "refresh_expectation_mismatch";
      expected_old_source_sha256: string;
      existing_source_sha256: string;
      expected_new_source_sha256: string;
      current_source_sha256: string;
    }
  | { kind: "live_file_missing"; original_path: string };

export type PhaseSnapshotPlan =
  | { kind: "write"; path: string; record: PhaseSnapshot }
  | {
      kind: "refresh";
      path: string;
      record: PhaseSnapshot;
      existing_source_sha256: string;
      current_source_sha256: string;
    }
  | { kind: "noop_same_source"; path: string }
  | { kind: "noop_record_authoritative"; path: string }
  | { kind: "ineligible"; path: string; blocks: PhaseSnapshotBlock[] };

export type PhaseSnapshotOptions = {
  /** Timestamp source — explicit so plans/records are deterministic in tests. */
  now: Date;
  /**
   * Explicit, reasoned overrides for done tasks whose derived progress state is
   * not `done` (legacy phases with missing events). Never silent: each entry
   * becomes an auditable `maintainer_attestation` evidence. An attestation for
   * a task that does not need one is a block, not a no-op.
   */
  attestations?: Record<string, { reason: string }>;
  /**
   * Explicit refresh mode for a stale record. Both hashes must match reality
   * (the existing record's source_sha256 and the live file's current hash) or
   * the plan fails — no generic force.
   */
  refresh?: {
    expected_old_source_sha256: string;
    expected_new_source_sha256: string;
  };
  /** Optional provenance ref (e.g. a commit sha) recorded verbatim. */
  git_ref?: string;
};

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isPhaseNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "PHASE_NOT_FOUND";
}

async function readExistingRecord(
  path: string,
): Promise<{ state: "missing" } | { state: "invalid"; detail: string } | { state: "present"; record: PhaseSnapshot }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { state: "missing" };
    throw err;
  }
  try {
    return { state: "present", record: PhaseSnapshot.parse(JSON.parse(raw)) };
  } catch (err) {
    // Fail closed: an unreadable/invalid record silences nothing and is never
    // silently overwritten — surface it instead.
    return { state: "invalid", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function planPhaseSnapshot(
  cwd: string,
  phaseId: string,
  opts: PhaseSnapshotOptions,
): Promise<PhaseSnapshotPlan> {
  const path = phaseSnapshotPath(cwd, phaseId);
  const existing = await readExistingRecord(path);
  if (existing.state === "invalid") {
    return { kind: "ineligible", path, blocks: [{ kind: "record_invalid", detail: existing.detail }] };
  }

  // Resolve the live phase. A phase absent from the roadmap with a valid record
  // is already-archived state: read-only, never regenerated.
  const roadmap = await (async () => {
    try {
      return await loadRoadmap(cwd);
    } catch (err) {
      if (isEnoent(err) && existing.state === "present") return null;
      throw err;
    }
  })();
  if (roadmap === null) return { kind: "noop_record_authoritative", path };

  let ref;
  try {
    ref = resolvePhaseRef(roadmap, phaseId);
  } catch (err) {
    if (isPhaseNotFound(err) && existing.state === "present") {
      return { kind: "noop_record_authoritative", path };
    }
    throw err; // PHASE_NOT_FOUND without a record, or AMBIGUOUS_PHASE_ID: fail closed.
  }

  let rawPhase: string;
  try {
    rawPhase = await readFile(join(cwd, ref.path), "utf8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
    if (existing.state === "present") return { kind: "noop_record_authoritative", path };
    return {
      kind: "ineligible",
      path,
      blocks: [{ kind: "live_file_missing", original_path: ref.path }],
    };
  }
  const currentSha = sha256Hex(rawPhase);

  if (existing.state === "present" && existing.record.source_sha256 === currentSha) {
    return { kind: "noop_same_source", path };
  }

  const phase = Phase.parse(parseYaml(rawPhase) as unknown);
  const blocks: PhaseSnapshotBlock[] = [];

  const terminalStatus =
    phase.status === "done" || phase.status === "cancelled" ? phase.status : null;
  if (terminalStatus === null) {
    blocks.push({ kind: "phase_not_terminal", status: phase.status });
  }

  const progress = await loadMergedProgress(cwd);
  const attestations = opts.attestations ?? {};
  const claimedAttestations = new Set(Object.keys(attestations));
  const tasks: SnapshotTask[] = [];
  const cancelledTaskIds = new Set<string>();

  for (const task of phase.tasks ?? []) {
    if (task.status === "cancelled") {
      cancelledTaskIds.add(task.id);
      if (claimedAttestations.has(task.id)) {
        blocks.push({
          kind: "attestation_not_applicable",
          task_id: task.id,
          detail: "cancelled tasks always use design_status evidence — an attestation would misstate the provenance",
        });
      }
      claimedAttestations.delete(task.id);
      tasks.push({
        id: task.id,
        status: "cancelled",
        ...(task.depends_on && task.depends_on.length > 0 ? { depends_on: task.depends_on } : {}),
        terminal_evidence: {
          kind: "design_status",
          observed_status: "cancelled",
          source_field: "tasks[].status",
        },
      });
      continue;
    }
    if (task.status !== "done") {
      blocks.push({ kind: "task_not_terminal", task_id: task.id, status: task.status });
      continue;
    }
    const derived = deriveTaskState(progress.log.events, task.id).current;
    let evidence: TerminalEvidence;
    if (derived === "done") {
      if (claimedAttestations.has(task.id)) {
        blocks.push({
          kind: "attestation_not_applicable",
          task_id: task.id,
          detail: "the task's done state is already proven by progress events",
        });
      }
      claimedAttestations.delete(task.id);
      const eventIds = progress.log.events
        .filter((e) => e.task_id === task.id && e.status === "done")
        .map((e) => computeEventId(e));
      evidence = { kind: "progress_events", event_ids: eventIds };
    } else if (attestations[task.id]) {
      claimedAttestations.delete(task.id);
      evidence = {
        kind: "maintainer_attestation",
        recorded_at: opts.now.toISOString(),
        reason: attestations[task.id]!.reason,
      };
    } else {
      blocks.push({ kind: "task_done_without_done_event", task_id: task.id });
      continue;
    }
    tasks.push({
      id: task.id,
      status: "done",
      ...(task.depends_on && task.depends_on.length > 0 ? { depends_on: task.depends_on } : {}),
      terminal_evidence: evidence,
    });
  }

  for (const taskId of claimedAttestations) {
    blocks.push({
      kind: "attestation_not_applicable",
      task_id: taskId,
      detail: "no such done task in this phase needs an attestation",
    });
  }

  // No active, unresolved task anywhere in the plan may depend on a task of
  // this phase whose terminal status is not done — archiving would bury a
  // permanently-unsatisfiable dependency instead of surfacing it.
  if (cancelledTaskIds.size > 0) {
    for (const otherRef of roadmap.phases) {
      const otherPhase =
        otherRef.id === ref.id ? phase : await loadPhase(cwd, otherRef.path);
      for (const otherTask of otherPhase.tasks ?? []) {
        if (otherTask.status === "done" || otherTask.status === "cancelled") continue;
        for (const dep of otherTask.depends_on ?? []) {
          if (cancelledTaskIds.has(dep)) {
            blocks.push({
              kind: "active_dependant_on_non_done_task",
              dependant_task_id: otherTask.id,
              dependant_phase_id: otherPhase.id,
              depends_on_task_id: dep,
            });
          }
        }
      }
    }
  }

  if (existing.state === "present") {
    // Stale record: default fail; rewrite only under explicit refresh with both
    // hashes matching reality.
    if (!opts.refresh) {
      blocks.push({
        kind: "record_stale",
        existing_source_sha256: existing.record.source_sha256,
        current_source_sha256: currentSha,
      });
    } else if (
      opts.refresh.expected_old_source_sha256 !== existing.record.source_sha256 ||
      opts.refresh.expected_new_source_sha256 !== currentSha
    ) {
      blocks.push({
        kind: "refresh_expectation_mismatch",
        expected_old_source_sha256: opts.refresh.expected_old_source_sha256,
        existing_source_sha256: existing.record.source_sha256,
        expected_new_source_sha256: opts.refresh.expected_new_source_sha256,
        current_source_sha256: currentSha,
      });
    }
  }

  if (blocks.length > 0) return { kind: "ineligible", path, blocks };

  const record = PhaseSnapshot.parse({
    schema_version: PHASE_SNAPSHOT_SCHEMA_VERSION,
    phase_id: phase.id,
    phase_name: phase.name,
    original_path: ref.path,
    phase_status: terminalStatus!, // blocks.length===0 guarantees terminal here
    weight: ref.weight,
    snapshotted_at: opts.now.toISOString(),
    source_sha256: currentSha,
    path_sha256: sha256Hex(ref.path),
    ...(opts.git_ref ? { git_ref: opts.git_ref } : {}),
    tasks,
  } satisfies PhaseSnapshot);

  if (existing.state === "present") {
    return {
      kind: "refresh",
      path,
      record,
      existing_source_sha256: existing.record.source_sha256,
      current_source_sha256: currentSha,
    };
  }
  return { kind: "write", path, record };
}

export type PhaseSnapshotWriteOutcome =
  | { kind: "written"; path: string; record: PhaseSnapshot }
  | { kind: "noop_same_source"; path: string }
  | { kind: "noop_record_authoritative"; path: string }
  | { kind: "ineligible"; path: string; blocks: PhaseSnapshotBlock[] };

export function serializePhaseSnapshot(record: PhaseSnapshot): string {
  return JSON.stringify(record, null, 2) + "\n";
}

/**
 * Re-plans internally (the verdict is rebuilt at write time, decision-prune
 * style — a stale earlier plan can never authorize a write) and applies only
 * `write` / `refresh` plans via an atomic write.
 */
export async function writePhaseSnapshot(
  cwd: string,
  phaseId: string,
  opts: PhaseSnapshotOptions,
): Promise<PhaseSnapshotWriteOutcome> {
  const plan = await planPhaseSnapshot(cwd, phaseId, opts);
  if (plan.kind === "write" || plan.kind === "refresh") {
    await atomicWriteText(plan.path, serializePhaseSnapshot(plan.record));
    return { kind: "written", path: plan.path, record: plan.record };
  }
  return plan;
}
