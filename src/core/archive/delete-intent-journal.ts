import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DeleteIntent, DELETE_INTENT_SCHEMA_VERSION, type BundlePairIntent, type DeleteIntentRecord } from "../schemas/delete-intent.ts";
import { archiveBundlesDir, archiveDeleteIntentPath, archiveEventPacksDir, archivePhasesDir, eventPackPath, phaseSnapshotPath, sha256Hex } from "./paths.ts";

// ---------------------------------------------------------------------------
// Retention DELETE-INTENT journal — a durable write-ahead log that makes a loose
// phase_snapshot ↔ event_pack pair deletion crash-safe (both-or-neither), even
// across power loss / OS crash (not just a thrown error / SIGKILL).
//
// The COMMIT BARRIER is `writeDeleteIntent`: write the journal to a temp file →
// **fsync the temp file's data** → refuse if a journal already exists → rename →
// **fsync the parent directory** (so the rename itself is durable). Every one of
// those fsyncs is a REQUIRED barrier: a FAILED fsync is fail-closed (throws
// `DeleteIntentDurabilityError`), never swallowed — a swallowed parent-dir fsync
// failure would let the commit "succeed" while the rename is not durable, and the
// later unlinks would reintroduce the half-state this journal exists to prevent.
//
// Only when `writeDeleteIntent` returns is the intent on stable storage — and the
// operation issues every unlink AFTER it returns. So the ordering "commit durable
// ≤ any unlink durable" holds: a power loss that lost the commit also lost every
// unlink, so the worst observable state is BOTH retained, never one side.
//
// `DeleteIntentDurabilityError.cause` separates a platform that cannot fsync a
// directory at all (`unsupported`, e.g. Windows) from a real I/O failure on a
// platform that can (`failed`). The wiring layer refuses the durable pair-delete
// path on `unsupported` (pairs stay deferred there) and fails the run on `failed`.
//
// See design/decisions/retention-pair-delete-journal-rfc.md.
// ---------------------------------------------------------------------------

/** Canonical journal bytes (the same stable/2-space/trailing-newline form every
 *  archive record writer emits). */
export function serializeDeleteIntent(intent: DeleteIntent): string {
  return JSON.stringify(intent, null, 2) + "\n";
}

/** A new delete cannot start while a prior intent is still on disk — that journal
 *  is an un-recovered commit, and overwriting it would lose the authority to finish
 *  (or roll back) the prior pair. The caller must run `recoverPendingDeletes` first. */
export class PendingDeleteIntentError extends Error {
  readonly code = "PENDING_DELETE_INTENT" as const;
  constructor() {
    super("a delete-intent journal already exists; run recoverPendingDeletes before starting a new pair delete");
    this.name = "PendingDeleteIntentError";
  }
}

/** A REQUIRED durability barrier failed. `reason`: `unsupported` = the platform
 *  cannot fsync a directory (the durable pair-delete path is not available there);
 *  `failed` = a real I/O failure on a platform that can. Never swallowed. */
export class DeleteIntentDurabilityError extends Error {
  readonly code = "DELETE_INTENT_DURABILITY_FAILED" as const;
  constructor(
    readonly reason: "unsupported" | "failed",
    detail: string,
  ) {
    super(detail);
    this.name = "DeleteIntentDurabilityError";
  }
}

// Directory fsync — the barrier that makes a rename/unlink within a directory
// durable — is unavailable on Windows (a directory cannot be opened for fsync).
const DIRECTORY_FSYNC_SUPPORTED = process.platform !== "win32";

// Test seam (failure injection): override the directory-fsync barrier so a test can
// prove the operation fails closed when a barrier fails. `null` = the real barrier.
let dirFsyncOverride: ((dir: string, purpose: string) => Promise<void> | void) | null = null;
export function __setDeleteIntentDirFsyncForTests(fn: ((dir: string, purpose: string) => Promise<void> | void) | null): void {
  dirFsyncOverride = fn;
}

/** fsync a directory so a rename/unlink within it is durable — a REQUIRED WAL
 *  barrier. Throws `DeleteIntentDurabilityError` on ANY failure (never swallowed):
 *  `unsupported` on a platform that cannot fsync a directory, `failed` on a real
 *  I/O error (`EIO` / `ENOSPC` / permission / handle failure). */
export async function fsyncDirRequired(dir: string, purpose: string): Promise<void> {
  if (dirFsyncOverride) {
    await dirFsyncOverride(dir, purpose);
    return;
  }
  if (!DIRECTORY_FSYNC_SUPPORTED) {
    throw new DeleteIntentDurabilityError("unsupported", `directory fsync is unsupported on ${process.platform} (${purpose})`);
  }
  let dh;
  try {
    dh = await open(dir, "r");
  } catch (err) {
    throw new DeleteIntentDurabilityError("failed", `cannot open directory for fsync (${purpose}, ${dir}): ${(err as Error).message}`);
  }
  try {
    await dh.sync();
  } catch (err) {
    throw new DeleteIntentDurabilityError("failed", `directory fsync failed (${purpose}, ${dir}): ${(err as Error).message}`);
  } finally {
    await dh.close();
  }
}

// Test seam (failure injection) for the FILE DATA fsync — separate from the dir seam
// so a test can fail a file barrier without touching directory barriers. `null` = real.
let fileFsyncOverride: ((purpose: string) => Promise<void> | void) | null = null;
export function __setDeleteIntentFileFsyncForTests(fn: ((purpose: string) => Promise<void> | void) | null): void {
  fileFsyncOverride = fn;
}

/** fsync a FILE's DATA so its contents are durable — a REQUIRED barrier, distinct
 *  from `fsyncDirRequired` (which only makes a directory entry / rename / unlink
 *  durable, NOT the bytes inside a file). Throws `DeleteIntentDurabilityError("failed")`
 *  on any I/O failure (never swallowed). Unlike a directory fsync this is supported on
 *  every platform (fsync of a regular file), so there is no `unsupported` case. */
export async function fsyncFileRequired(fh: FileHandle, purpose: string): Promise<void> {
  if (fileFsyncOverride) {
    await fileFsyncOverride(purpose);
    return;
  }
  try {
    await fh.sync();
  } catch (err) {
    throw new DeleteIntentDurabilityError("failed", `file fsync failed (${purpose}): ${(err as Error).message}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    const fh = await open(path, "r");
    await fh.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** LOW-LEVEL journal primitive: durably write (commit) the delete intent — the WAL
 *  barrier. fsyncs the temp data AND the parent directory (both required; a failure
 *  throws). Refuses to overwrite an existing journal (`PendingDeleteIntentError`).
 *  Rejects duplicate `phase_id`s.
 *
 *  DO NOT call this directly to delete archive records. The production retention
 *  delete is `deleteLoosePairsJournaled`, which enforces the load-bearing authority
 *  this primitive does NOT: gating each member's bytes, and the LOOSE-ONLY invariant
 *  (refusing a pair with a bundle copy) that the reader-awareness + compaction
 *  filters depend on. A direct caller that journaled a non-loose-only / ungated pair
 *  would silently break those filters. */
export async function writeDeleteIntent(cwd: string, intents: DeleteIntentRecord[]): Promise<void> {
  const ids = intents.map((i) => i.phase_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("delete-intent journal must not name a phase_id twice"); // a phase is one pair (loose XOR bundle), never two
  }
  const intent: DeleteIntent = { schema_version: DELETE_INTENT_SCHEMA_VERSION, intents };
  const content = serializeDeleteIntent(intent);
  const path = archiveDeleteIntentPath(cwd);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // PREFLIGHT the directory durability barrier BEFORE writing anything: if the platform
  // cannot fsync a directory (`unsupported`) or the dir fsync fails (`failed`), abort HERE
  // so the journal is NEVER left on disk. (A barrier failure only AFTER the rename would
  // leave a committed journal that the next run's recovery completes — silently deleting a
  // pair the caller was told was deferred. The preflight makes `unsupported` mean "no
  // journal", so the caller's defer is honest.)
  await fsyncDirRequired(dir, "commit");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;

  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync(); // MANDATORY: fsync the data before it can be renamed into place
  } catch (err) {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw new DeleteIntentDurabilityError("failed", `delete-intent temp write/fsync failed: ${(err as Error).message}`);
  }
  try {
    await fh.close(); // a close failure after fsync is still a durability fault (the data may not be flushed)
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new DeleteIntentDurabilityError("failed", `delete-intent temp close failed: ${(err as Error).message}`);
  }
  try {
    // Never clobber an existing journal (an un-recovered prior commit). Under the
    // write lock there is no concurrent creator, so this check is race-free in
    // practice; rename(2) would otherwise silently replace.
    if (await pathExists(path)) throw new PendingDeleteIntentError();
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  // REQUIRED: make the rename (the commit) durable. A failure here throws BEFORE
  // the caller unlinks anything — the journal stays on disk (a possibly-durable
  // commit) for recovery to complete; the caller never proceeds to unlink.
  await fsyncDirRequired(dir, "commit");
}

/** Remove the journal durably (idempotent — an already-absent journal is success):
 *  unlink the file, then fsync the directory (required) so the removal survives
 *  power loss. */
export async function clearDeleteIntent(cwd: string): Promise<void> {
  const path = archiveDeleteIntentPath(cwd);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return; // already gone — nothing to make durable
  }
  await fsyncDirRequired(dirname(path), "clear");
}

/** The journal as read from disk: absent (the normal steady state), present (a
 *  prior run committed and may not have finished), or corrupt — fail-closed, never
 *  silently ignored, since ignoring would skip recovery and leave a half-deleted
 *  pair. `cause` separates a transient/permissions read failure (`io_error` — the
 *  journal may be intact but currently unreadable) from genuinely mangled content
 *  (`parse_error`, which also covers a schema-valid but duplicate-id journal). */
export type DeleteIntentRead =
  | { kind: "absent" }
  | { kind: "present"; intent: DeleteIntent }
  | { kind: "corrupt"; cause: "io_error" | "parse_error"; detail: string };

export async function readDeleteIntent(cwd: string): Promise<DeleteIntentRead> {
  let raw: string;
  try {
    const fh = await open(archiveDeleteIntentPath(cwd), "r");
    try {
      raw = await fh.readFile("utf8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "corrupt", cause: "io_error", detail: `delete-intent journal unreadable: ${(err as Error).message}` };
  }
  let intent: DeleteIntent;
  try {
    intent = DeleteIntent.parse(JSON.parse(raw));
  } catch (err) {
    return { kind: "corrupt", cause: "parse_error", detail: `delete-intent journal is not a valid intent: ${(err as Error).message}` };
  }
  // The journal is a recovery AUTHORITY: parse-able is not enough. Require the exact
  // CANONICAL bytes the writer emits — a hand-edited / non-canonical journal (extra
  // whitespace, reordered keys) is not a form the writer produces, so don't trust it.
  if (raw !== serializeDeleteIntent(intent)) {
    return { kind: "corrupt", cause: "parse_error", detail: "delete-intent journal is not the writer's canonical bytes" };
  }
  // A duplicate phase_id is schema-valid but a malformed recovery authority (the
  // writer never emits one). Treat it as corrupt — fail-closed rather than guess.
  const ids = intent.intents.map((i) => i.phase_id);
  if (new Set(ids).size !== ids.length) {
    return { kind: "corrupt", cause: "parse_error", detail: "delete-intent journal names a phase_id more than once" };
  }
  return { kind: "present", intent };
}

/** The phase_ids a PENDING LOOSE-pair intent names — each is a loose
 *  phase_snapshot ↔ event_pack pair mid-deletion that READERS must treat as
 *  logically absent (loose AND bundle, since a loose-pair member is loose-ONLY by
 *  the delete invariant), so `validate` / `plan lint` / `doctor` never observe the
 *  half-deleted intermediate. An absent OR CORRUPT journal → empty set (readers
 *  cannot tell which records are pending, so they hide none — the corruption
 *  surfaces by recovery being blocked on the next mutation, never silently honoured
 *  as a reader filter). READ-ONLY: a reader never mutates or clears the journal. */
export async function readPendingDeleteIds(cwd: string): Promise<ReadonlySet<string>> {
  const read = await readDeleteIntent(cwd);
  if (read.kind !== "present") return new Set();
  return new Set(read.intent.intents.filter((i) => i.intent_kind === "loose_pair").map((i) => i.phase_id));
}

/** The member ids a PENDING BUNDLE-pair intent names — each is a bundle member
 *  mid-removal whose OLD bundle still physically holds it until the retire is
 *  durable. Readers must treat these as logically absent from BUNDLE resolution
 *  ONLY (the INVERSE of the loose filter): a `both` record's surviving LOOSE copy
 *  must still resolve (the removal is `bundle_member_removed`, not `deleted`). The
 *  id names both the phase_snapshot and the event_pack member of the pair, so a
 *  single flat set suffices (it is hidden from both kinds' bundle resolution). An
 *  absent OR CORRUPT journal → empty set (same reasoning as the loose filter).
 *  READ-ONLY. */
export async function readPendingBundleDeleteIds(cwd: string): Promise<ReadonlySet<string>> {
  return (await readPendingDeleteFilters(cwd)).bundleAbsentIds;
}

/** Both reader-awareness filters from ONE journal read, for the readers that consult
 *  loose AND bundle: `looseAbsentIds` (loose-pair ids → absent everywhere) and
 *  `bundleAbsentIds` (bundle-pair ids → absent from BUNDLE resolution only). An absent
 *  / corrupt journal → both empty. READ-ONLY. */
export type PendingDeleteFilters = {
  looseAbsentIds: ReadonlySet<string>;
  bundleAbsentIds: ReadonlySet<string>;
};
export async function readPendingDeleteFilters(cwd: string): Promise<PendingDeleteFilters> {
  const read = await readDeleteIntent(cwd);
  if (read.kind !== "present") return { looseAbsentIds: new Set(), bundleAbsentIds: new Set() };
  const looseAbsentIds = new Set<string>();
  const bundleAbsentIds = new Set<string>();
  for (const intent of read.intent.intents) {
    if (intent.intent_kind === "loose_pair") {
      looseAbsentIds.add(intent.phase_id);
    } else {
      for (const id of intent.members.phase_snapshot.removed_ids) bundleAbsentIds.add(id);
      for (const id of intent.members.event_pack.removed_ids) bundleAbsentIds.add(id);
    }
  }
  return { looseAbsentIds, bundleAbsentIds };
}

/** A corrupt delete-intent journal blocks recovery (and therefore the mutation it
 *  precedes) — we cannot know which pairs to finish deleting, so we refuse rather
 *  than guess. */
export class DeleteIntentRecoveryError extends Error {
  readonly code = "DELETE_INTENT_RECOVERY_FAILED" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "DeleteIntentRecoveryError";
  }
}

/** Test seam for the unlink phase (so the live delete can simulate a crash between
 *  the two unlinks). Recovery passes none. */
export type PairUnlinkHooks = {
  afterPackUnlinked?: (phaseId: string) => Promise<void> | void;
  afterPhaseUnlinked?: (phaseId: string) => Promise<void> | void;
};

/** Unlink both LOOSE members of every committed loose pair (idempotent — ENOENT is
 *  success) and make the unlinks durable (fsync the member dirs — REQUIRED, a
 *  failure throws and the journal is left for recovery). Does NOT clear the journal
 *  (a mixed run may still have bundle retires to complete). Shared by the live loose
 *  delete and recovery so they cannot drift. */
async function completeLoosePairUnlinks(cwd: string, phaseIds: string[], hooks: PairUnlinkHooks = {}): Promise<void> {
  if (phaseIds.length === 0) return;
  for (const phaseId of phaseIds) {
    await unlinkIfPresent(eventPackPath(cwd, phaseId)); // pack first; either order is healed by recovery
    if (hooks.afterPackUnlinked) await hooks.afterPackUnlinked(phaseId);
    await unlinkIfPresent(phaseSnapshotPath(cwd, phaseId));
    if (hooks.afterPhaseUnlinked) await hooks.afterPhaseUnlinked(phaseId);
  }
  // REQUIRED: make the unlinks durable BEFORE the journal is cleared, so a power loss
  // after the clear cannot resurrect a member with no journal to re-delete it.
  await fsyncDirRequired(archiveEventPacksDir(cwd), "event_packs");
  await fsyncDirRequired(archivePhasesDir(cwd), "phases");
}

/** Complete a committed LOOSE batch then clear the journal durably. The live loose
 *  delete commits ONLY loose pairs, so this is its completion path; recovery, which
 *  may face a MIXED journal, drives the lower primitives directly. */
export async function completePairsThenClear(cwd: string, phaseIds: string[], hooks: PairUnlinkHooks = {}): Promise<void> {
  await completeLoosePairUnlinks(cwd, phaseIds, hooks);
  await clearDeleteIntent(cwd);
}

/** A bundle-pair intent cannot be committed because the store no longer matches the
 *  plan (an old bundle / survivor bundle is missing or its bytes changed since the plan).
 *  Thrown BEFORE the durable commit so NO journal is written — the run fails closed and a
 *  re-plan can decide afresh. (Detecting this only AFTER the commit would durably write an
 *  intent recovery can never complete — a permanent wedge.) */
export class BundlePairNotCommittableError extends Error {
  readonly code = "BUNDLE_PAIR_NOT_COMMITTABLE" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "BundlePairNotCommittableError";
  }
}

/** PRE-COMMIT reverify: every old bundle the intent will retire must still EXIST and match
 *  its committed digest, and every non-null survivor bundle must EXIST and match its committed
 *  digest. Read-only. Throws `BundlePairNotCommittableError` on any miss/mismatch, BEFORE the
 *  journal is written — so the journal only ever names a pair whose retires recovery can complete
 *  (the digest gate in `completeBundlePairRetires` then never fails on a committed intent). Run
 *  immediately before `writeDeleteIntent`, when nothing has been retired yet (so EVERY old bundle
 *  must be present — unlike recovery, which tolerates an already-retired ENOENT). */
export async function assertBundlePairsCommittable(cwd: string, pairs: BundlePairIntent[]): Promise<void> {
  const dir = archiveBundlesDir(cwd);
  const readMatch = async (file: string, expected: string, what: string): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(join(dir, basename(file)), "utf8");
    } catch (err) {
      throw new BundlePairNotCommittableError(`${what} ${file} is missing before commit: ${(err as Error).message}`);
    }
    if (sha256Hex(raw) !== expected) {
      throw new BundlePairNotCommittableError(`${what} ${file} changed before commit (digest no longer matches the plan)`);
    }
  };
  for (const pair of pairs) {
    for (const kind of ["phase_snapshot", "event_pack"] as const) {
      const member = pair.members[kind];
      if (member.new_bundle != null) await readMatch(member.new_bundle.file, member.new_bundle.sha256, `survivor bundle (${kind}, ${pair.phase_id})`);
      for (const old of member.old_bundles) await readMatch(old.file, old.sha256, `old bundle (${kind}, ${pair.phase_id})`);
    }
  }
}

/** Test seam for the bundle-pair retire phase (so the live bundle delete can simulate
 *  a crash between the two old-bundle unlinks). Recovery passes none. */
export type BundlePairRetireHooks = {
  beforeRetire?: (file: string) => Promise<void> | void;
};

/** Retire the old bundle(s) of every committed BUNDLE pair, idempotent + fail-closed.
 *  For each kind, BEFORE unlinking an old bundle it RE-DERIVES the survivor authority
 *  from disk: the reduced new bundle must still exist with the committed bytes digest
 *  (or the empty-set marker holds), and the old bundle must still match its committed
 *  digest. An already-gone old bundle (ENOENT) is a completed retire (idempotent). A
 *  digest mismatch / a vanished survivor bundle → fail-closed `DeleteIntentRecoveryError`
 *  (the store changed unexpectedly — never retire on an unrecognised proof). Does NOT
 *  clear the journal. Shared by the live bundle delete and recovery so they cannot drift. */
async function completeBundlePairRetires(cwd: string, pairs: BundlePairIntent[], hooks: BundlePairRetireHooks = {}): Promise<void> {
  if (pairs.length === 0) return;
  const dir = archiveBundlesDir(cwd);
  let retiredAny = false;
  for (const pair of pairs) {
    for (const kind of ["phase_snapshot", "event_pack"] as const) {
      const member = pair.members[kind];
      // 1. The survivor authority must be durable + intact on disk BEFORE we retire the
      //    old authority that still holds the removed member. (Empty-set → no survivors.)
      if (member.new_bundle != null) {
        const newPath = join(dir, member.new_bundle.file);
        let newRaw: string;
        try {
          newRaw = await readFile(newPath, "utf8");
        } catch (err) {
          throw new DeleteIntentRecoveryError(`bundle-pair recovery: survivor bundle ${member.new_bundle.file} missing before retiring ${kind} for ${pair.phase_id}: ${(err as Error).message}`);
        }
        if (sha256Hex(newRaw) !== member.new_bundle.sha256) {
          throw new DeleteIntentRecoveryError(`bundle-pair recovery: survivor bundle ${member.new_bundle.file} does not match the committed digest (${kind}, ${pair.phase_id})`);
        }
      }
      // 2. Retire each old bundle through the expected-bytes gate (delete exactly the
      //    committed bytes); an already-gone old bundle is a completed retire.
      for (const old of member.old_bundles) {
        if (hooks.beforeRetire) await hooks.beforeRetire(old.file);
        const oldPath = join(dir, basename(old.file));
        let oldRaw: string;
        try {
          oldRaw = await readFile(oldPath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // already retired — idempotent
          throw err;
        }
        if (sha256Hex(oldRaw) !== old.sha256) {
          throw new DeleteIntentRecoveryError(`bundle-pair recovery: old bundle ${old.file} no longer matches the committed digest (${kind}, ${pair.phase_id}) — refusing to retire an unrecognised bundle`);
        }
        await unlink(oldPath);
        retiredAny = true;
      }
    }
  }
  // REQUIRED: make the retires durable BEFORE the journal is cleared.
  if (retiredAny) await fsyncDirRequired(dir, "bundle_retire");
}

/** Complete a committed BUNDLE batch (retire the old bundles) then clear the journal.
 *  The live bundle delete commits ONLY bundle pairs, so this is its completion path. */
export async function completeBundlePairsThenClear(cwd: string, pairs: BundlePairIntent[], hooks: BundlePairRetireHooks = {}): Promise<void> {
  await completeBundlePairRetires(cwd, pairs, hooks);
  await clearDeleteIntent(cwd);
}

/** Complete any committed-but-incomplete pair deletion (loose unlinks AND bundle
 *  retires), then clear the journal. Idempotent: an absent journal is a no-op; an
 *  already-finished member re-unlinks/re-retires to ENOENT (success). MUST run first,
 *  under the write lock, in any archive mutation — so a crashed prior run is healed
 *  before the new run plans. Returns the phase ids it completed. Throws
 *  `DeleteIntentRecoveryError` on a corrupt journal or a failed bundle re-verify. */
export async function recoverPendingDeletes(cwd: string): Promise<{ completed: string[] }> {
  const read = await readDeleteIntent(cwd);
  if (read.kind === "absent") return { completed: [] };
  if (read.kind === "corrupt") throw new DeleteIntentRecoveryError(read.detail);
  // Recovery never re-gates a loose pair — the commit already decided it is deleted; a
  // skip would leave a permanent half-state. A bundle pair DOES re-verify the on-disk
  // survivor/old digests (it is destroying bundle authority, not a loose file).
  const loosePhaseIds: string[] = [];
  const bundlePairs: BundlePairIntent[] = [];
  for (const intent of read.intent.intents) {
    if (intent.intent_kind === "loose_pair") loosePhaseIds.push(intent.phase_id);
    else bundlePairs.push(intent);
  }
  await completeLoosePairUnlinks(cwd, loosePhaseIds);
  await completeBundlePairRetires(cwd, bundlePairs);
  await clearDeleteIntent(cwd); // one clear after BOTH kinds are durably complete
  return { completed: read.intent.intents.map((i) => i.phase_id) };
}

async function unlinkIfPresent(abs: string): Promise<void> {
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
