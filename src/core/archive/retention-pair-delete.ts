import { unlink } from "node:fs/promises";
import { gateLooseDelete, type RetentionDeleteSkipReason } from "./archive-retention.ts";
import { clearDeleteIntent, writeDeleteIntent } from "./delete-intent-journal.ts";

// ---------------------------------------------------------------------------
// Crash-safe BOTH-OR-NEITHER deletion of a loose phase_snapshot ↔ event_pack
// pair, gated like every other retention unlink and committed through the
// delete-intent journal.
//
// The sequence (see design/decisions/retention-pair-delete-journal-rfc.md):
//   gate BOTH (digest + authority) ──► write intent (COMMIT) ──► unlink pack
//   ──► unlink phase ──► clear intent
// A crash BEFORE the intent write leaves no journal → both retained. A crash
// AFTER it leaves the journal → `recoverPendingDeletes` completes both unlinks →
// both gone. So the pair is always both-deleted or both-retained, never one side.
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
 * Delete each loose phase/pack pair both-or-neither, crash-safe. Gates BOTH members
 * first; a pair is committed (its intent written) only if BOTH gate to `delete` — so
 * stale/changed bytes (`authority_changed`) and `both`/bundle-only members (whose
 * loose path is absent → `vanished`) are never committed, leaving the pair retained.
 * Then the committed pairs are written to the journal in ONE atomic intent (the
 * commit), and each pair's pack then snapshot are unlinked; a crash anywhere after
 * the commit is healed by `recoverPendingDeletes`. MUST run under the write lock,
 * AFTER `recoverPendingDeletes` has healed any prior crash.
 */
export async function deleteLoosePairsJournaled(
  cwd: string,
  pairs: LoosePairToDelete[],
  hooks: PairDeleteHooks = {},
): Promise<PairDeleteOutcome> {
  const committed: { phase_id: string; phase_sha256: string; pack_sha256: string; packAbs: string; phaseAbs: string }[] = [];
  const retained: { phase_id: string; reason: PairRetainReason }[] = [];

  // Gate BOTH members of every pair BEFORE committing anything. Both must gate to
  // `delete`, else the pair is retained whole (never half-removed).
  for (const pair of pairs) {
    const packVerdict = await gateLooseDelete(cwd, "event_pack", pair.phase_id, pair.pack_sha256);
    const phaseVerdict = await gateLooseDelete(cwd, "phase_snapshot", pair.phase_id, pair.phase_sha256);
    if (packVerdict.kind === "delete" && phaseVerdict.kind === "delete") {
      committed.push({
        phase_id: pair.phase_id,
        phase_sha256: pair.phase_sha256,
        pack_sha256: pair.pack_sha256,
        packAbs: packVerdict.abs,
        phaseAbs: phaseVerdict.abs,
      });
    } else {
      // Report the side that blocked the pair (pack first, else phase — at least one is non-delete).
      const blocker = packVerdict.kind !== "delete" ? packVerdict : phaseVerdict;
      retained.push({ phase_id: pair.phase_id, reason: retainReasonOf(blocker) });
    }
  }

  if (committed.length === 0) return { deleted: [], retained };

  // COMMIT: one atomic intent naming every committed pair. From here a crash is
  // rolled forward by recovery, not back.
  await writeDeleteIntent(
    cwd,
    committed.map((c) => ({ phase_id: c.phase_id, phase_sha256: c.phase_sha256, pack_sha256: c.pack_sha256 })),
  );
  if (hooks.afterIntentWritten) await hooks.afterIntentWritten();

  const deleted: string[] = [];
  for (const c of committed) {
    await unlinkIfPresent(c.packAbs); // pack first; either order is healed by recovery
    if (hooks.afterPackUnlinked) await hooks.afterPackUnlinked(c.phase_id);
    await unlinkIfPresent(c.phaseAbs);
    if (hooks.afterPhaseUnlinked) await hooks.afterPhaseUnlinked(c.phase_id);
    deleted.push(c.phase_id);
  }
  await clearDeleteIntent(cwd);
  return { deleted, retained };
}

async function unlinkIfPresent(abs: string): Promise<void> {
  try {
    await unlink(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
