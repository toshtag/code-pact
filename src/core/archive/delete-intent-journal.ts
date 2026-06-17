import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { DeleteIntent, DELETE_INTENT_SCHEMA_VERSION, type DeleteIntentPair } from "../schemas/delete-intent.ts";
import { archiveDeleteIntentPath, archiveEventPacksDir, archivePhasesDir, eventPackPath, phaseSnapshotPath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Retention DELETE-INTENT journal — a durable write-ahead log that makes a loose
// phase_snapshot ↔ event_pack pair deletion crash-safe (both-or-neither), even
// across power loss / OS crash (not just a thrown error / SIGKILL).
//
// The COMMIT BARRIER is `writeDeleteIntent`: it writes the journal to a temp file,
// **fsyncs the temp file's data**, renames it into place, then **fsyncs the parent
// directory** so the rename itself is durable. Only when it returns is the intent
// on stable storage. The caller MUST issue every destructive unlink AFTER it
// returns — so the ordering "commit durable ≤ any unlink durable" holds, and a
// power loss can never leave an unlinked member with no journal to recover it.
//   - crash BEFORE the commit returns → no durable journal AND no unlink yet → both
//     retained (clean rollback).
//   - crash AFTER the commit returns → the journal is durable → recovery completes
//     both unlinks idempotently → both gone.
// So the pair is always both-deleted or both-retained, never one side.
//
// (Durability is to the extent the platform's `fsync` guarantees. The DIRECTORY
// fsync is best-effort — some platforms cannot fsync a directory; there the
// rename's durability is the platform's concern. The data fsync on the temp file
// is mandatory.)
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

/** fsync a directory so a rename/unlink within it is durable. Best-effort: some
 *  platforms cannot open a directory for fsync — there the operation's durability
 *  is the platform's concern, not something we can force. */
async function fsyncDir(dir: string): Promise<void> {
  let dh;
  try {
    dh = await open(dir, "r");
  } catch {
    return; // cannot open the directory (e.g. Windows) — skip
  }
  try {
    await dh.sync();
  } catch {
    // platform/filesystem does not support directory fsync — best-effort
  } finally {
    await dh.close();
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

/** Durably write (commit) the delete intent — the WAL barrier. Refuses to overwrite
 *  an existing journal (`PendingDeleteIntentError`): a present journal is an
 *  un-recovered prior commit. Rejects duplicate `phase_id`s. */
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
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;

  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync(); // fsync the data BEFORE it can be renamed into place
  } finally {
    await fh.close();
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
  await fsyncDir(dir); // make the rename (the commit) durable
}

/** Remove the journal durably (idempotent — an already-absent journal is success):
 *  unlink the file, then fsync the directory so the removal survives power loss. */
export async function clearDeleteIntent(cwd: string): Promise<void> {
  const path = archiveDeleteIntentPath(cwd);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return; // already gone — nothing to make durable
  }
  await fsyncDir(dirname(path));
}

/** The journal as read from disk: absent (the normal steady state), present (a
 *  prior run committed and may not have finished), or corrupt — fail-closed, never
 *  silently ignored, since ignoring would skip recovery and leave a half-deleted
 *  pair. `cause` separates a transient/permissions read failure (`io_error` — the
 *  journal may be intact but currently unreadable) from genuinely mangled content
 *  (`parse_error`), so an operator looks in the right place. */
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
  try {
    return { kind: "present", intent: DeleteIntent.parse(JSON.parse(raw)) };
  } catch (err) {
    return { kind: "corrupt", cause: "parse_error", detail: `delete-intent journal is not a valid intent: ${(err as Error).message}` };
  }
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
 *  ENOENT is success), make the unlinks durable (fsync the member dirs) so "both
 *  gone" is on stable storage, THEN clear the journal durably. Shared by the live
 *  delete and recovery so they cannot drift. Throwing in a hook leaves the journal
 *  in place (recovery will re-run this), so an interrupted unlink is healed. */
export async function completePairsThenClear(cwd: string, phaseIds: string[], hooks: PairUnlinkHooks = {}): Promise<void> {
  for (const phaseId of phaseIds) {
    await unlinkIfPresent(eventPackPath(cwd, phaseId)); // pack first; either order is healed by recovery
    if (hooks.afterPackUnlinked) await hooks.afterPackUnlinked(phaseId);
    await unlinkIfPresent(phaseSnapshotPath(cwd, phaseId));
    if (hooks.afterPhaseUnlinked) await hooks.afterPhaseUnlinked(phaseId);
  }
  // Make the unlinks durable BEFORE removing the commit record, so a power loss
  // after the clear cannot resurrect a member with no journal to re-delete it.
  await fsyncDir(archiveEventPacksDir(cwd));
  await fsyncDir(archivePhasesDir(cwd));
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
