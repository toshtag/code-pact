import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import type { TerminalEvidence } from "../schemas/phase-snapshot.ts";
import { isSafePlanId } from "../schemas/plan-id.ts";
import { archivePhasesDir, phaseSnapshotPath, sha256Hex } from "./paths.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";

// A generic label for bundle-integrity error messages. The index merges members
// across many bundle files, so the specific offending file is named by
// `loadArchiveBundles` itself (duplicate_member_conflict); self-bind faults are
// reported against the store as a whole.
const ARCHIVE_BUNDLE_STORE_LABEL = ".code-pact/state/archive/bundles";

// ---------------------------------------------------------------------------
// The FIRST reader of the `.code-pact/state/archive/phases/<id>.json` snapshots
// written by `phase-snapshot.ts` (step 3). Used by step 4a to tolerate a
// hand-deleted COMPLETED phase whose roadmap ref still points at the now-missing
// file — WITHOUT faking a `Phase` and WITHOUT introducing task-id ambiguity.
//
// Locked invariants (the archived-resolution model is recorded in
// design/constitution.md; the design-docs-ephemeral directive that introduced it
// was itself retired once the model landed — see its git history if needed):
//   - LIVE WINS — callers read a snapshot ONLY when the live phase YAML is gone.
//   - NEVER coerce a snapshot into `Phase` — a snapshot is intentionally smaller.
//   - The reader does NOT trust the writer: every identity / terminal / collision
//     condition is re-checked here. A snapshot that is schema-valid but unsafe
//     against the current live+archived graph is fail-closed, not tolerated.
//   - EXISTENCE ≠ SATISFACTION — the archived task index proves a task id EXISTED;
//     dependency satisfaction stays event-based elsewhere. The index carries
//     status/evidence for provenance only, never as a satisfaction source.
// ---------------------------------------------------------------------------

/** Outcome of loading one snapshot file off disk. `invalid` is NEVER collapsed
 * to `absent` — a present-but-corrupt record is a louder signal than "nothing
 * there" and must fail closed distinctly. */
export type LoadPhaseSnapshotResult =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "valid"; snapshot: PhaseSnapshot };

/** Raw bytes of one LOOSE snapshot file, before any JSON/schema parsing. Mirrors
 * {@link LoadPhaseSnapshotResult}'s absent/invalid distinction so the bundle
 * reconcile path can compare loose↔bundle byte-for-byte (the loose writer emits
 * the SAME canonical `JSON.stringify(x,null,2)+"\n"` bytes that a bundle member
 * carries). `invalid` is NEVER collapsed to `absent`. */
type RawLoosePhaseSnapshot =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "present"; bytes: string };

/**
 * Read the LOOSE `.code-pact/state/archive/phases/<phaseId>.json` bytes off disk
 * (no parsing). ENOENT → `absent`; an unsafe `phaseId` (rejected by
 * `phaseSnapshotPath` → `assertSafePlanId`) or any other read error
 * (EACCES/EISDIR/…) → `invalid` (never `absent`, fail-closed — a present-but-
 * broken record must be louder than "nothing there").
 */
async function readLoosePhaseSnapshotRaw(
  cwd: string,
  phaseId: string,
): Promise<RawLoosePhaseSnapshot> {
  let path: string;
  try {
    path = phaseSnapshotPath(cwd, phaseId);
  } catch (error) {
    return { kind: "invalid", error };
  }
  try {
    return { kind: "present", bytes: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", error };
  }
}

/**
 * Read `.code-pact/state/archive/phases/<phaseId>.json`, JSON-parse, and
 * `PhaseSnapshot.parse()`-validate. ENOENT → `absent`; any other read error or
 * a JSON/schema failure → `invalid` (never `absent`). An unsafe `phaseId`
 * (rejected by `phaseSnapshotPath` → `assertSafePlanId`) surfaces as `invalid`,
 * fail-closed — a malformed roadmap id never silently resolves a missing phase.
 */
export async function loadPhaseSnapshot(
  cwd: string,
  phaseId: string,
): Promise<LoadPhaseSnapshotResult> {
  const raw = await readLoosePhaseSnapshotRaw(cwd, phaseId);
  if (raw.kind === "absent") return { kind: "absent" };
  if (raw.kind === "invalid") return { kind: "invalid", error: raw.error };
  try {
    const snapshot = PhaseSnapshot.parse(JSON.parse(raw.bytes) as unknown);
    return { kind: "valid", snapshot };
  } catch (error) {
    return { kind: "invalid", error };
  }
}

/** Resolution of a roadmap ref whose live phase file is missing. */
export type PhaseRefResolution =
  | { kind: "tolerated"; snapshot: PhaseSnapshot }
  | { kind: "fail_missing" }
  | { kind: "fail_invalid"; reason: string };

/**
 * Decide whether a MISSING roadmap-referenced phase may be tolerated as an
 * archived completed phase. Call ONLY after the caller has established the live
 * file is absent (live-wins is the caller's short-circuit). A snapshot is
 * accepted ONLY as positive proof of an archived completed phase — every line of
 * the checklist must hold, or it is fail-closed. This deliberately does NOT trust
 * the writer's guarantees: id / path / path-hash / terminal status are all
 * re-asserted here.
 *
 * NOTE: task-id collision (intra-snapshot / cross-snapshot / archived-vs-live) is
 * a GRAPH-WIDE property and is NOT checked here (this is single-ref). It is
 * enforced by `mergeArchivedTaskIndex`, which every reader path runs before any
 * archived id enters the known set.
 *
 * SOURCE = loose ∪ bundle (bounded-archive compaction). The loose
 * `archive/phases/<id>.json` record is the existing source and WINS; a bundle
 * (`archive/bundles/*.json`) supplies the record ONLY once its loose copy is
 * compacted away. Because loose wins, a PRESENT loose record is the answer and the
 * bundle store is NOT loaded at all for that id — this keeps the loose-only path
 * byte-for-byte unchanged AND isolates it: an unrelated corrupt bundle elsewhere in
 * the store can never turn a healthy loose resolution into a failure. (Detecting a
 * loose+bundle SAME-id disagreement — `bundle_stale` — is the compaction
 * delete-time gate's job, not every reader's; that is where `reconcileLooseAndBundle`
 * lives.) Only when the loose record is ABSENT do we consult the bundle: load the
 * index → `bindBundleMember` self-binding (the member is a canonical,
 * self-consistent phase_snapshot whose own `phase_id` equals its id) → the EXISTING
 * ref-identity authority checks below. `bindBundleMember` ALONE is NOT full
 * authority binding: it never proves the record answers THIS roadmap ref — the
 * phase_id/original_path/path_sha256 checks below still run on the bundle bytes.
 * Every bundle-integrity fault (the bundle ops throw) is converted to `fail_invalid`
 * here — fail-closed, never tolerated and never thrown out of this resolver.
 */
export async function resolveMissingPhaseRef(
  cwd: string,
  ref: { id: string; path: string },
): Promise<PhaseRefResolution> {
  // Loose record bytes (loose-wins; the existing source). Unsafe id /
  // present-but-unreadable is fail-closed invalid (never absent), as before.
  const loose = await readLoosePhaseSnapshotRaw(cwd, ref.id);
  if (loose.kind === "invalid") {
    return { kind: "fail_invalid", reason: "archive snapshot is corrupt or unreadable" };
  }

  let canonicalBytes: string | null;
  if (loose.kind === "present") {
    // Loose wins unconditionally: the bundle store is irrelevant to this id and is
    // NOT loaded, so an unrelated corrupt bundle cannot fail a healthy resolution.
    canonicalBytes = loose.bytes;
  } else {
    // No loose record → the bundle store is the fallback. load + self-bind THROW on
    // any integrity fault; this resolver must not — every throw is fail-closed.
    try {
      const { index } = loadArchiveBundles(cwd);
      const bundleEntry = index.get("phase_snapshot")?.get(ref.id) ?? null;
      if (bundleEntry != null) {
        // Self-bind the bundle member: schema + phase_id↔id identity + canonical
        // bytes. (Authority that it answers THIS ref is the checklist below.)
        bindBundleMember(
          "phase_snapshot",
          { id: ref.id, sha256: bundleEntry.sha256, bytes: bundleEntry.bytes },
          ARCHIVE_BUNDLE_STORE_LABEL,
        );
      }
      canonicalBytes = bundleEntry?.bytes ?? null;
    } catch (error) {
      return {
        kind: "fail_invalid",
        reason: `archive bundle integrity check failed (${(error as Error).message})`,
      };
    }
  }

  // Referenced, but neither loose nor bundle has it → strict fail-closed missing.
  if (canonicalBytes == null) return { kind: "fail_missing" };

  let s: PhaseSnapshot;
  try {
    s = PhaseSnapshot.parse(JSON.parse(canonicalBytes) as unknown);
  } catch {
    return { kind: "fail_invalid", reason: "archive snapshot is corrupt or unreadable" };
  }

  // Identity: the record must be for THIS ref, not a misfiled / foreign / renamed
  // one. `<id>.json` names the file, but the body must agree.
  if (s.phase_id !== ref.id) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot phase_id "${s.phase_id}" does not match roadmap ref id "${ref.id}"`,
    };
  }
  if (s.original_path !== ref.path) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot original_path "${s.original_path}" does not match roadmap ref path "${ref.path}"`,
    };
  }
  // Re-assert the writer's path_sha256 invariant rather than trusting it.
  if (s.path_sha256 !== sha256Hex(s.original_path)) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot path_sha256 does not cover its own original_path "${s.original_path}"`,
    };
  }
  // Terminal re-check (defense-in-depth: today the enum is done|cancelled, so a
  // non-terminal record is already schema-invalid; this guards a future widening).
  if (s.phase_status !== "done" && s.phase_status !== "cancelled") {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot phase_status "${s.phase_status}" is not terminal`,
    };
  }
  return { kind: "tolerated", snapshot: s };
}

/**
 * One archived task id, recovered from a tolerated snapshot. EXISTENCE-ONLY —
 * NEVER a satisfaction source. `status` / `terminal_evidence` are provenance for
 * diagnostics and the cancelled-vs-done existence/satisfaction distinction made
 * elsewhere (dependency satisfaction stays event-based). Do not derive
 * "dependency met" from this type.
 */
export type ArchivedTaskEntry = {
  phase_id: string;
  original_path: string;
  task_id: string;
  status: "done" | "cancelled";
  terminal_evidence: TerminalEvidence;
};

/** Project a tolerated snapshot's tasks into archived task entries. */
export function archivedEntriesFromSnapshot(s: PhaseSnapshot): ArchivedTaskEntry[] {
  return s.tasks.map((t) => ({
    phase_id: s.phase_id,
    original_path: s.original_path,
    task_id: t.id,
    status: t.status,
    terminal_evidence: t.terminal_evidence,
  }));
}

/** One detected task-id collision (for the caller to surface as PHASE_SNAPSHOT_INVALID). */
export type ArchivedTaskCollision = {
  task_id: string;
  /** Where the colliding id appears, for the human message. */
  kind: "live" | "cross_snapshot" | "intra_snapshot";
  /** The archived phase id(s) involved. */
  phase_ids: string[];
  reason: string;
};

export type MergeArchivedTaskIndexResult = {
  /** Collision-free archived task ids → entry. Every colliding id is ABSENT. */
  index: Map<string, ArchivedTaskEntry>;
  /** Collisions, one per offending task id. Non-empty ⇒ fail-closed. */
  collisions: ArchivedTaskCollision[];
};

/**
 * Merge per-phase candidate archived entries into a collision-checked index that
 * every reader path consults BEFORE any archived id is used to suppress
 * `TASK_DEPENDS_ON_UNRESOLVED` / `ORPHAN_PROGRESS_EVENT`. Three collisions are
 * fail-closed — an archived task id is rejected when it duplicates:
 *   1. itself, within one snapshot (the snapshot schema does NOT enforce this);
 *   2. across two tolerated snapshots;
 *   3. a LIVE task id (`liveTaskIds`).
 * A colliding id is fail-closed (`PHASE_SNAPSHOT_INVALID`, the caller's job) and
 * NEVER picks a winner: it is dropped from ALL sides and never enters `index`.
 * A non-colliding sibling id in the same snapshot is unambiguous and is KEPT —
 * the drop unit is the id, not the phase. The live id (case 3) is untouched in
 * its own live taskIndex; only the archived contribution is dropped.
 */
export function mergeArchivedTaskIndex(
  liveTaskIds: ReadonlySet<string>,
  candidates: readonly ArchivedTaskEntry[],
): MergeArchivedTaskIndexResult {
  // First pass: count occurrences across all candidates + note intra-snapshot
  // duplicates, so a 3-way collision is reported once and consistently dropped.
  const seen = new Map<string, ArchivedTaskEntry>();
  const collidingIds = new Map<string, ArchivedTaskCollision>();

  const recordCollision = (
    task_id: string,
    kind: ArchivedTaskCollision["kind"],
    phaseId: string,
    reason: string,
  ) => {
    const existing = collidingIds.get(task_id);
    if (existing) {
      if (!existing.phase_ids.includes(phaseId)) existing.phase_ids.push(phaseId);
      return;
    }
    collidingIds.set(task_id, { task_id, kind, phase_ids: [phaseId], reason });
  };

  // Track intra-snapshot duplicates: same (phase_id, task_id) twice.
  const perPhaseSeen = new Set<string>();

  for (const entry of candidates) {
    const { task_id, phase_id } = entry;

    // Case 3: archived vs live.
    if (liveTaskIds.has(task_id)) {
      recordCollision(
        task_id,
        "live",
        phase_id,
        `archived task id "${task_id}" (phase "${phase_id}") collides with a live task id`,
      );
    }

    // Case 1: intra-snapshot duplicate.
    const phaseTaskKey = JSON.stringify([phase_id, task_id]);
    if (perPhaseSeen.has(phaseTaskKey)) {
      recordCollision(
        task_id,
        "intra_snapshot",
        phase_id,
        `archived task id "${task_id}" appears more than once within snapshot "${phase_id}"`,
      );
    }
    perPhaseSeen.add(phaseTaskKey);

    // Case 2: cross-snapshot duplicate (same id, different tolerated snapshot).
    const prior = seen.get(task_id);
    if (prior && prior.phase_id !== phase_id) {
      recordCollision(
        task_id,
        "cross_snapshot",
        prior.phase_id,
        `archived task id "${task_id}" is claimed by two snapshots ("${prior.phase_id}" and "${phase_id}")`,
      );
      recordCollision(task_id, "cross_snapshot", phase_id, collidingIds.get(task_id)!.reason);
    }
    if (!seen.has(task_id)) seen.set(task_id, entry);
  }

  // Build the index, EXCLUDING every colliding id (never pick a winner).
  const index = new Map<string, ArchivedTaskEntry>();
  for (const entry of candidates) {
    if (collidingIds.has(entry.task_id)) continue;
    if (!index.has(entry.task_id)) index.set(entry.task_id, entry);
  }

  return { index, collisions: [...collidingIds.values()] };
}

// ---------------------------------------------------------------------------
// Step 4b — UNREFERENCED archived-phase discovery.
//
// 4a resolves a hand-deleted COMPLETED phase whose roadmap ref STAYS, by
// ref.id → <id>.json (pinpoint). 4b covers the phase whose roadmap ref is GONE:
// there is no ref to name it, so the reader must ENUMERATE
// `.code-pact/state/archive/phases/*.json`. READER-ONLY (the destructive
// `phase archive --write` that removes a ref is step 7) — 4b adds the discovery
// so a cross-phase `depends_on` into an unreferenced archived phase still
// resolves (existence-only), under the SAME invariants as 4a.
//
// FAIL-SOFT BY CONSTRUCTION (the A5 contract): discovery NEVER throws. A
// discovery failure — whether the whole directory is unreadable (ENOTDIR /
// EACCES / EPERM) or one file is corrupt / has an unsafe stem — supplies no task
// ids and introduces no graph ambiguity, so it is reported in `invalid[]`, never
// thrown. The caller routes it per Q4: a `plan lint` `affects_exit:false`
// advisory; doctor/validate skip it silently (a doctor issue would fail
// `validate --strict` and break A5); strict loaders / resolveTaskInRoadmap skip
// without throwing. A live `depends_on` on an id a failed discovery would have
// supplied still fails — but via the existing, live-scoped
// `TASK_DEPENDS_ON_UNRESOLVED`, never a hard PHASE_SNAPSHOT_INVALID.
//
// The one NON-soft case stays the COLLISION of a VALID snapshot's task ids (with
// a live id / another snapshot / itself): that is graph-ambiguous state, a hard
// PHASE_SNAPSHOT_INVALID everywhere even though the phase is unreferenced — see
// mergeArchivedTaskIndex (unchanged; the caller runs it over 4a ∪ 4b ∪ live).
// ---------------------------------------------------------------------------

/** Resolution of a snapshot found by enumeration (no roadmap ref to match). */
export type UnreferencedSnapshotResolution =
  | { kind: "tolerated"; snapshot: PhaseSnapshot }
  | { kind: "fail_invalid"; reason: string };

/**
 * Decide whether a snapshot found by ENUMERATION (no roadmap ref) may be trusted
 * as an archived terminal phase. With no ref there is no `ref.id`/`ref.path` to
 * compare against; identity rests on the snapshot's INTERNAL self-consistency
 * plus the writer's filename invariant. The 4a checklist with the two
 * ref-comparison lines replaced by the filename↔body check:
 *   1. schema-valid (the caller passes a `loadPhaseSnapshot` result);
 *   2. `phase_id === fileStem` — the writer names the file `<phase_id>.json`;
 *   3. `path_sha256 === sha256Hex(original_path)` — internal self-consistency;
 *   4. `phase_status` terminal (done | cancelled).
 * Any failure → `fail_invalid` (a SOFT outcome for an unreferenced file — the
 * caller does NOT hard-error on it; see the module header).
 */
export function resolveUnreferencedSnapshot(
  fileStem: string,
  res: LoadPhaseSnapshotResult,
): UnreferencedSnapshotResolution {
  if (res.kind === "absent") {
    return { kind: "fail_invalid", reason: "archive snapshot file vanished during discovery" };
  }
  if (res.kind === "invalid") {
    return { kind: "fail_invalid", reason: "archive snapshot is corrupt or unreadable" };
  }
  const s = res.snapshot;
  if (s.phase_id !== fileStem) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot phase_id "${s.phase_id}" does not match its filename "${fileStem}.json"`,
    };
  }
  if (s.path_sha256 !== sha256Hex(s.original_path)) {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot path_sha256 does not cover its own original_path "${s.original_path}"`,
    };
  }
  if (s.phase_status !== "done" && s.phase_status !== "cancelled") {
    return {
      kind: "fail_invalid",
      reason: `archive snapshot phase_status "${s.phase_status}" is not terminal`,
    };
  }
  return { kind: "tolerated", snapshot: s };
}

/** A soft discovery failure — directory-level (readdir failed) or file-level. */
export type UnreferencedSnapshotInvalid =
  | { scope: "directory"; reason: string }
  | { scope: "file"; fileStem: string; reason: string };

export type DiscoverUnreferencedResult = {
  /** Existence-only candidates from valid unreferenced snapshots (NOT yet merged). */
  entries: ArchivedTaskEntry[];
  /** Soft failures (dir- or file-level) for the caller to surface per Q4. */
  invalid: UnreferencedSnapshotInvalid[];
};

/**
 * Enumerate `.code-pact/state/archive/phases/*.json`, EXCLUDE any whose phase_id
 * is a LIVE roadmap phase id (those are 4a's referenced case / live-wins — loading
 * them here would double-count and self-collide), and validate the rest via
 * {@link resolveUnreferencedSnapshot}. Returns existence-only `entries` plus soft
 * `invalid[]`. NEVER throws (see the module header): an unreadable directory, an
 * unsafe filename stem, and a corrupt file are all soft `invalid[]` outcomes.
 *
 * `liveRoadmapPhaseIds` must be ALL `roadmap.phases[].id` — call ONLY after the
 * roadmap parsed (never in a no-roadmap fallback; without the roadmap the
 * exclusion set is unknown and discovery would mis-handle a still-live phase).
 */
export async function discoverUnreferencedSnapshots(
  cwd: string,
  liveRoadmapPhaseIds: ReadonlySet<string>,
): Promise<DiscoverUnreferencedResult> {
  const entries: ArchivedTaskEntry[] = [];
  const invalid: UnreferencedSnapshotInvalid[] = [];

  let names: string[];
  try {
    names = await readdir(archivePhasesDir(cwd));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No archive dir is the normal untouched-project state — not even an advisory.
    if (code === "ENOENT") return { entries, invalid };
    // ENOTDIR / EACCES / EPERM / anything else: a directory we can't read supplies
    // no ids → soft directory-level invalid, NEVER thrown (the A5 contract).
    invalid.push({
      scope: "directory",
      reason: `archive phases directory could not be read (${code ?? "unknown error"})`,
    });
    return { entries, invalid };
  }

  // Deterministic order so advisory order / collision reporting / index build are
  // environment-independent (control-plane reader).
  const jsonFiles = names.filter((n) => n.endsWith(".json")).sort();

  for (const name of jsonFiles) {
    const fileStem = basename(name, ".json");
    // 4a/4b boundary: a snapshot whose id IS a live roadmap phase is 4a's case.
    if (liveRoadmapPhaseIds.has(fileStem)) continue;
    // Unsafe stem: never let phaseSnapshotPath/assertSafePlanId throw out of here.
    if (!isSafePlanId(fileStem)) {
      invalid.push({ scope: "file", fileStem, reason: "unsafe archive snapshot filename" });
      continue;
    }
    const res = await loadPhaseSnapshot(cwd, fileStem);
    const resolved = resolveUnreferencedSnapshot(fileStem, res);
    if (resolved.kind === "tolerated") {
      entries.push(...archivedEntriesFromSnapshot(resolved.snapshot));
    } else {
      invalid.push({ scope: "file", fileStem, reason: resolved.reason });
    }
  }

  return { entries, invalid };
}
