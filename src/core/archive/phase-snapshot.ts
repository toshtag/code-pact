import { readFile } from "node:fs/promises";
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
import { loadMergedProgress } from "../progress/io.ts";
import { readPackSources } from "../progress/all-sources.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { computeEventId } from "../progress/event-id.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { atomicWriteText, type ExpectedState } from "../../io/atomic-text.ts";
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
//                                                  (read-only; NEVER regenerated)
//   live file missing + record missing          → ineligible (live_file_missing)
// There is no generic --force. A missing roadmap.yaml is NOT an archived state
// — it is a missing ACTIVE control doc and fails closed (the load throws).
//
// Trust boundaries:
//   - An existing record must match the requested identity (phase_id, its own
//     path_sha256, and — when the live roadmap ref exists — the ref's path)
//     before it is trusted for ANY verdict, including the no-ops. Mismatch
//     fails closed (`record_identity_mismatch`), never silently overwrites.
//   - Every phase YAML read (target AND the dependant scan) goes through
//     `resolveWithinProject`, so a symlink escaping the project can never feed
//     a control record.
//   - The apply step passes the plan's observed destination state to
//     `atomicWriteText` as `ExpectedState` (absent for write, the exact raw
//     bytes for refresh) — a record created/changed by a concurrent writer
//     between plan and rename is refused, not overwritten.
// ---------------------------------------------------------------------------

export type PhaseSnapshotBlock =
  | { kind: "record_invalid"; detail: string }
  | { kind: "record_identity_mismatch"; detail: string }
  | {
      kind: "phase_id_mismatch";
      requested_phase_id: string;
      roadmap_phase_id: string;
      yaml_phase_id: string;
      path: string;
    }
  | {
      kind: "duplicate_task_id";
      task_id: string;
      first_phase_id: string;
      first_path: string;
      second_phase_id: string;
      second_path: string;
    }
  | { kind: "unsafe_path"; original_path: string }
  | { kind: "phase_not_terminal"; status: string }
  | { kind: "task_not_terminal"; task_id: string; status: string }
  | { kind: "task_done_without_done_event"; task_id: string }
  | { kind: "legacy_only_terminal_evidence"; task_id: string }
  | {
      kind: "task_done_progress_state_drift";
      task_id: string;
      yaml_status: "done";
      derived_status: string;
      last_event_status: string;
    }
  | { kind: "cancelled_task_with_done_event"; task_id: string }
  | { kind: "attestation_not_applicable"; task_id: string; detail: string }
  | {
      kind: "active_dependant_on_non_done_task";
      dependant_task_id: string;
      dependant_phase_id: string;
      depends_on_task_id: string;
    }
  | { kind: "record_stale"; existing_source_sha256: string; current_source_sha256: string }
  | { kind: "record_inputs_changed"; detail: string }
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
      /** Exact raw bytes of the record being replaced — the apply-time ExpectedState. */
      existing_raw: string;
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

/** Symlink-escape-guarded raw read of a project-relative path. */
async function readRawWithin(cwd: string, relPath: string): Promise<string> {
  const abs = await resolveWithinProject(cwd, relPath);
  return readFile(abs, "utf8");
}

async function readExistingRecord(
  path: string,
): Promise<
  | { state: "missing" }
  | { state: "invalid"; detail: string }
  | { state: "present"; record: PhaseSnapshot; raw: string }
> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isEnoent(err)) return { state: "missing" };
    throw err;
  }
  try {
    return { state: "present", record: PhaseSnapshot.parse(JSON.parse(raw)), raw };
  } catch (err) {
    // Fail closed: an unreadable/invalid record silences nothing and is never
    // silently overwritten — surface it instead.
    return { state: "invalid", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * An existing record is trusted for NO verdict (not even a no-op) until it
 * matches the requested identity: it must be the record FOR this phase id, and
 * its own path_sha256 must cover its own original_path.
 */
function recordIdentityMismatch(record: PhaseSnapshot, phaseId: string): string | null {
  if (record.phase_id !== phaseId) {
    return `record at the ${phaseId} path is for phase "${record.phase_id}"`;
  }
  if (record.path_sha256 !== sha256Hex(record.original_path)) {
    return `record path_sha256 does not cover its own original_path "${record.original_path}"`;
  }
  return null;
}

/**
 * State equality between two records, ignoring provenance-only stamps:
 * `snapshotted_at`, `git_ref`, and (inside a `maintainer_attestation`) its
 * `recorded_at` — all of which are when-this-was-recorded, not what-the-state-is
 * (the attestation `reason` IS state and is kept). Everything else — phase_id,
 * phase_name, original_path, phase_status, weight, source_sha256, path_sha256,
 * and the full task list incl. terminal_evidence kind + depends_on — is
 * compared. Canonical JSON of the schema-validated objects is sufficient: the
 * strict schema fixes the key set and `parse()` emits keys in schema order, and
 * the writer always builds tasks in YAML order.
 */
function semanticProjection(r: PhaseSnapshot): unknown {
  const { snapshotted_at: _at, git_ref: _ref, tasks, ...rest } = r;
  return {
    ...rest,
    tasks: tasks.map((t) => {
      const ev =
        t.terminal_evidence.kind === "maintainer_attestation"
          ? { kind: t.terminal_evidence.kind, reason: t.terminal_evidence.reason }
          : t.terminal_evidence;
      return {
        id: t.id,
        status: t.status,
        depends_on: t.depends_on ?? null,
        terminal_evidence: ev,
      };
    }),
  };
}

function semanticEqual(a: PhaseSnapshot, b: PhaseSnapshot): boolean {
  return JSON.stringify(semanticProjection(a)) === JSON.stringify(semanticProjection(b));
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
  if (existing.state === "present") {
    const mismatch = recordIdentityMismatch(existing.record, phaseId);
    if (mismatch !== null) {
      return {
        kind: "ineligible",
        path,
        blocks: [{ kind: "record_identity_mismatch", detail: mismatch }],
      };
    }
  }

  // A missing roadmap.yaml is a missing ACTIVE control doc — fail closed (this
  // throws), never "already archived".
  const roadmap = await loadRoadmap(cwd);

  let ref;
  try {
    ref = resolvePhaseRef(roadmap, phaseId);
  } catch (err) {
    if (isPhaseNotFound(err) && existing.state === "present") {
      // Phase no longer in the roadmap + an identity-verified record: archived
      // state, read-only.
      return { kind: "noop_record_authoritative", path };
    }
    throw err; // PHASE_NOT_FOUND without a record, or AMBIGUOUS_PHASE_ID: fail closed.
  }

  if (existing.state === "present" && existing.record.original_path !== ref.path) {
    return {
      kind: "ineligible",
      path,
      blocks: [
        {
          kind: "record_identity_mismatch",
          detail: `record original_path "${existing.record.original_path}" does not match the roadmap ref path "${ref.path}"`,
        },
      ],
    };
  }

  let rawPhase: string;
  try {
    rawPhase = await readRawWithin(cwd, ref.path);
  } catch (err) {
    if (isEnoent(err)) {
      if (existing.state === "present") return { kind: "noop_record_authoritative", path };
      return {
        kind: "ineligible",
        path,
        blocks: [{ kind: "live_file_missing", original_path: ref.path }],
      };
    }
    // Structural failure or symlink escape: never snapshot through it.
    return { kind: "ineligible", path, blocks: [{ kind: "unsafe_path", original_path: ref.path }] };
  }
  const currentSha = sha256Hex(rawPhase);
  // NOTE: a matching source_sha256 is NOT an early exit. source_sha256 hashes
  // the phase YAML ALONE; the record also derives from progress events, the
  // other active phases (duplicate-id / dependant scans), and roadmap metadata
  // (weight). Those can drift while the YAML is byte-identical, so every check
  // below runs unconditionally; the no-op verdict is decided last, by a
  // semantic comparison of the freshly-built candidate record against the
  // existing one (snapshotted_at / git_ref excluded).

  const phase = Phase.parse(parseYaml(rawPhase) as unknown);
  const blocks: PhaseSnapshotBlock[] = [];

  // Identity at the source: the record path is keyed by the REQUESTED id, the
  // record body by the YAML's id — they must be the same phase, ref included.
  // A roadmap/YAML id divergence is a broken active control plane; this writer
  // creates records future readers will trust, so it fails closed itself
  // rather than relying on doctor/lint's PHASE_ID_MISMATCH having run.
  if (phase.id !== ref.id || phase.id !== phaseId) {
    return {
      kind: "ineligible",
      path,
      blocks: [
        {
          kind: "phase_id_mismatch",
          requested_phase_id: phaseId,
          roadmap_phase_id: ref.id,
          yaml_phase_id: phase.id,
          path: ref.path,
        },
      ],
    };
  }

  const terminalStatus =
    phase.status === "done" || phase.status === "cancelled" ? phase.status : null;
  if (terminalStatus === null) {
    blocks.push({ kind: "phase_not_terminal", status: phase.status });
  }

  // Load every active phase once (id-verified), in roadmap order — shared by
  // the duplicate-task-id scan and the active-dependant scan below. An
  // id-diverged active control doc is never scanned (its verdicts could not be
  // trusted).
  const activePhases: { refId: string; refPath: string; phase: Phase }[] = [];
  for (const otherRef of roadmap.phases) {
    const otherPhase =
      otherRef.id === ref.id
        ? phase
        : Phase.parse(parseYaml(await readRawWithin(cwd, otherRef.path)) as unknown);
    if (otherPhase.id !== otherRef.id) {
      blocks.push({
        kind: "phase_id_mismatch",
        requested_phase_id: phaseId,
        roadmap_phase_id: otherRef.id,
        yaml_phase_id: otherPhase.id,
        path: otherRef.path,
      });
      continue;
    }
    activePhases.push({ refId: otherRef.id, refPath: otherRef.path, phase: otherPhase });
  }

  // Task-id uniqueness across the WHOLE active graph. Progress events bind by
  // task_id alone, so a duplicate makes every event-derived evidence ambiguous
  // — which task does that done event prove? A snapshot is a future authority;
  // it must not be minted from a graph where evidence is ambiguous, whether or
  // not the duplicate touches this phase. The writer fails closed itself (the
  // phase_id_mismatch rationale): never assume lint/doctor's DUPLICATE_TASK_ID
  // ran first.
  {
    const seen = new Map<string, { phase_id: string; path: string }>();
    for (const entry of activePhases) {
      for (const t of entry.phase.tasks ?? []) {
        const first = seen.get(t.id);
        if (first) {
          blocks.push({
            kind: "duplicate_task_id",
            task_id: t.id,
            first_phase_id: first.phase_id,
            first_path: first.path,
            second_phase_id: entry.refId,
            second_path: entry.refPath,
          });
        } else {
          seen.set(t.id, { phase_id: entry.refId, path: entry.refPath });
        }
      }
    }
  }

  // The producer mints terminal_evidence from DURABLE sources only — loose event
  // files ∪ Tier-2-validated event packs — the SAME set the validator resolves
  // against. Minting an id only the merged-with-legacy view can see would break
  // evidence the instant the snapshot is written (the validator excludes legacy).
  // `mergedEvents` (= durable ∪ legacy) is kept ONLY to detect a done event that
  // exists in legacy alone, so that case blocks with a clear "run migrate" hint.
  const progress = await loadMergedProgress(cwd);
  const mergedEvents = progress.log.events;
  const packSources = await readPackSources(cwd, "strict");
  const durableEvents = [
    ...packSources.looseFiles.map((f) => f.event),
    ...packSources.validatedPackFiles.map((f) => f.event),
  ];
  const attestations = opts.attestations ?? {};
  const claimedAttestations = new Set(Object.keys(attestations));
  const tasks: SnapshotTask[] = [];
  const cancelledTaskIds = new Set<string>();

  for (const task of phase.tasks ?? []) {
    if (task.status === "cancelled") {
      cancelledTaskIds.add(task.id);
      // Status drift: a cancelled task whose derived progress state is `done`
      // would make the snapshot contradict the event-derived dependency
      // satisfaction readers rely on. Refuse to freeze a contradiction.
      if (deriveTaskState(durableEvents, task.id).current === "done") {
        blocks.push({ kind: "cancelled_task_with_done_event", task_id: task.id });
      }
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
    // Evidence is derived from DURABLE events only (loose ∪ pack) — never legacy.
    const taskEvents = durableEvents.filter((e) => e.task_id === task.id);
    const derived = deriveTaskState(durableEvents, task.id).current;
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
      const eventIds = taskEvents
        .filter((e) => e.status === "done")
        .map((e) => computeEventId(e));
      evidence = { kind: "progress_events", event_ids: eventIds };
    } else if (taskEvents.length > 0) {
      // Durable history exists and it does NOT say done: a drift between the
      // design YAML and the event-derived truth. An attestation is the rescue for
      // ABSENT history — never a license to overrule recorded events. Refuse.
      claimedAttestations.delete(task.id);
      blocks.push({
        kind: "task_done_progress_state_drift",
        task_id: task.id,
        yaml_status: "done",
        derived_status: derived,
        last_event_status: taskEvents[taskEvents.length - 1]!.status,
      });
      continue;
    } else if (deriveTaskState(mergedEvents, task.id).current === "done") {
      // No DURABLE history, but the legacy monolith alone says done. Minting a
      // legacy-derived event_id would dangle the instant the snapshot is written
      // (the validator never reads legacy). Block with the migrate hint rather
      // than forge durable evidence or silently attest.
      claimedAttestations.delete(task.id);
      blocks.push({ kind: "legacy_only_terminal_evidence", task_id: task.id });
      continue;
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
  // permanently-unsatisfiable dependency instead of surfacing it. Reuses the
  // id-verified activePhases set loaded above.
  if (cancelledTaskIds.size > 0) {
    for (const entry of activePhases) {
      for (const otherTask of entry.phase.tasks ?? []) {
        if (otherTask.status === "done" || otherTask.status === "cancelled") continue;
        for (const dep of otherTask.depends_on ?? []) {
          if (cancelledTaskIds.has(dep)) {
            blocks.push({
              kind: "active_dependant_on_non_done_task",
              dependant_task_id: otherTask.id,
              dependant_phase_id: entry.phase.id,
              depends_on_task_id: dep,
            });
          }
        }
      }
    }
  }

  // The phase YAML body changed under an existing record: that is a stale
  // record (default fail; explicit refresh with both source hashes only). This
  // is distinct from the body-identical / inputs-changed case decided below.
  if (existing.state === "present" && existing.record.source_sha256 !== currentSha) {
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
    // Body-identical (source_sha256 matched) AND every eligibility check above
    // passed. Decide no-op vs inputs-changed by SEMANTIC comparison of the
    // freshly-built candidate against the existing record — source_sha256 alone
    // would miss a drift in weight / tasks / terminal_evidence / depends_on
    // (the inputs outside the YAML hash). snapshotted_at / git_ref are excluded
    // (provenance, not state).
    if (existing.record.source_sha256 === currentSha) {
      if (semanticEqual(existing.record, record)) {
        return { kind: "noop_same_source", path };
      }
      if (!opts.refresh) {
        return {
          kind: "ineligible",
          path,
          blocks: [
            {
              kind: "record_inputs_changed",
              detail:
                "the phase YAML is unchanged but an out-of-YAML input drifted (weight / tasks / terminal_evidence / depends_on) — refresh explicitly to re-record",
            },
          ],
        };
      }
      // Explicit refresh of an inputs-changed record: the YAML hash is the same
      // old==new, so require the refresh to name it for both.
      if (
        opts.refresh.expected_old_source_sha256 !== existing.record.source_sha256 ||
        opts.refresh.expected_new_source_sha256 !== currentSha
      ) {
        return {
          kind: "ineligible",
          path,
          blocks: [
            {
              kind: "refresh_expectation_mismatch",
              expected_old_source_sha256: opts.refresh.expected_old_source_sha256,
              existing_source_sha256: existing.record.source_sha256,
              expected_new_source_sha256: opts.refresh.expected_new_source_sha256,
              current_source_sha256: currentSha,
            },
          ],
        };
      }
    }
    return {
      kind: "refresh",
      path,
      record,
      existing_source_sha256: existing.record.source_sha256,
      current_source_sha256: currentSha,
      existing_raw: existing.raw,
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
 * Apply a `write` / `refresh` plan. The destination state the plan observed is
 * handed to `atomicWriteText` as its pre-rename ExpectedState: `absent` for a
 * fresh write, the exact existing raw bytes for a refresh — so a concurrent
 * writer that created or changed the record after the plan makes this THROW
 * instead of overwriting. Non-mutating plans pass through unchanged.
 */
export async function applyPhaseSnapshotPlan(
  plan: PhaseSnapshotPlan,
): Promise<PhaseSnapshotWriteOutcome> {
  if (plan.kind === "write" || plan.kind === "refresh") {
    const expected: ExpectedState =
      plan.kind === "write"
        ? { kind: "absent" }
        : { kind: "present", content: plan.existing_raw };
    await atomicWriteText(plan.path, serializePhaseSnapshot(plan.record), expected);
    return { kind: "written", path: plan.path, record: plan.record };
  }
  return plan;
}

/**
 * Re-plans internally (the verdict is rebuilt at write time, decision-prune
 * style — a stale earlier plan can never authorize a write) and applies under
 * the plan's ExpectedState guard.
 */
export async function writePhaseSnapshot(
  cwd: string,
  phaseId: string,
  opts: PhaseSnapshotOptions,
): Promise<PhaseSnapshotWriteOutcome> {
  return applyPhaseSnapshotPlan(await planPhaseSnapshot(cwd, phaseId, opts));
}
