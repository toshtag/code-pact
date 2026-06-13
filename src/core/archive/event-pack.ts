import { readFile, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EventPack,
  EVENT_PACK_SCHEMA_VERSION,
  type PackedEvent,
} from "../schemas/event-pack.ts";
import { Phase } from "../schemas/phase.ts";
import type { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { LoadedEventFile } from "../progress/events-io.ts";
import { atCompact } from "../progress/event-id.ts";
import { assertSafePlanId } from "../schemas/plan-id.ts";
import { loadRoadmap } from "../plan/roadmap.ts";
import { resolvePhaseRef } from "../plan/resolve-phase.ts";
import { resolveWithinProject } from "../path-safety.ts";
import { readPackSources } from "../progress/all-sources.ts";
import { loadPhaseSnapshot } from "./load-phase-snapshot.ts";
import {
  validateSnapshotEventEvidenceForSnapshot,
  type SnapshotEvidenceIssue,
} from "./snapshot-evidence.ts";
import {
  validateEventPackTier1,
  computeEventIdsSha256,
  type LoadedEventPack,
} from "./event-pack-reader.ts";
import {
  bindPackToSnapshot,
  type EventPackBindingIssue,
} from "./event-pack-binding.ts";
import { eventPackPath, sha256Hex, phaseSnapshotPath } from "./paths.ts";
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
  | { kind: "pack_stale"; existing_event_ids_sha256: string; expected_event_ids_sha256: string }
  | { kind: "pack_invalid"; detail: string }
  | { kind: "candidate_bind_failed"; binding_issues: EventPackBindingIssue[] };

export type EventPackPlan =
  | {
      kind: "write";
      phaseId: string;
      packPath: string;
      pack: EventPack;
      /** The parsed snapshot + raw bytes, held for readback bind (no re-read). */
      snapshot: PhaseSnapshot;
      snapshotRaw: string;
      /** loose ∪ THIS pack's events, by id — the readback resolution set. */
      looseEventsById: Map<string, LoadedEventFile>;
      /** Count of loose files for the phase's tasks (for loose_remaining_count). */
      loose_count: number;
    }
  | {
      kind: "noop_already_packed";
      phaseId: string;
      packPath: string;
      loose_remaining_count: number;
      cleanup_pending: boolean;
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
    }
  | { kind: "noop_no_events"; phaseId: string }
  | { kind: "ineligible"; phaseId: string; block: EventPackBlock };

/** A pack write/verify failure. `verify_pack` + partial_applied means the pack
 *  is on disk but failed readback — Layer 2 does NOT delete it (no unlink). */
export class EventPackWriteError extends Error {
  readonly phase: "write_pack" | "verify_pack";
  readonly partial_applied: boolean;
  readonly detail: string;
  constructor(phase: "write_pack" | "verify_pack", partial_applied: boolean, detail: string) {
    super(`event pack ${phase} failed (partial_applied=${partial_applied}): ${detail}`);
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
function sortLooseForPack(files: readonly LoadedEventFile[]): LoadedEventFile[] {
  return [...files].sort((a, b) => {
    const aAt = atCompact(a.event.at);
    const bAt = atCompact(b.event.at);
    return aAt < bAt ? -1 : aAt > bAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Is the phase's live design YAML still on disk? An archived phase has none
 * (that's the normal case), so a missing roadmap / `PHASE_NOT_FOUND` / ENOENT
 * all mean "absent, proceed — the snapshot is the authority". Only a YAML that
 * actually resolves to a path on disk blocks compaction.
 */
/**
 * Best-effort scan of `design/phases/*.yaml` for live phase docs whose `id`
 * equals `phaseId`. The roadmap is NOT the only place a live phase YAML can
 * exist — a doc can sit in the dir without a roadmap reference (orphan), or with
 * no roadmap at all. The `phase_file_still_present` gate must catch those too, so
 * compaction never runs while a live phase doc exists.
 *
 * Returns the matching relative paths, plus `unreadable` when the directory
 * itself could not be enumerated (a permissions/IO error — NOT a missing dir).
 * A missing `design/phases/` dir (ENOENT) is `{ paths: [], unreadable: false }`
 * (nothing live exists). A single unparseable / unreadable phase FILE is skipped
 * (it can't prove an id match), but a directory we cannot read at all is
 * `unreadable: true` so the caller fails closed (we cannot prove absence).
 */
async function findLivePhaseYamlsById(
  cwd: string,
  phaseId: string,
): Promise<{ paths: string[]; unreadable: boolean }> {
  const phasesDir = join(cwd, "design", "phases");
  let entries: string[];
  try {
    entries = await readdir(phasesDir);
  } catch (err) {
    if (isEnoent(err)) return { paths: [], unreadable: false }; // no dir → nothing live
    return { paths: [], unreadable: true }; // can't enumerate → fail closed upstream
  }
  const matches: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const rel = `design/phases/${entry}`;
    let abs: string;
    try {
      abs = await resolveWithinProject(cwd, rel);
    } catch {
      continue; // symlink escape on a sibling file — skip it, it's not our phase
    }
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      continue; // unreadable single file — can't prove an id match, skip
    }
    let parsed: unknown;
    try {
      parsed = Phase.parse(parseYaml(raw) as unknown);
    } catch {
      continue; // unparseable / non-phase YAML — skip
    }
    if ((parsed as { id: string }).id === phaseId) matches.push(rel);
  }
  return { paths: matches, unreadable: false };
}

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
      const phases = (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      return { kind: "ambiguous", phase_paths: phases };
    }
    // ENOENT (no roadmap) / PHASE_NOT_FOUND (id not referenced): the roadmap is
    // SILENT on this id, but a live YAML can still exist in design/phases/. Fall
    // through to the directory scan below — do NOT assume absent.
    if (!isEnoent(err) && code !== "PHASE_NOT_FOUND") throw err;
  }

  if (roadmapPath !== null) {
    try {
      await lstat(await resolveWithinProject(cwd, roadmapPath));
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

  // 2. Directory scan: catch a live YAML the roadmap doesn't (or can't) name.
  const scan = await findLivePhaseYamlsById(cwd, phaseId);
  if (scan.unreadable) {
    return {
      kind: "discovery_incomplete",
      detail: `design/phases/ could not be enumerated — cannot prove no live phase "${phaseId}" YAML exists`,
    };
  }
  if (scan.paths.length === 1) return { kind: "present", phase_path: scan.paths[0]! };
  if (scan.paths.length > 1) return { kind: "ambiguous", phase_paths: scan.paths };
  return { kind: "absent" };
}

/**
 * Pure verdict: classify what `state compact <phaseId>` would do. No writes.
 */
export async function planEventPack(cwd: string, phaseId: string): Promise<EventPackPlan> {
  assertSafePlanId(phaseId, "Phase id");
  const packPath = eventPackPath(cwd, phaseId);

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

  // 2. Read the snapshot RAW bytes (for snapshot_sha256) + the parsed form.
  let snapshotRaw: string;
  try {
    snapshotRaw = await readFile(phaseSnapshotPath(cwd, phaseId), "utf8");
  } catch (err) {
    if (isEnoent(err)) return { kind: "ineligible", phaseId, block: { kind: "snapshot_missing" } };
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "snapshot_invalid", detail: (err as Error).message },
    };
  }
  const snapRes = await loadPhaseSnapshot(cwd, phaseId);
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
  const snapshot = snapRes.snapshot;

  // 3. Durable sources (lenient: a corrupt OTHER phase's pack can't block this).
  const packSources = await readPackSources(cwd, "lenient");
  const resolved = new Map<string, ProgressEvent>();
  for (const f of [...packSources.looseFiles, ...packSources.validatedPackFiles]) {
    resolved.set(f.id, f.event);
  }

  // 4. TARGET-ONLY evidence check — the parsed snapshot we already hold, NOT a
  //    re-read (no TOCTOU), and NOT the global multi-snapshot validator.
  const evidence = validateSnapshotEventEvidenceForSnapshot({ snapshot, resolved });
  if (!evidence.ok) {
    return {
      kind: "ineligible",
      phaseId,
      block: { kind: "snapshot_evidence_broken", issues: evidence.issues },
    };
  }

  // 5. The phase's loose files (ALL statuses for the snapshot's task_ids).
  const snapshotTaskIds = new Set(snapshot.tasks.map((t) => t.id));
  const phaseLooseFiles = packSources.looseFiles.filter((f) =>
    snapshotTaskIds.has(f.event.task_id),
  );
  const looseEventsById = new Map<string, LoadedEventFile>();
  for (const f of phaseLooseFiles) looseEventsById.set(f.id, f);

  // 6. Existing-pack branch.
  let existingRaw: string | null = null;
  try {
    existingRaw = await readFile(packPath, "utf8");
  } catch (err) {
    if (!isEnoent(err)) {
      return {
        kind: "ineligible",
        phaseId,
        block: { kind: "pack_invalid", detail: (err as Error).message },
      };
    }
  }
  if (existingRaw !== null) {
    let existing: LoadedEventPack;
    try {
      existing = validateEventPackTier1(phaseId, existingRaw, packPath);
    } catch (err) {
      return {
        kind: "ineligible",
        phaseId,
        block: { kind: "pack_invalid", detail: (err as Error).message },
      };
    }
    const bindIssues = bindPackToSnapshot(existing, snapshot, snapshotRaw, looseEventsById);
    if (bindIssues.length > 0) {
      return {
        kind: "ineligible",
        phaseId,
        block: { kind: "pack_invalid", detail: bindIssues.map((i) => i.message).join("; ") },
      };
    }
    // Branch on loose count FIRST — once loose is gone there is nothing to compare
    // against, so NEVER compare the pack's hash to computeEventIdsSha256([]).
    if (phaseLooseFiles.length === 0) {
      return {
        kind: "noop_already_packed",
        phaseId,
        packPath,
        loose_remaining_count: 0,
        cleanup_pending: false,
      };
    }
    const expected = computeEventIdsSha256(phaseLooseFiles);
    if (existing.pack.event_ids_sha256 === expected) {
      return {
        kind: "noop_already_packed",
        phaseId,
        packPath,
        loose_remaining_count: phaseLooseFiles.length,
        cleanup_pending: true,
      };
    }
    return {
      kind: "ineligible",
      phaseId,
      block: {
        kind: "pack_stale",
        existing_event_ids_sha256: existing.pack.event_ids_sha256,
        expected_event_ids_sha256: expected,
      },
    };
  }

  // 7. No existing pack.
  if (phaseLooseFiles.length === 0) {
    return { kind: "noop_no_events", phaseId };
  }

  // 8. Build the candidate pack from the COMPLETE loose set.
  const sorted = sortLooseForPack(phaseLooseFiles);
  const packedEvents: PackedEvent[] = sorted.map((f) => ({ id: f.id, file: f.file, event: f.event }));
  const candidate = EventPack.parse({
    schema_version: EVENT_PACK_SCHEMA_VERSION,
    phase_id: phaseId,
    snapshot_sha256: sha256Hex(snapshotRaw),
    event_ids_sha256: computeEventIdsSha256(phaseLooseFiles),
    events: packedEvents,
  } satisfies EventPack);

  // 9. Pre-write gate: the SAME binding the readback will run. Should never fail
  //    (built from the complete loose set) — fail closed if it somehow does.
  const candidateLoaded: LoadedEventPack = {
    phaseId,
    path: packPath,
    pack: candidate,
    entries: sorted,
  };
  const candidateIssues = bindPackToSnapshot(candidateLoaded, snapshot, snapshotRaw, looseEventsById);
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
    snapshot,
    snapshotRaw,
    looseEventsById,
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
  // snapshot/snapshotRaw from the plan are NOT reused at verify time — the
  // readback re-reads the snapshot from disk (below) so the verify reflects the
  // current on-disk snapshot, not the plan-time bytes.
  const { phaseId, packPath, pack, looseEventsById, loose_count } = fresh;

  if (hooks.beforeWrite) await hooks.beforeWrite();
  try {
    await atomicWriteText(packPath, serializeEventPack(pack), { kind: "absent" }, { mkdir: true });
  } catch (err) {
    // A concurrent create between re-plan and rename → "destination appeared".
    // The pack is NOT on disk (the rename never happened).
    throw new EventPackWriteError("write_pack", false, (err as Error).message);
  }

  if (hooks.beforeVerify) await hooks.beforeVerify();
  // Readback: re-read BOTH the pack AND the snapshot from disk, then run the SAME
  // Tier-1 + binding the runtime uses — never trust the in-memory pack OR the
  // in-memory snapshot bytes. Re-reading the snapshot makes the verify reflect the
  // CURRENT on-disk snapshot: if it was swapped/edited between plan and verify, the
  // pack's snapshot_sha256 (computed at plan time) won't match the re-read bytes
  // and binding fails closed — rather than reporting success on a pack that the
  // next strict reader would reject.
  let readbackRaw: string;
  try {
    readbackRaw = await readFile(packPath, "utf8");
  } catch (err) {
    throw new EventPackWriteError("verify_pack", true, `readback read failed: ${(err as Error).message}`);
  }
  let loaded: LoadedEventPack;
  try {
    loaded = validateEventPackTier1(phaseId, readbackRaw, packPath);
  } catch (err) {
    throw new EventPackWriteError("verify_pack", true, `readback Tier-1 failed: ${(err as Error).message}`);
  }
  let verifySnapshotRaw: string;
  try {
    verifySnapshotRaw = await readFile(phaseSnapshotPath(cwd, phaseId), "utf8");
  } catch (err) {
    throw new EventPackWriteError(
      "verify_pack",
      true,
      `readback snapshot read failed: ${(err as Error).message}`,
    );
  }
  const verifySnap = await loadPhaseSnapshot(cwd, phaseId);
  if (verifySnap.kind !== "valid") {
    throw new EventPackWriteError(
      "verify_pack",
      true,
      `snapshot is no longer valid at verify time (${verifySnap.kind})`,
    );
  }
  const bindIssues = bindPackToSnapshot(
    loaded,
    verifySnap.snapshot,
    verifySnapshotRaw,
    looseEventsById,
  );
  if (bindIssues.length > 0) {
    throw new EventPackWriteError(
      "verify_pack",
      true,
      `readback binding failed: ${bindIssues.map((i) => i.message).join("; ")}`,
    );
  }
  return { kind: "written", phaseId, packPath, pack, loose_count };
}
