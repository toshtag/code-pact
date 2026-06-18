import { mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { DeleteIntent, DELETE_INTENT_SCHEMA_VERSION, type DeleteIntentPair } from "../schemas/delete-intent.ts";
import { archiveDeleteIntentPath, archiveEventPacksDir, archivePhasesDir, eventPackPath, phaseSnapshotPath } from "./paths.ts";

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
export async function writeDeleteIntent(cwd: string, pairs: DeleteIntentPair[]): Promise<void> {
  const ids = pairs.map((p) => p.phase_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("delete-intent journal must not name a phase_id twice");
  }
  const intent: DeleteIntent = { schema_version: DELETE_INTENT_SCHEMA_VERSION, pairs };
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
  const ids = intent.pairs.map((p) => p.phase_id);
  if (new Set(ids).size !== ids.length) {
    return { kind: "corrupt", cause: "parse_error", detail: "delete-intent journal names a phase_id more than once" };
  }
  return { kind: "present", intent };
}

/** The set of phase_ids a PENDING delete-intent journal names — each is a
 *  phase_snapshot ↔ event_pack pair mid-deletion that READERS must treat as
 *  logically absent (until recovery completes it), so `validate` / `plan lint` /
 *  `doctor` never observe the half-deleted intermediate. An absent journal → empty
 *  set. A CORRUPT journal → empty set: readers cannot tell which records are
 *  pending, so they hide none — the corruption surfaces by recovery being blocked
 *  on the next mutation, never silently honoured as a reader filter. READ-ONLY: a
 *  reader never mutates or clears the journal (the journal is the recovery
 *  authority; only `recoverPendingDeletes`, under the write lock, may complete it). */
export async function readPendingDeleteIds(cwd: string): Promise<ReadonlySet<string>> {
  const read = await readDeleteIntent(cwd);
  if (read.kind !== "present") return new Set();
  return new Set(read.intent.pairs.map((p) => p.phase_id));
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

/** Complete a committed batch: unlink both members of every pair (idempotent —
 *  ENOENT is success), make the unlinks durable (fsync the member dirs — REQUIRED,
 *  a failure throws and the journal is NOT cleared), THEN clear the journal durably.
 *  Shared by the live delete and recovery so they cannot drift. Throwing in a hook
 *  or a barrier leaves the journal in place (recovery re-runs this), so an
 *  interrupted/failed unlink is healed. */
export async function completePairsThenClear(cwd: string, phaseIds: string[], hooks: PairUnlinkHooks = {}): Promise<void> {
  for (const phaseId of phaseIds) {
    await unlinkIfPresent(eventPackPath(cwd, phaseId)); // pack first; either order is healed by recovery
    if (hooks.afterPackUnlinked) await hooks.afterPackUnlinked(phaseId);
    await unlinkIfPresent(phaseSnapshotPath(cwd, phaseId));
    if (hooks.afterPhaseUnlinked) await hooks.afterPhaseUnlinked(phaseId);
  }
  // REQUIRED: make the unlinks durable BEFORE removing the commit record, so a
  // power loss after the clear cannot resurrect a member with no journal to
  // re-delete it. A barrier failure throws → the journal is not cleared → recovery.
  await fsyncDirRequired(archiveEventPacksDir(cwd), "event_packs");
  await fsyncDirRequired(archivePhasesDir(cwd), "phases");
  await clearDeleteIntent(cwd);
}

/** Complete any committed-but-incomplete pair deletion, then clear the journal.
 *  Idempotent: an absent journal is a no-op; an already-finished pair re-unlinks to
 *  ENOENT (success). MUST run first, under the write lock, in any archive mutation
 *  — so a crashed prior run is healed before the new run plans. Returns the phase
 *  ids it completed (empty when there was no journal). Throws
 *  `DeleteIntentRecoveryError` on a corrupt journal (fail-closed). */
export async function recoverPendingDeletes(cwd: string): Promise<{ completed: string[] }> {
  const read = await readDeleteIntent(cwd);
  if (read.kind === "absent") return { completed: [] };
  if (read.kind === "corrupt") throw new DeleteIntentRecoveryError(read.detail);
  // Recovery never re-gates — the commit (the journal) already decided this pair is
  // deleted; a skip would leave a permanent half-state. Re-validation was at commit.
  const phaseIds = read.intent.pairs.map((p) => p.phase_id);
  await completePairsThenClear(cwd, phaseIds);
  return { completed: phaseIds };
}

async function unlinkIfPresent(abs: string): Promise<void> {
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
