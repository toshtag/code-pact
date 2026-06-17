import { readFile, unlink } from "node:fs/promises";
import { atomicWriteText } from "../../io/atomic-text.ts";
import { DeleteIntent, DELETE_INTENT_SCHEMA_VERSION, type DeleteIntentPair } from "../schemas/delete-intent.ts";
import { archiveDeleteIntentPath, eventPackPath, phaseSnapshotPath } from "./paths.ts";

// ---------------------------------------------------------------------------
// Retention DELETE-INTENT journal — the write-ahead log that makes a loose
// phase_snapshot ↔ event_pack pair deletion crash-safe (both-or-neither).
//
// The journal IS the commit point: once it is durably on disk (atomic temp +
// rename), the pair is logically deleted, and `recoverPendingDeletes` rolls a
// committed-but-incomplete deletion FORWARD (completes the unlinks idempotently),
// never backward — a delete intent is never rolled back. Everything before the
// journal write is a clean rollback (nothing was unlinked yet).
//
// See design/decisions/retention-pair-delete-journal-rfc.md.
// ---------------------------------------------------------------------------

/** Canonical journal bytes (the same stable/2-space/trailing-newline form every
 *  archive record writer emits). */
export function serializeDeleteIntent(intent: DeleteIntent): string {
  return JSON.stringify(intent, null, 2) + "\n";
}

/** Write (commit) the delete intent atomically — temp + rename, so a crash leaves
 *  either the old journal or the new one, never a torn file. Overwrites any
 *  existing journal (the caller owns the write lock, so there is no concurrent
 *  writer; a pre-existing journal would already have been recovered + cleared at
 *  mutation start). */
export async function writeDeleteIntent(cwd: string, pairs: DeleteIntentPair[]): Promise<void> {
  const intent: DeleteIntent = { schema_version: DELETE_INTENT_SCHEMA_VERSION, pairs };
  await atomicWriteText(archiveDeleteIntentPath(cwd), serializeDeleteIntent(intent));
}

/** Remove the journal (idempotent — an already-absent journal is success). */
export async function clearDeleteIntent(cwd: string): Promise<void> {
  try {
    await unlink(archiveDeleteIntentPath(cwd));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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
    raw = await readFile(archiveDeleteIntentPath(cwd), "utf8");
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

/** A corrupt delete-intent journal blocks recovery (and therefore the mutation
 *  it precedes) — we cannot know which pairs to finish deleting, so we refuse
 *  rather than guess. */
export class DeleteIntentRecoveryError extends Error {
  readonly code = "DELETE_INTENT_RECOVERY_FAILED" as const;
  constructor(detail: string) {
    super(detail);
    this.name = "DeleteIntentRecoveryError";
  }
}

/** Complete any committed-but-incomplete pair deletion, then clear the journal.
 *  Idempotent: an absent journal is a no-op; an already-finished pair re-unlinks
 *  to ENOENT (success). MUST run first, under the write lock, in any archive
 *  mutation — so a crashed prior run is healed before the new run plans. Returns
 *  the phase ids it completed (empty when there was no journal). Throws
 *  `DeleteIntentRecoveryError` on a corrupt journal (fail-closed). */
export async function recoverPendingDeletes(cwd: string): Promise<{ completed: string[] }> {
  const read = await readDeleteIntent(cwd);
  if (read.kind === "absent") return { completed: [] };
  if (read.kind === "corrupt") throw new DeleteIntentRecoveryError(read.detail);

  const completed: string[] = [];
  for (const pair of read.intent.pairs) {
    // Complete BOTH unlinks idempotently — the commit (the journal) already
    // decided this pair is deleted; recovery never re-gates (a skip would leave a
    // permanent half-state). ENOENT = already gone = success.
    await unlinkIfPresent(eventPackPath(cwd, pair.phase_id));
    await unlinkIfPresent(phaseSnapshotPath(cwd, pair.phase_id));
    completed.push(pair.phase_id);
  }
  await clearDeleteIntent(cwd);
  return { completed };
}

async function unlinkIfPresent(abs: string): Promise<void> {
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
