import { readdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { PhaseSnapshot } from "../schemas/phase-snapshot.ts";
import type { TerminalEvidence } from "../schemas/phase-snapshot.ts";
import { isSafePlanId } from "../schemas/plan-id.ts";
import { archivePhasesRelDir, phaseSnapshotRelPath, resolveArchiveOwnedPath, sha256Hex } from "./paths.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import { bindBundleMember } from "./archive-bundle-binding.ts";
import type { BundleIndexEntry, BundleMemberIndex } from "./archive-bundle-index.ts";
import { resolveArchiveRecordBytes, type RawLooseRecord } from "./resolve-archive-record.ts";
import { readPendingDeleteFilters } from "./delete-intent-journal.ts";

// The bundle store label for bundle-integrity error messages from this module.
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

/**
 * Read the LOOSE `.code-pact/state/archive/phases/<phaseId>.json` bytes off disk
 * (no parsing). ENOENT → `absent`; an unsafe `phaseId` (rejected by
 * `phaseSnapshotPath` → `assertSafePlanId`) or any other read error
 * (EACCES/EISDIR/…) → `invalid` (never `absent`, fail-closed — a present-but-
 * broken record must be louder than "nothing there"). Exported so the event-pack
 * binding's snapshot read resolves the snapshot from loose ∪ bundle too. The loose
 * writer emits the SAME canonical `JSON.stringify(x,null,2)+"\n"` bytes a bundle
 * member carries, so `invalid` is NEVER collapsed to `absent`.
 */
export async function readLoosePhaseSnapshotRaw(
  cwd: string,
  phaseId: string,
): Promise<RawLooseRecord> {
  let path: string;
  try {
    path = await resolveArchiveOwnedPath(cwd, phaseSnapshotRelPath(phaseId));
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
 * LOW-LEVEL loose-only reader: read `.code-pact/state/archive/phases/<phaseId>.json`,
 * JSON-parse, and `PhaseSnapshot.parse()`-validate. ENOENT → `absent`; any other read
 * error or a JSON/schema failure → `invalid` (never `absent`). An unsafe `phaseId`
 * (rejected by `phaseSnapshotPath` → `assertSafePlanId`) surfaces as `invalid`,
 * fail-closed — a malformed roadmap id never silently resolves a missing phase.
 *
 * NOT bundle-aware and NOT delete-intent-aware: it reads only the loose file. Callers
 * wanting the full archive view (loose ∪ bundle, with a pending delete-intent treated
 * as absent) MUST use `resolvePhaseSnapshotRaw` / `enumerateArchivedPhaseSnapshots`
 * (which is the only in-repo caller, and it applies the delete-intent filter itself).
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

/** A snapshot resolved from loose ∪ bundle, carrying BOTH the canonical raw bytes
 *  (for `snapshot_sha256`) and the parsed body. `invalid` is never collapsed to
 *  `absent`. */
export type ResolvedPhaseSnapshotRaw =
  | { kind: "absent" }
  | { kind: "invalid"; error: unknown }
  | { kind: "valid"; raw: string; snapshot: PhaseSnapshot };

/**
 * Resolve a phase snapshot's canonical raw bytes + parsed body from loose ∪ bundle
 * (`reader-loose-wins`), so the event-pack compaction path (which needs the snapshot
 * to compute / re-verify `snapshot_sha256`) works whether the snapshot is a loose
 * file or has been compacted into a `phase_snapshot` bundle. The resolved bytes ARE
 * the canonical bytes the writer emitted (loose file and bundle member are
 * byte-identical), so `sha256Hex(raw)` matches any stored `snapshot_sha256`. A
 * bundle-integrity fault is fail-closed to `invalid` (never thrown). Behaves exactly
 * like `loadPhaseSnapshot` (plus raw) when no bundles exist.
 */
export async function resolvePhaseSnapshotRaw(
  cwd: string,
  phaseId: string,
): Promise<ResolvedPhaseSnapshotRaw> {
  let resolved;
  try {
    const { looseAbsentIds, bundleAbsentIds } = await readPendingDeleteFilters(cwd); // mid-deletion pair → logically absent (bundle-pair: bundle side only)
    resolved = await resolveArchiveRecordBytes({
      kind: "phase_snapshot",
      id: phaseId,
      mode: "reader-loose-wins",
      pendingAbsentIds: looseAbsentIds,
      pendingBundleAbsentIds: bundleAbsentIds,
      readLooseRaw: () => readLoosePhaseSnapshotRaw(cwd, phaseId),
      loadBundleIndex: () => loadArchiveBundles(cwd).index,
    });
  } catch (error) {
    return { kind: "invalid", error };
  }
  if (resolved.kind === "absent") return { kind: "absent" };
  if (resolved.kind === "invalid") return { kind: "invalid", error: resolved.error };
  try {
    const snapshot = PhaseSnapshot.parse(JSON.parse(resolved.bytes) as unknown);
    return { kind: "valid", raw: resolved.bytes, snapshot };
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
 * SOURCE = loose ∪ bundle (bounded-archive compaction), resolved through the shared
 * `resolveArchiveRecordBytes` in `reader-loose-wins` mode so this reader and every
 * other archive reader stay on one implementation. The loose `archive/phases/<id>.json`
 * record WINS; a bundle (`archive/bundles/*.json`) supplies the record ONLY once its
 * loose copy is compacted away. A PRESENT loose record is the answer and the bundle
 * store is NOT loaded for that id — keeping the loose-only path byte-for-byte
 * unchanged AND isolating it: an unrelated corrupt bundle elsewhere can never fail a
 * healthy loose resolution. (Detecting a loose+bundle SAME-id `bundle_stale` is the
 * `strict-reconcile` callers' job — writer/readback, the delete-time gate, explicit
 * verify — not a reader's.) The shared resolver self-binds the bundle member; this
 * reader's POSTURE is fail-closed strict (a referenced phase), so a bundle-integrity
 * throw maps to `fail_invalid`. `bindBundleMember` ALONE is NOT full authority
 * binding: the EXISTING ref-identity checks below (phase_id/original_path/path_sha256/
 * terminal) still run on the resolved bytes. This resolver never throws.
 */
export async function resolveMissingPhaseRef(
  cwd: string,
  ref: { id: string; path: string },
): Promise<PhaseRefResolution> {
  // Resolve from loose ∪ bundle via the shared resolver (reader-loose-wins): a
  // present loose record wins and the bundle store is not loaded; only an absent
  // loose record consults the bundle. A bundle-integrity fault THROWS — this
  // resolver's posture is fail-closed strict (a referenced phase), so every throw
  // maps to `fail_invalid`. A loose-read invalidity is returned, not thrown.
  let resolved;
  try {
    const { looseAbsentIds, bundleAbsentIds } = await readPendingDeleteFilters(cwd); // a mid-deletion pair → logically absent (bundle-pair: bundle side only)
    resolved = await resolveArchiveRecordBytes({
      kind: "phase_snapshot",
      id: ref.id,
      mode: "reader-loose-wins",
      pendingAbsentIds: looseAbsentIds,
      pendingBundleAbsentIds: bundleAbsentIds,
      readLooseRaw: () => readLoosePhaseSnapshotRaw(cwd, ref.id),
      loadBundleIndex: () => loadArchiveBundles(cwd).index,
    });
  } catch (error) {
    return {
      kind: "fail_invalid",
      reason: `archive bundle integrity check failed (${(error as Error).message})`,
    };
  }
  if (resolved.kind === "invalid") {
    return { kind: "fail_invalid", reason: "archive snapshot is corrupt or unreadable" };
  }
  // Referenced, but neither loose nor bundle has it → strict fail-closed missing.
  if (resolved.kind === "absent") return { kind: "fail_missing" };

  let s: PhaseSnapshot;
  try {
    s = PhaseSnapshot.parse(JSON.parse(resolved.bytes) as unknown);
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

  const { entries: enumerated, skipped } = await enumerateArchivedPhaseSnapshots(cwd);
  for (const s of skipped) {
    invalid.push(
      s.scope === "directory"
        ? { scope: "directory", reason: s.detail }
        : { scope: "file", fileStem: s.fileStem, reason: s.detail },
    );
  }
  for (const { fileStem, res } of enumerated) {
    // 4a/4b boundary: a snapshot whose id IS a live roadmap phase is 4a's case.
    if (liveRoadmapPhaseIds.has(fileStem)) continue;
    const resolved = resolveUnreferencedSnapshot(fileStem, res);
    if (resolved.kind === "tolerated") {
      entries.push(...archivedEntriesFromSnapshot(resolved.snapshot));
    } else {
      invalid.push({ scope: "file", fileStem, reason: resolved.reason });
    }
  }

  return { entries, invalid };
}

// ---------------------------------------------------------------------------
// Shared loose ∪ bundle ENUMERATION of every archived phase snapshot. The three
// fail-soft global readers (discoverUnreferencedSnapshots here, readArchivedTaskIds
// + validateSnapshotEventEvidence in snapshot-evidence.ts) all route through this so
// a snapshot compacted into a `phase_snapshot` bundle is still visible — without
// each re-implementing loose-vs-bundle handling. (The fail-CLOSED, per-id,
// referenced path is resolveMissingPhaseRef, which does NOT use this enumeration.)
// ---------------------------------------------------------------------------

/** One enumerated archived phase snapshot + its load result (absent/invalid/valid).
 *  Callers reuse their existing branch on `res.kind` unchanged. */
export type EnumeratedPhaseSnapshot = { fileStem: string; res: LoadPhaseSnapshotResult };

/** A soft enumeration skip: a STORE that could not be read (the loose directory or
 *  the bundle store) or an unsafe id. The per-snapshot corrupt case is NOT a skip —
 *  it is carried as an `invalid` result in the entry's `res`. */
export type PhaseSnapshotEnumSkip =
  | { scope: "directory"; detail: string }
  | { scope: "file"; fileStem: string; detail: string };

/** Bind one `phase_snapshot` bundle member into a `LoadPhaseSnapshotResult`: valid on
 *  self-bind success (schema + id↔phase_id + canonical bytes), invalid on any fault. */
function bindBundlePhaseSnapshot(phaseId: string, entry: BundleIndexEntry): LoadPhaseSnapshotResult {
  try {
    const bound = bindBundleMember(
      "phase_snapshot",
      { id: phaseId, sha256: entry.sha256, bytes: entry.bytes },
      ARCHIVE_BUNDLE_STORE_LABEL,
    );
    if (bound.kind !== "phase_snapshot") {
      return { kind: "invalid", error: new Error("bundle member kind is not phase_snapshot") };
    }
    return { kind: "valid", snapshot: bound.record };
  } catch (error) {
    return { kind: "invalid", error };
  }
}

/**
 * Enumerate EVERY archived phase snapshot from loose ∪ bundle, FAIL-SOFT. The loose
 * `archive/phases/<id>.json` files PLUS any `phase_snapshot` bundle members whose
 * loose copy is gone (loose-wins: a loose id skips its bundle copy with no
 * bind/reconcile). Each entry carries the phase id (`fileStem`) and a
 * `LoadPhaseSnapshotResult`, so a caller reuses its existing absent/invalid/valid
 * branch. NEVER throws: an unreadable loose directory, an unsafe id, and a corrupt
 * bundle STORE are soft `skipped[]`; a corrupt loose file or a failed bundle bind is
 * a per-entry `invalid` result. Deterministic order (loose sorted, then bundle-only
 * sorted) so advisory/collision reporting is environment-independent.
 */
export async function enumerateArchivedPhaseSnapshots(
  cwd: string,
): Promise<{ entries: EnumeratedPhaseSnapshot[]; skipped: PhaseSnapshotEnumSkip[] }> {
  const entries: EnumeratedPhaseSnapshot[] = [];
  const skipped: PhaseSnapshotEnumSkip[] = [];
  const looseStems = new Set<string>();
  // A phase named in a pending LOOSE-pair intent is LOGICALLY ABSENT everywhere; a
  // phase named in a pending BUNDLE-pair intent is absent from the BUNDLE side only
  // (its loose copy, if any, still resolves). Read-only; the journal is untouched.
  const { looseAbsentIds, bundleAbsentIds } = await readPendingDeleteFilters(cwd);

  // 1. Loose snapshot files.
  let names: string[] = [];
  try {
    names = await readdir(await resolveArchiveOwnedPath(cwd, archivePhasesRelDir()));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // No archive dir is the normal untouched-project state — not even an advisory.
    if (code !== "ENOENT") {
      skipped.push({
        scope: "directory",
        detail: `archive phases directory could not be read (${code ?? "unknown error"})`,
      });
    }
  }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const fileStem = basename(name, ".json");
    if (looseAbsentIds.has(fileStem)) continue; // loose-pair mid-deletion → absent
    if (!isSafePlanId(fileStem)) {
      skipped.push({ scope: "file", fileStem, detail: "unsafe archive snapshot filename" });
      continue;
    }
    looseStems.add(fileStem);
    entries.push({ fileStem, res: await loadPhaseSnapshot(cwd, fileStem) });
  }

  // 2. phase_snapshot bundle members for phases whose loose copy is gone (loose wins).
  let index: BundleMemberIndex | null = null;
  try {
    index = loadArchiveBundles(cwd).index;
  } catch (err) {
    // A corrupt bundle STORE supplies no bundle ids → soft directory-level skip,
    // NEVER thrown (the A5 fail-soft contract; the loose snapshots already read stay).
    skipped.push({
      scope: "directory",
      detail: `archive bundle store could not be read (${(err as Error).message})`,
    });
  }
  const members = index?.get("phase_snapshot");
  if (members) {
    for (const [phaseId, entry] of [...members].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (looseStems.has(phaseId)) continue; // loose wins
      if (looseAbsentIds.has(phaseId) || bundleAbsentIds.has(phaseId)) continue; // mid-deletion pair → bundle member absent
      if (!isSafePlanId(phaseId)) {
        skipped.push({ scope: "file", fileStem: phaseId, detail: "unsafe archive snapshot bundle member id" });
        continue;
      }
      entries.push({ fileStem: phaseId, res: bindBundlePhaseSnapshot(phaseId, entry) });
    }
  }

  return { entries, skipped };
}
