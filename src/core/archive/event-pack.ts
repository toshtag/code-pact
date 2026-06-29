import { readFile, lstat, readdir } from "../project-fs/index.ts";
import { parse as parseYaml } from "yaml";
import {
  EventPack,
  EVENT_PACK_SCHEMA_VERSION,
  type PackedEvent,
} from "../schemas/event-pack.ts";
import { Phase } from "../schemas/phase.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { LoadedEventFile } from "../progress/events-io.ts";
import { atCompact } from "../progress/event-id.ts";
import { assertSafePlanId } from "../schemas/plan-id.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import { resolvePhaseRef } from "../plan/resolve-phase.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import { readPackSources } from "../progress/all-sources.ts";
import { resolvePhaseSnapshotRaw } from "./load-phase-snapshot.ts";
import {
  validateSnapshotEventEvidenceForSnapshot,
  type SnapshotEvidenceIssue,
} from "./snapshot-evidence.ts";
import {
  validateEventPackTier1,
  computeEventIdsSha256,
  resolveEventPackRaw,
  type LoadedEventPack,
} from "./event-pack-reader.ts";
import {
  bindPackToSnapshot,
  type EventPackBindingIssue,
} from "./event-pack-binding.ts";
import {
  classifyLoosePackRelationship,
  type CoveredLooseRelationship,
} from "./event-pack-cleanup.ts";
import {
  eventPackRelPath,
  resolveArchiveOwnedPath,
  sha256Hex,
} from "./paths.ts";
import { atomicWriteText } from "../../io/atomic-text.ts";

// ---------------------------------------------------------------------------
// Event pack WRITER (Layer 2) — plan + apply. Writes the pack and readback-
// verifies it. Does NOT delete loose event files (that is Layer 3). After a
// `write` apply, the pack is on disk AND the loose files REMAIN, so the result
// is `packed` / `already_packed` with `cleanup_pending`, never "compacted".
//
// Mirrors phase-snapshot.ts's plan/apply split: `planEventPack` is a pure
// verdict (no writes); `applyEventPackPlan` re-plans inside the lock, writes via
// `atomicWriteText` with `{kind:"absent"}` ExpectedState (a concurrent create is
// fail-closed), then readback-verifies through the SAME Layer-1 reader + binding
// the runtime uses — the writer never trusts its own in-memory pack.
// ---------------------------------------------------------------------------

export type EventPackBlock =
  | { kind: "phase_file_still_present"; phase_path: string }
  | { kind: "ambiguous_phase_id"; phase_paths: string[] }
  | { kind: "phase_discovery_incomplete"; detail: string }
  | { kind: "snapshot_missing" }
  | { kind: "snapshot_invalid"; detail: string }
  | { kind: "snapshot_evidence_broken"; issues: SnapshotEvidenceIssue[] }
  | {
      kind: "pack_stale";
      existing_event_ids_sha256: string;
      expected_event_ids_sha256: string;
    }
  | { kind: "pack_invalid"; detail: string }
  | { kind: "candidate_bind_failed"; binding_issues: EventPackBindingIssue[] };

export type EventPackPlan =
  | {
      kind: "write";
      phaseId: string;
      packPath: string;
      pack: EventPack;
      /** Count of loose files for the phase's tasks (for loose_remaining_count).
       *  The snapshot, its raw bytes, and the per-id loose map are NOT carried on
       *  the plan: `applyEventPackPlan` re-runs `planEventPack` inside the lock and
       *  re-reads all of them from disk at verify time, so a plan-time copy would
       *  be stale by the time it was used. */
      loose_count: number;
    }
  | {
      kind: "noop_already_packed";
      phaseId: string;
      packPath: string;
      loose_remaining_count: number;
      cleanup_pending: boolean;
      /** Which loose↔pack relationship this verdict reflects — `empty` (fully
       *  compacted), `equal` (pack matches loose exactly), or `strict_subset` (a
       *  resumable partial cleanup: every remaining loose id is in the pack but some
       *  loose files were already removed). Lets Layer 3 pick resume-vs-finish, and
       *  un-sticks a `strict_subset` phase that Layer 2 mis-reported as `pack_stale`. */
      loose_relationship: CoveredLooseRelationship;
    }
  | { kind: "noop_no_events"; phaseId: string }
  | { kind: "ineligible"; phaseId: string; block: EventPackBlock };

export type EventPackApplyOutcome =
  | {
      kind: "written";
      phaseId: string;
      packPath: string;
      pack: EventPack;
      loose_count: number;
    }
  | {
      kind: "noop_already_packed";
      phaseId: string;
      packPath: string;
      loose_remaining_count: number;
      cleanup_pending: boolean;
      /** Which loose↔pack relationship this verdict reflects — `empty` (fully
       *  compacted), `equal` (pack matches loose exactly), or `strict_subset` (a
       *  resumable partial cleanup: every remaining loose id is in the pack but some
       *  loose files were already removed). Lets Layer 3 pick resume-vs-finish, and
       *  un-sticks a `strict_subset` phase that Layer 2 mis-reported as `pack_stale`. */
      loose_relationship: CoveredLooseRelationship;
    }
  | { kind: "noop_no_events"; phaseId: string }
  | { kind: "ineligible"; phaseId: string; block: EventPackBlock };

/** A pack write/verify failure. `verify_pack` + partial_applied means the pack
 *  is on disk but failed readback — Layer 2 does NOT delete it (no unlink). */
export class EventPackWriteError extends Error {
  readonly phase: "write_pack" | "verify_pack";
  readonly partial_applied: boolean;
  readonly detail: string;
  constructor(
    phase: "write_pack" | "verify_pack",
    partial_applied: boolean,
    detail: string,
  ) {
    super(
      `event pack ${phase} failed (partial_applied=${partial_applied}): ${detail}`,
    );
    this.name = "EventPackWriteError";
    this.phase = phase;
    this.partial_applied = partial_applied;
    this.detail = detail;
  }
}

/** Test seam to inject failures deterministically (mirrors ApplyPruneHooks). */
export type ApplyEventPackHooks = {
  beforeWrite?: () => Promise<void>;
  beforeVerify?: () => Promise<void>;
};

export function serializeEventPack(pack: EventPack): string {
  return JSON.stringify(pack, null, 2) + "\n";
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Sort loose files by (atCompact(at), id) — the canonical pack order. */
function sortLooseForPack(
  files: readonly LoadedEventFile[],
): LoadedEventFile[] {
  return [...files].sort((a, b) => {
    const aAt = atCompact(a.event.at);
    const bAt = atCompact(b.event.at);
    return aAt < bAt
      ? -1
      : aAt > bAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0;
  });
}

/**
 * Best-effort scan of `design/phases/*.yaml` for live phase docs whose `id`
 * equals `phaseId`. The roadmap is NOT the only place a live phase YAML can
 * exist — a doc can sit in the dir without a roadmap reference (orphan), or with
 * no roadmap at all. The `phase_file_still_present` gate must catch those too, so
 * compaction never runs while a live phase doc exists.
 *
 * Returns the matching relative paths, plus a non-null `incomplete` reason when
 * we cannot prove absence: the directory could not be enumerated (a
 * permissions/IO error — NOT a missing dir), OR a single phase FILE in it could
 * not be read / parsed / resolved within the project (it could itself be the live
 * target phase doc). A missing `design/phases/` dir (ENOENT) is `{ paths: [],
 * incomplete: null }` (nothing live exists). Fail-closed throughout: any file we
 * cannot rule out returns `incomplete` so the caller blocks rather than compacts.
 */
async function findLivePhaseYamlsById(
  cwd: string,
  phaseId: string,
): Promise<{ paths: string[]; incomplete: string | null }> {
  let entries: string[];
  try {
    const phasesDir = await resolveSymlinkFreeProjectPath(cwd, "design/phases");
    entries = await readdir(phasesDir);
  } catch (err) {
    if (isEnoent(err)) return { paths: [], incomplete: null }; // no dir → nothing live
    return {
      paths: [],
      incomplete: `design/phases/ could not be enumerated (${(err as NodeJS.ErrnoException).code ?? "unknown"})`,
    };
  }
  const matches: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const rel = `design/phases/${entry}`;
    let abs: string;
    try {
      abs = await resolveSymlinkFreeProjectPath(cwd, rel);
    } catch {
      // A symlink (in-project or escaping): fail closed — we cannot read it to prove
      // it is NOT a live YAML with the target id.
      return {
        paths: [],
        incomplete: `${rel} is a symlink or escapes the project — cannot prove no live phase exists`,
      };
    }
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      // A YAML in design/phases/ we cannot read could be the live target phase —
      // fail closed rather than assume it is not.
      return {
        paths: [],
        incomplete: `${rel} is unreadable — cannot prove no live phase "${phaseId}" exists`,
      };
    }
    let parsed: unknown;
    try {
      parsed = Phase.parse(parseYaml(raw) as unknown);
    } catch {
      // An unparseable / non-Phase YAML in design/phases/ could be a broken live
      // target phase doc — fail closed.
      return {
        paths: [],
        incomplete: `${rel} is not a parseable phase YAML — cannot prove no live phase "${phaseId}" exists`,
      };
    }
    if ((parsed as { id: string }).id === phaseId) matches.push(rel);
  }
  return { paths: matches, incomplete: null };
}

/** One live phase whose task array claims a given task_id. */
export type LiveTaskOwner = { phase_id: string; phase_path: string };

/**
 * Scan EVERY `design/phases/*.yaml` for live phases whose **task array** contains
 * `taskId`. This is a DIFFERENT question from `findLivePhaseYamlsById` /
 * `phaseFileStillPresent`, which find a live phase by its **phase id**: a loose
 * event binds to its phase by `task_id` alone, so a task_id re-used under a
 * differently-named live phase would slip past phase-id discovery while the loose
 * event is still live. The Layer 3 delete-time gate (G6) needs THIS to refuse to
 * unlink a loose event whose task is owned by any live phase.
 *
 * Fail-closed throughout, mirroring `findLivePhaseYamlsById`: a directory that
 * cannot be enumerated (non-ENOENT), a phase file that cannot be resolved within
 * the project (symlink escape), read, or parsed as a `Phase` returns a non-null
 * `incomplete` reason — the caller MUST treat that as "cannot prove no live phase
 * owns the task" and abort, never unlink. A missing `design/phases/` dir (ENOENT)
 * is `{ owners: [], incomplete: null }` (nothing live exists). Global
 * `DUPLICATE_TASK_ID` uniqueness is the invariant, but it is RE-CHECKED here
 * (owners can have length > 1) rather than assumed — the writer never trusts a
 * prior lint/doctor pass before the irreversible step.
 */
export async function findLiveTaskOwnersByTaskId(
  cwd: string,
  taskId: string,
): Promise<{ owners: LiveTaskOwner[]; incomplete: string | null }> {
  let entries: string[];
  try {
    const phasesDir = await resolveSymlinkFreeProjectPath(cwd, "design/phases");
    entries = await readdir(phasesDir);
  } catch (err) {
    if (isEnoent(err)) return { owners: [], incomplete: null }; // no dir → nothing live
    return {
      owners: [],
      incomplete: `design/phases/ could not be enumerated (${(err as NodeJS.ErrnoException).code ?? "unknown"})`,
    };
  }
  const owners: LiveTaskOwner[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const rel = `design/phases/${entry}`;
    let abs: string;
    try {
      abs = await resolveSymlinkFreeProjectPath(cwd, rel);
    } catch {
      // A symlink (in-project or escaping): fail closed — we cannot read it to prove
      // it does NOT own the task_id.
      return {
        owners: [],
        incomplete: `${rel} is a symlink or escapes the project — cannot prove no live phase owns task "${taskId}"`,
      };
    }
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      return {
        owners: [],
        incomplete: `${rel} is unreadable — cannot prove no live phase owns task "${taskId}"`,
      };
    }
    let parsed: Phase;
    try {
      parsed = Phase.parse(parseYaml(raw) as unknown);
    } catch {
      return {
        owners: [],
        incomplete: `${rel} is not a parseable phase YAML — cannot prove no live phase owns task "${taskId}"`,
      };
    }
    if ((parsed.tasks ?? []).some(t => t.id === taskId)) {
      owners.push({ phase_id: parsed.id, phase_path: rel });
    }
  }
  return { owners, incomplete: null };
}

/**
 * Decide whether the phase's live design YAML is still on disk. An archived phase
 * has none (the normal case), but a missing/silent roadmap does NOT prove absence —
 * a live YAML can sit in `design/phases/` with no roadmap reference. So a roadmap
 * miss falls through to a directory scan rather than concluding "absent". Fail
 * closed: a duplicate id (`ambiguous`) or any phase file we cannot read/parse/
 * resolve (`discovery_incomplete`) blocks compaction. Only a clean, unambiguous
 * "nothing live exists" returns `absent`.
 */
async function phaseFileStillPresent(
  cwd: string,
  phaseId: string,
): Promise<
  | { kind: "absent" }
  | { kind: "present"; phase_path: string }
  | { kind: "ambiguous"; phase_paths: string[] }
  | { kind: "discovery_incomplete"; detail: string }
> {
  // 1. Try the roadmap. A unique resolution + an on-disk file is the clearest
  //    "present"; AMBIGUOUS is control-plane corruption (fail closed).
  let roadmapPath: string | null = null;
  try {
    const roadmap = await loadRoadmap(cwd);
    roadmapPath = resolvePhaseRef(roadmap, phaseId).path;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "AMBIGUOUS_PHASE_ID") {
      const phases =
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      return { kind: "ambiguous", phase_paths: phases };
    }
    // ENOENT (no roadmap) / PHASE_NOT_FOUND (id not referenced): the roadmap is
    // SILENT on this id, but a live YAML can still exist in design/phases/. Fall
    // through to the directory scan below — do NOT assume absent.
    if (!isEnoent(err) && code !== "PHASE_NOT_FOUND") throw err;
  }

  if (roadmapPath !== null) {
    try {
      await lstat(await resolveSymlinkFreeProjectPath(cwd, roadmapPath));
      return { kind: "present", phase_path: roadmapPath }; // the referenced file is on disk
    } catch (err) {
      if (!isEnoent(err)) {
        // A symlink escape / unreadable referenced path: fail closed.
        return { kind: "present", phase_path: roadmapPath };
      }
      // The referenced path is gone — but a DIFFERENTLY-named live YAML with the
      // same id could still exist (a stale roadmap). Fall through to the scan.
    }
  }

  // 2. Directory scan: catch a live YAML the roadmap doesn't (or can't) name. Any
  //    file in design/phases/ we cannot read/parse is fail-closed (it could be the
  //    live target phase) → discovery_incomplete.
  const scan = await findLivePhaseYamlsById(cwd, phaseId);
  if (scan.incomplete !== null) {
    return { kind: "discovery_incomplete", detail: scan.incomplete };
  }
  if (scan.paths.length === 1)
    return { kind: "present", phase_path: scan.paths[0]! };
  if (scan.paths.length > 1)
    return { kind: "ambiguous", phase_paths: scan.paths };
  return { kind: "absent" };
}

/**
 * Pure verdict: classify what `state compact <phaseId>` would do. No writes.
 */
export async function planEventPack(
  cwd: string,
  phaseId: string,
): Promise<EventPackPlan> {
  assertSafePlanId(phaseId, "Phase id");
  const packPath = await resolveArchiveOwnedPath(
    cwd,
    eventPackRelPath(phaseId),
  );

  // 1. The live phase YAML must be gone (compact follows archive). A duplicate
  //    phase id (AMBIGUOUS_PHASE_ID) is control-plane corruption with likely-live
  //    YAMLs → fail closed, never compact.
  const live = await phaseFileStillPresent(cwd, phaseId);
  if (live.kind === "present") {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "phase_file_still_present", phase_path: live.phase_path },
    };
  }
  if (live.kind === "ambiguous") {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "ambiguous_phase_id", phase_paths: live.phase_paths },
    };
  }
  if (live.kind === "discovery_incomplete") {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "phase_discovery_incomplete", detail: live.detail },
    };
  }

  // 2. Resolve the snapshot RAW bytes (for snapshot_sha256) + the parsed form from
  //    loose ∪ bundle, so compaction still works once the snapshot was compacted
  //    into a phase_snapshot bundle (the resolved bytes are canonical, so the sha is
  //    unchanged). A bundle fault is fail-closed to snapshot_invalid.
  const snapRes = await resolvePhaseSnapshotRaw(cwd, phaseId);
  if (snapRes.kind === "absent") {
    return { kind: "ineligible", phaseId, block: { kind: "snapshot_missing" } };
  }
  if (snapRes.kind === "invalid") {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "snapshot_invalid", detail: String(snapRes.error) },
    };
  }
  const snapshotRaw = snapRes.raw;
  const snapshot = snapRes.snapshot;

  // 3. Read + Tier-1-validate the TARGET pack (if any) BEFORE the evidence check.
  //    Ordering is load-bearing: a corrupt TARGET pack must be diagnosed as
  //    `pack_invalid` (the pack itself is broken), NOT `snapshot_evidence_broken`
  //    (which would misread the cause as missing evidence — the corrupt pack just
  //    contributes nothing to the resolved map). The lenient read below already
  //    skips this same corrupt pack as an EVENT_PACK_INVALID issue; we want the
  //    sharper, pack-specific verdict to win.
  // Resolve the existing pack from loose ∪ bundle, so a pack compacted into a bundle
  // (loose file gone) is recognized as existing — NOT treated as absent, which would
  // regenerate a subset pack from any leftover loose events. Full Tier-1 still runs.
  let existing: LoadedEventPack | null = null;
  const existingPackRaw = await resolveEventPackRaw(cwd, phaseId);
  if (existingPackRaw.kind === "invalid") {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "pack_invalid", detail: String(existingPackRaw.error) },
    };
  }
  if (existingPackRaw.kind === "present") {
    try {
      existing = validateEventPackTier1(
        phaseId,
        existingPackRaw.bytes,
        packPath,
      );
    } catch (err) {
      return {
        kind: "ineligible",
        phaseId,
        block: { kind: "pack_invalid", detail: (err as Error).message },
      };
    }
  }
  // absent — no existing pack; fall through to the candidate-build branch.

  // 4. Durable sources (lenient: a corrupt OTHER phase's pack can't block this;
  //    the TARGET pack's own validity was already decided above).
  const packSources = await readPackSources(cwd, "lenient");

  // 5. The phase's loose files (ALL statuses for the snapshot's task_ids) — the
  //    binding's own-pack resolution set. Built BEFORE the evidence check because
  //    the target pack's Tier-2 binding (step 6) needs it.
  const snapshotTaskIds = new Set(snapshot.tasks.map(t => t.id));
  const phaseLooseFiles = packSources.looseFiles.filter(f =>
    snapshotTaskIds.has(f.event.task_id),
  );
  const looseEventsById = new Map<string, LoadedEventFile>();
  for (const f of phaseLooseFiles) looseEventsById.set(f.id, f);

  // 6. TARGET pack Tier-2 binding BEFORE the evidence check. Ordering is
  //    load-bearing: a target pack that is Tier-1-valid but Tier-2-invalid
  //    (snapshot_sha256 mismatch, semantic replay conflict, task_id_not_in_snapshot)
  //    is dropped from `validatedPackFiles` by the lenient read above. If the
  //    evidence check ran first against `loose ∪ validatedPackFiles` it would find
  //    the snapshot's event_ids unresolved and misreport `snapshot_evidence_broken`
  //    — pointing the operator at the snapshot when the EXISTING PACK is what's
  //    broken. Binding it here pins the verdict to `pack_invalid`. (Tier-1
  //    corruption was already caught in step 3; this closes the Tier-2 path.)
  if (existing !== null) {
    const bindIssues = bindPackToSnapshot(
      existing,
      snapshot,
      snapshotRaw,
      looseEventsById,
    );
    if (bindIssues.length > 0) {
      return {
        kind: "ineligible",
        phaseId,
        block: {
          kind: "pack_invalid",
          detail: bindIssues.map(i => i.message).join("; "),
        },
      };
    }
  }

  // 7. TARGET-ONLY evidence check — the parsed snapshot we already hold, NOT a
  //    re-read (no TOCTOU), and NOT the global multi-snapshot validator. The
  //    resolved map is `loose ∪ validatedPackFiles`, PLUS the target pack's own
  //    entries when it bound cleanly above (do not depend on the lenient read
  //    having re-admitted it — make the target's contribution explicit).
  const resolved = new Map<string, ProgressEvent>();
  for (const f of [
    ...packSources.looseFiles,
    ...packSources.validatedPackFiles,
  ]) {
    resolved.set(f.id, f.event);
  }
  if (existing !== null) {
    for (const f of existing.entries) resolved.set(f.id, f.event);
  }
  const evidence = validateSnapshotEventEvidenceForSnapshot({
    snapshot,
    resolved,
  });
  if (!evidence.ok) {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "snapshot_evidence_broken", issues: evidence.issues },
    };
  }

  // 8. Existing-pack branch (Tier-1 in step 3, Tier-2 bound in step 6). Classify by
  //    the SET relationship between the loose id-set and the pack id-set — NOT bare
  //    hash equality — so a strict, non-empty subset (a phase whose loose files were
  //    PARTIALLY removed by an earlier Layer 3 run) is recognized as a RESUMABLE
  //    cleanup instead of being mis-reported as `pack_stale` (which is exit-2 and
  //    leaves the operator permanently stuck). Reachability: Tier-2 binding (step 6)
  //    already rejected any loose event NOT in the pack (`pack_missing_phase_event`
  //    → `pack_invalid`), so by here every loose id IS in the pack and the reachable
  //    relationships are `empty` / `equal` / `strict_subset`. `diverged` is the
  //    defensive fallback (a loose id outside the pack that binding somehow missed):
  //    fail closed to `pack_stale`, never resume against it. (`empty` is classified
  //    without touching the hash, preserving the "never hash an empty loose set"
  //    invariant — only `diverged` recomputes the hash, and only to fill the block.)
  if (existing !== null) {
    const packIds = new Set(existing.pack.events.map(e => e.id));
    const looseIds = new Set(phaseLooseFiles.map(f => f.id));
    const relationship = classifyLoosePackRelationship(looseIds, packIds);
    if (relationship === "diverged") {
      return {
        kind: "ineligible",
        phaseId,
        block: {
          kind: "pack_stale",
          existing_event_ids_sha256: existing.pack.event_ids_sha256,
          expected_event_ids_sha256: computeEventIdsSha256(phaseLooseFiles),
        },
      };
    }
    // empty → fully compacted; equal → pack matches loose exactly; strict_subset →
    // a prior partial cleanup left a resumable remnant. cleanup_pending iff any
    // loose file still remains on disk.
    return {
      kind: "noop_already_packed",
      phaseId,
      packPath,
      loose_remaining_count: phaseLooseFiles.length,
      cleanup_pending: relationship !== "empty",
      loose_relationship: relationship,
    };
  }

  // 9. No existing pack.
  if (phaseLooseFiles.length === 0) {
    return { kind: "noop_no_events", phaseId };
  }

  // 10. Build the candidate pack from the COMPLETE loose set.
  const sorted = sortLooseForPack(phaseLooseFiles);
  const packedEvents: PackedEvent[] = sorted.map(f => ({
    id: f.id,
    file: f.file,
    event: f.event,
  }));
  const candidate = EventPack.parse({
    schema_version: EVENT_PACK_SCHEMA_VERSION,
    phase_id: phaseId,
    snapshot_sha256: sha256Hex(snapshotRaw),
    event_ids_sha256: computeEventIdsSha256(phaseLooseFiles),
    events: packedEvents,
  } satisfies EventPack);

  // 11. Pre-write gate: the SAME binding the readback will run. Should never fail
  //    (built from the complete loose set) — fail closed if it somehow does.
  const candidateLoaded: LoadedEventPack = {
    phaseId,
    path: packPath,
    pack: candidate,
    entries: sorted,
  };
  const candidateIssues = bindPackToSnapshot(
    candidateLoaded,
    snapshot,
    snapshotRaw,
    looseEventsById,
  );
  if (candidateIssues.length > 0) {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "candidate_bind_failed", binding_issues: candidateIssues },
    };
  }

  return {
    kind: "write",
    phaseId,
    packPath,
    pack: candidate,
    loose_count: phaseLooseFiles.length,
  };
}

/**
 * Apply a plan: for a `write`, re-plan inside the (caller's) lock, write the pack
 * atomically, then readback-verify it via the Layer-1 reader + binding. NO unlink
 * — the loose files remain (Layer 3 deletes them). Non-write plans pass through.
 */
export async function applyEventPackPlan(
  cwd: string,
  plan: EventPackPlan,
  hooks: ApplyEventPackHooks = {},
): Promise<EventPackApplyOutcome> {
  if (plan.kind !== "write") return plan;

  // Re-plan inside the lock — the outer plan may be stale (a concurrent writer
  // created the pack between plan and lock acquisition). The fresh verdict is
  // authoritative (writePhaseSnapshot's re-plan discipline).
  const fresh = await planEventPack(cwd, plan.phaseId);
  if (fresh.kind !== "write") return fresh;
  // Only the write target is taken from the plan. The verify re-runs planEventPack,
  // which re-reads the snapshot AND the current loose files — so the plan's
  // snapshot/snapshotRaw/looseEventsById are deliberately NOT reused at verify time.
  const { phaseId, packPath, pack, loose_count } = fresh;

  if (hooks.beforeWrite) await hooks.beforeWrite();
  try {
    await atomicWriteText(
      packPath,
      serializeEventPack(pack),
      { kind: "absent" },
      { mkdir: true },
    );
  } catch (err) {
    // A concurrent create between re-plan and rename → "destination appeared".
    // The pack is NOT on disk (the rename never happened).
    throw new EventPackWriteError("write_pack", false, (err as Error).message);
  }

  if (hooks.beforeVerify) await hooks.beforeVerify();
  // Readback verify = RE-RUN THE WHOLE PLAN. The plan re-reads the pack (Tier-1 +
  // binding), the snapshot (raw + parsed), the CURRENT loose files, and re-runs
  // live-phase discovery + the existing-pack hash comparison — the complete state
  // machine the next runtime reader / `planEventPack` will see. After a faithful
  // write, that verdict MUST be `noop_already_packed`. Anything else means the
  // just-written pack does not match the current on-disk state (the snapshot was
  // swapped, a loose event was added/removed, a live YAML reappeared, the pack is
  // unreadable, …) — fail closed. This is strictly stronger than re-reading the
  // pack alone: it uses the SAME loose set the runtime will, not the plan-time one.
  let verifyPlan: EventPackPlan;
  try {
    verifyPlan = await planEventPack(cwd, phaseId);
  } catch (err) {
    throw new EventPackWriteError(
      "verify_pack",
      true,
      `readback re-plan threw: ${(err as Error).message}`,
    );
  }
  if (verifyPlan.kind !== "noop_already_packed") {
    const detail =
      verifyPlan.kind === "ineligible"
        ? `re-plan is ${verifyPlan.kind}(${verifyPlan.block.kind})`
        : `re-plan is ${verifyPlan.kind} (expected noop_already_packed)`;
    throw new EventPackWriteError(
      "verify_pack",
      true,
      `readback verification failed: ${detail}`,
    );
  }
  // Option A — the verify verdict must match the write we just performed: Layer 2
  // does NOT unlink, so a faithful write leaves EXACTLY the loose set it packed
  // (`cleanup_pending:true`, `loose_remaining_count === fresh.loose_count`). If a
  // concurrent delete / external edit removed loose files between write and verify,
  // `verifyPlan` reports a smaller count (or `cleanup_pending:false` at zero) — the
  // pack no longer reflects the on-disk state, so fail closed rather than return a
  // stale `loose_count`. The returned count is taken from the VERIFIED verdict, not
  // the pre-write plan.
  if (
    verifyPlan.cleanup_pending !== true ||
    verifyPlan.loose_remaining_count !== loose_count
  ) {
    throw new EventPackWriteError(
      "verify_pack",
      true,
      `readback verification failed: loose set changed during write ` +
        `(packed ${loose_count}, on disk now ${verifyPlan.loose_remaining_count}, ` +
        `cleanup_pending=${verifyPlan.cleanup_pending})`,
    );
  }

  return {
    kind: "written",
    phaseId,
    packPath,
    pack,
    loose_count: verifyPlan.loose_remaining_count,
  };
}
