import { gateLooseDelete, type RetentionDeleteSkipReason } from "./archive-retention.ts";
import { loadArchiveBundles } from "./archive-bundle-loader.ts";
import {
  completePairsThenClear,
  PendingDeleteIntentError,
  readDeleteIntent,
  writeDeleteIntent,
} from "./delete-intent-journal.ts";

// ---------------------------------------------------------------------------
// Crash-safe BOTH-OR-NEITHER deletion of a loose phase_snapshot ↔ event_pack
// pair, gated like every other retention unlink and committed through the
// durable delete-intent journal.
//
// The sequence (see design/decisions/retention-pair-delete-journal-rfc.md):
//   recover any prior intent FIRST ──► gate BOTH (digest + authority)
//   ──► write intent (DURABLE COMMIT) ──► unlink pack ──► unlink phase
//   ──► fsync member dirs ──► clear intent
// A crash BEFORE the durable commit returns leaves no journal → both retained. A
// crash AFTER it leaves the journal → `recoverPendingDeletes` completes both
// unlinks → both gone. So the pair is always both-deleted or both-retained.
//
// FOUNDATION layer: this operation is not yet wired into `state archive-retention
// --write` (which still defers every pair). Wiring + reader-awareness ship next.
// ---------------------------------------------------------------------------

/** A loose phase/pack pair the planner decided to drop, with the per-member digests
 *  the planner captured (the gate confirms the on-disk bytes still match these). */
export type LoosePairToDelete = {
  phase_id: string;
  /** sha256 of the loose phase snapshot bytes at plan time. */
  phase_sha256: string;
  /** sha256 of the loose event pack bytes at plan time. */
  pack_sha256: string;
};

/** Why a pair was NOT committed for deletion (so it is retained whole). One of the
 *  gate's skip reasons, or `vanished` (a side was already gone at gate time). */
export type PairRetainReason = RetentionDeleteSkipReason | "vanished";

export type PairDeleteOutcome = {
  /** phase ids whose pair was fully removed (both files gone, journal cleared). */
  deleted: string[];
  /** pairs not committed — retained whole, with the reason the gate gave. */
  retained: { phase_id: string; reason: PairRetainReason }[];
};

/** Test seam: hooks fired at each crash-relevant point so a test can simulate a
 *  process death (by throwing) and then prove `recoverPendingDeletes` converges. */
export type PairDeleteHooks = {
  afterIntentWritten?: () => Promise<void> | void;
  afterPackUnlinked?: (phaseId: string) => Promise<void> | void;
  afterPhaseUnlinked?: (phaseId: string) => Promise<void> | void;
};

/** A non-`delete` gate verdict, as a retain reason. */
function retainReasonOf(verdict: { kind: "delete"; abs: string } | { kind: "vanished" } | { kind: "skip"; reason: RetentionDeleteSkipReason }): PairRetainReason {
  if (verdict.kind === "vanished") return "vanished";
  if (verdict.kind === "skip") return verdict.reason;
  return "unreadable"; // unreachable: only called for a non-`delete` blocker
}

/**
 * Delete each loose phase/pack pair both-or-neither, crash-safe. Preconditions on a
 * CLEAN journal (the caller must have run `recoverPendingDeletes` first — a pending
 * intent means a prior crash is unhealed, so we refuse rather than overwrite its
 * recovery authority). Gates BOTH members; a pair is committed (its intent written)
 * only if BOTH gate to `delete` — so stale/changed bytes (`authority_changed`) and
 * `both`/bundle-only members (loose absent → `vanished`) are never committed,
 * leaving the pair retained. The committed pairs are written to the journal in ONE
 * DURABLE atomic intent (the commit barrier), then their files are unlinked and the
 * removal made durable; a crash anywhere after the commit is healed by
 * `recoverPendingDeletes`. MUST run under the write lock.
 */
export async function deleteLoosePairsJournaled(
  cwd: string,
  pairs: LoosePairToDelete[],
  hooks: PairDeleteHooks = {},
): Promise<PairDeleteOutcome> {
  // A pending journal means a prior crash was not recovered — refuse rather than
  // overwrite its recovery authority. (Recovery is the caller's first step.)
  const pending = await readDeleteIntent(cwd);
  if (pending.kind !== "absent") throw new PendingDeleteIntentError();

  const inputIds = pairs.map((p) => p.phase_id);
  if (new Set(inputIds).size !== inputIds.length) {
    throw new Error("deleteLoosePairsJournaled: duplicate phase_id in the input pairs");
  }

  // ENFORCE the loose-only invariant the whole reader/compaction model rests on: the
  // journal must name ONLY pairs whose phase_snapshot AND event_pack are loose-only
  // (no bundle copy). A pending id with a bundle copy would (a) let the reader filter
  // wrongly hide a surviving bundle copy and (b) make the compaction loose-side filter
  // incomplete. So a member that also exists as a bundle member is a `both` case →
  // deferred to bundle-member removal, never committed here. (loadArchiveBundles
  // throws on a corrupt store → fail-closed: the whole operation aborts.)
  const bundleIndex = loadArchiveBundles(cwd).index;
  const hasBundleCopy = (id: string): boolean =>
    (bundleIndex.get("phase_snapshot")?.has(id) ?? false) || (bundleIndex.get("event_pack")?.has(id) ?? false);

  const committed: { phase_id: string; phase_sha256: string; pack_sha256: string }[] = [];
  const retained: { phase_id: string; reason: PairRetainReason }[] = [];

  // Gate BOTH members of every pair BEFORE committing anything. Both must gate to
  // `delete` AND be loose-only, else the pair is retained whole (never half-removed).
  for (const pair of pairs) {
    if (hasBundleCopy(pair.phase_id)) {
      retained.push({ phase_id: pair.phase_id, reason: "needs_bundle_member_removal" });
      continue;
    }
    const packVerdict = await gateLooseDelete(cwd, "event_pack", pair.phase_id, pair.pack_sha256);
    const phaseVerdict = await gateLooseDelete(cwd, "phase_snapshot", pair.phase_id, pair.phase_sha256);
    if (packVerdict.kind === "delete" && phaseVerdict.kind === "delete") {
      committed.push({ phase_id: pair.phase_id, phase_sha256: pair.phase_sha256, pack_sha256: pair.pack_sha256 });
    } else {
      // Report the side that blocked the pair (pack first, else phase — at least one is non-delete).
      const blocker = packVerdict.kind !== "delete" ? packVerdict : phaseVerdict;
      retained.push({ phase_id: pair.phase_id, reason: retainReasonOf(blocker) });
    }
  }

  if (committed.length === 0) return { deleted: [], retained };

  // DURABLE COMMIT: one atomic intent naming every committed pair, fsynced to stable
  // storage before any unlink. From here a crash is rolled forward by recovery.
  await writeDeleteIntent(cwd, committed);
  if (hooks.afterIntentWritten) await hooks.afterIntentWritten();

  // Complete the deletes durably (unlink both members of each pair, fsync, clear).
  await completePairsThenClear(
    cwd,
    committed.map((c) => c.phase_id),
    { afterPackUnlinked: hooks.afterPackUnlinked, afterPhaseUnlinked: hooks.afterPhaseUnlinked },
  );
  return { deleted: committed.map((c) => c.phase_id), retained };
}
