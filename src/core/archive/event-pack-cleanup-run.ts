// ---------------------------------------------------------------------------
// Event-pack compaction LAYER 3 — the destructive cleanup. This module has TWO
// parts that live together:
//
//   1. `unlinkGatedLoose` — the interleaved delete-time gate + unlink LOOP, the ONLY
//      place an event-pack-compaction `unlink` happens. For each candidate loose file
//      it re-runs the merged delete-time gate (`evaluateDeleteGate`) IMMEDIATELY
//      before the unlink — never a batch decision, so a change since the plan (a
//      reappearing live owner, a swapped file, a vanished file) is caught right at the
//      irreversible step (TOCTOU). A file is removed ONLY when every G1–G8 check
//      passes; a global safety gate (G6 live owner / G7 pack missing / G8 snapshot
//      diverged) ABORTS the whole loop, unlinking no further files.
//   2. `runEventPackCleanup` (+ the pure `buildPostLoopOutcome`) — the orchestrator:
//      prepare (G0) → optional cell-10 pack write → the unlink loop → post-run R0–R5
//      reconciliation → the public `CleanupOutcome`. WIRED into `runStateCompact`/CLI —
//      `state compact --write` calls it; it is the first reachable destructive path.
//
// CALLER CONTRACT for the loop / orchestrator: hold the write lock; the orchestrator
// builds the gate `ctx` + `target` UNDER THAT LOCK from a verified G0 re-plan (a bound
// pack covering the snapshot) — NEVER from the dry-run `planLooseCleanup` cross-read.
// ---------------------------------------------------------------------------

import { unlinkOwned } from "../project-fs/operations.ts";
import { archiveDeletePath } from "../project-fs/authorities/archive-authority.ts";
import {
  evaluateDeleteGate,
  looseEventRelPath,
  prepareLooseCleanup,
  type DeleteGateContext,
  type DeleteGateAbortReason,
  type PrepareLooseCleanupHooks,
} from "./event-pack-cleanup-gate.ts";
import {
  planEventPack,
  applyEventPackPlan,
  EventPackWriteError,
  type ApplyEventPackHooks,
  type EventPackBlock,
} from "./event-pack.ts";
import {
  reconcileSurvivors,
  type ReconcileSurvivorsHooks,
  type LooseCleanupReconciliation,
} from "./event-pack-cleanup-reconcile.ts";
import type {
  CleanupSkip,
  CleanupOutcome,
  CleanupMutationProgress,
} from "./event-pack-cleanup.ts";

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** The raw tallies of one gated-unlink pass over a target set. The R0–R5
 *  reconciliation (Layer 3b-2b-2b) turns this + a post-run disk re-enumeration into
 *  the public `CleanupOutcome`; this loop only reports what IT did, in order. */
export type UnlinkGatedLooseResult = {
  /** Files actually removed (every G1–G8 check passed for them). */
  deleted: string[];
  /** Files already gone at gate time, OR that raced to ENOENT at the unlink — not
   *  survivors, not removed by us. */
  vanished: string[];
  /** Files a per-file gate could not clear — still present, with the reason. */
  skipped: CleanupSkip[];
  /** A global gate abort (G6/G7/G8) that STOPPED the loop, or null if it ran to the
   *  end. `path` is the project-relative path of the aborting file (matches the
   *  dry-run `LooseCleanupAbort` shape, for the mapper / human diagnostics). On
   *  abort, `deleted` holds the files removed BEFORE the aborting file. */
  abort: { path: string; reason: DeleteGateAbortReason; detail: string } | null;
};

/** Test seams to inject a TOCTOU change at the two windows the loop must survive. */
export type UnlinkGatedLooseHooks = {
  /** Fires right BEFORE a file's gate re-check (simulate a change before the gate). */
  beforeGate?: (file: string) => Promise<void>;
  /** Fires AFTER the gate says `unlink` and BEFORE the remove (simulate a delete/
   *  swap in the gate→unlink window). */
  beforeUnlink?: (file: string) => Promise<void>;
};

/**
 * Run the delete-time gate + unlink across `target` (loose event-file basenames),
 * removing a file ONLY when `evaluateDeleteGate` (re-read fresh per file) clears it.
 * Stops the whole loop on a global abort (G6/G7/G8). Returns the in-order tallies;
 * does NOT compute the public outcome (that is the reconciliation layer's job).
 */
export async function unlinkGatedLoose(
  cwd: string,
  target: readonly string[],
  ctx: DeleteGateContext,
  hooks: UnlinkGatedLooseHooks = {},
): Promise<UnlinkGatedLooseResult> {
  const deleted: string[] = [];
  const vanished: string[] = [];
  const skipped: CleanupSkip[] = [];

  // Defensive: a caller passing a duplicate basename must not double-count one file
  // (e.g. once in `deleted`, again in `vanished`). `new Set` dedupes while preserving
  // insertion order. A real disk enumeration yields unique basenames — this is a
  // guard, not a hot path.
  for (const file of new Set(target)) {
    if (hooks.beforeGate) await hooks.beforeGate(file);

    // Re-verify ownership IMMEDIATELY before the unlink (TOCTOU). The gate re-reads
    // disk on every call, so a change since the plan is caught right here.
    const verdict = await evaluateDeleteGate(cwd, file, ctx);
    if (verdict.disposition === "abort") {
      // A global safety gate failed — stop the WHOLE run, unlinking no further files.
      return {
        deleted,
        vanished,
        skipped,
        abort: {
          path: looseEventRelPath(file),
          reason: verdict.reason,
          detail: verdict.detail,
        },
      };
    }
    if (verdict.disposition === "vanished") {
      vanished.push(file);
      continue;
    }
    if (verdict.disposition === "skip") {
      skipped.push({ path: looseEventRelPath(file), reason: verdict.reason });
      continue;
    }

    // verdict.disposition === "unlink" — the ONE place a loose file is removed. Use
    // the abs the gate VERIFIED (no re-resolve, so the removed path cannot diverge
    // from the gated one, and a re-resolve failure can't be mislabeled). The
    // gate→unlink window is the RFC's accepted best-effort limit (threat model:
    // accidental corruption / honest concurrent writers, NOT a hostile filesystem
    // racing the unlink).
    if (hooks.beforeUnlink) await hooks.beforeUnlink(file);
    try {
      await unlinkOwned(archiveDeletePath(verdict.abs));
      deleted.push(file);
    } catch (err) {
      // ENOENT: a raced delete in the gate→unlink window → already gone (vanished),
      // NOT a survivor and not a false `deleted`. Any OTHER error (EACCES / EPERM /
      // EIO / …): the file is still present and we could not remove it → a SURVIVOR,
      // recorded as a skip so the run ends INCOMPLETE (never success) and the
      // reconciliation layer (3b-2b-2b) re-classifies the present survivor
      // authoritatively. It is NOT an abort — abort is reserved for the global safety
      // gates (G6/G7/G8), not a per-file FS failure.
      if (isEnoent(err)) vanished.push(file);
      else
        skipped.push({ path: looseEventRelPath(file), reason: "unreadable" });
    }
  }

  return { deleted, vanished, skipped, abort: null };
}

// ---------------------------------------------------------------------------
// The cleanup ORCHESTRATOR. Ties the merged parts into the public `CleanupOutcome`:
// prepare (G0 under lock) → write the pack if needed (cell 10) → `unlinkGatedLoose` →
// `reconcileSurvivors` → build the outcome. WIRED into `runStateCompact`/CLI —
// `state compact --write` calls it (the first reachable destructive path).
// ---------------------------------------------------------------------------

/** A `STATE_COMPACT_INELIGIBLE` outcome (cleanup never ran — nothing on disk
 *  changed). `cleanup_pending:false`: the run is blocked, not pending. */
function ineligibleOutcome(block: EventPackBlock): CleanupOutcome {
  return {
    ok: false,
    code: "STATE_COMPACT_INELIGIBLE",
    kind: "ineligible",
    block,
    cleanup_pending: false,
    partial_applied: false,
    cleanup_started: false,
    loose_deleted_count: 0,
    cleanup_remaining_loose: null,
    vanished_count: 0,
    skipped: [],
    advisories: [],
  };
}

function noopNoEventsOutcome(): CleanupOutcome {
  return {
    ok: true,
    kind: "noop_no_events",
    cleanup_pending: false,
    partial_applied: false,
    cleanup_started: false,
    loose_deleted_count: 0,
    cleanup_remaining_loose: 0,
    vanished_count: 0,
    advisories: [],
  };
}

function alreadyCleanedOutcome(): CleanupOutcome {
  return {
    ok: true,
    kind: "already_cleaned",
    cleanup_pending: false,
    partial_applied: false,
    cleanup_started: false,
    loose_deleted_count: 0,
    cleanup_remaining_loose: 0,
    vanished_count: 0,
    advisories: [],
  };
}

/** Cell-10 all-vanished-after-write: WE wrote the pack this run (a mutation →
 *  partial_applied:true), then every loose vanished before the re-prepare even reached
 *  the unlink loop. The phase ended clean with nothing for us to unlink, so it is
 *  `cleaned` (NOT already_cleaned, which would falsely claim partial_applied:false and
 *  vanished_count:0). `vanished` is the pre-write loose count (all of it vanished). */
function cleanedAllVanishedAfterWriteOutcome(
  vanishedCount: number,
): CleanupOutcome {
  return {
    ok: true,
    kind: "cleaned",
    cleanup_pending: false,
    cleanup_started: true,
    cleanup_remaining_loose: 0,
    vanished_count: vanishedCount,
    partial_applied: true,
    loose_deleted_count: 0,
    advisories: [],
  };
}

/** Map a Layer-2 `EventPackWriteError` (the cell-10 pack-write step) to a
 *  `STATE_COMPACT_WRITE_FAILED` outcome. `phase` fixes `partial_applied`
 *  (`write_pack`→false, the pack never reached disk; `verify_pack`→true, the pack
 *  step mutated the tree). This is the Layer-2 EventPackWriteError path ONLY — here a
 *  `verify_pack` readback failure leaves the pack ON disk. (The other `verify_pack`
 *  source, `writeFailedAfterPackBrokenOutcome`, is a post-write re-prepare failure
 *  where the pack may already be gone.) `cleanup_started:false` — no unlink began. */
function writeFailedOutcome(
  err: EventPackWriteError,
  looseRemaining: number,
): CleanupOutcome {
  if (err.phase === "write_pack") {
    return {
      ok: false,
      code: "STATE_COMPACT_WRITE_FAILED",
      phase: "write_pack",
      cleanup_pending: true,
      partial_applied: false,
      cleanup_started: false,
      loose_deleted_count: 0,
      cleanup_remaining_loose: looseRemaining,
      vanished_count: 0,
      skipped: [],
      advisories: [],
    };
  }
  return {
    ok: false,
    code: "STATE_COMPACT_WRITE_FAILED",
    phase: "verify_pack",
    cleanup_pending: true,
    partial_applied: true,
    cleanup_started: false,
    loose_deleted_count: 0,
    cleanup_remaining_loose: looseRemaining,
    vanished_count: 0,
    skipped: [],
    advisories: [],
  };
}

/** Pack write SUCCEEDED this run, then the pre-cleanup state broke BEFORE the unlink
 *  loop (the post-write re-prepare returned ineligible / needs_pack_write, or threw:
 *  snapshot corrupted, a live phase reappeared, the pack itself was removed). The pack
 *  STEP mutated the tree this run (partial_applied:true) and the cleanup never started,
 *  so the closest honest terminal is a `verify_pack` WRITE_FAILED — NOT an ineligible,
 *  which would falsely report partial_applied:false despite the pack write. NOTE the
 *  pack may NO LONGER be on disk here (e.g. removed before re-prepare), so partial:true
 *  asserts a mutation happened, not that the pack is still present. */
function writeFailedAfterPackBrokenOutcome(
  looseRemaining: number,
): CleanupOutcome {
  return {
    ok: false,
    code: "STATE_COMPACT_WRITE_FAILED",
    phase: "verify_pack",
    cleanup_pending: true,
    partial_applied: true,
    cleanup_started: false,
    loose_deleted_count: 0,
    cleanup_remaining_loose: looseRemaining,
    vanished_count: 0,
    skipped: [],
    advisories: [],
  };
}

/**
 * Build the public `CleanupOutcome` from the post-loop facts (PURE — no filesystem).
 * Covers the three terminal states a RAN cleanup can reach: `cleaned` (success),
 * `STATE_COMPACT_CLEANUP_FAILED` (a global abort OR a not-in-pack survivor), and
 * `STATE_COMPACT_CLEANUP_INCOMPLETE` (a present survivor remains). The pre-cleanup
 * outcomes (ineligible / WRITE_FAILED / noop_no_events / already_cleaned) are built by
 * the orchestrator before the loop, not here.
 *
 * `partial_applied` tracks ANY mutation this run: a pack write (`packWrittenThisRun`)
 * OR ≥1 unlink. `vanished_count` sums THREE windows: `preLoopVanishedCount` (cell-10
 * loose that vanished between the pack write and the re-prepare, before the loop ran),
 * the loop's own vanishes, and the reconciliation's. Enforces the runtime invariant
 * `cleaned ⇒ loose_deleted_count > 0 ∨ vanished_count > 0`.
 */
export function buildPostLoopOutcome(
  loop: UnlinkGatedLooseResult,
  recon: LooseCleanupReconciliation,
  packWrittenThisRun: boolean,
  preLoopVanishedCount = 0,
): CleanupOutcome {
  const looseDeletedCount = loop.deleted.length;
  const vanishedCount =
    preLoopVanishedCount + loop.vanished.length + recon.vanished_count;
  // partial_applied↔loose_deleted_count, paired exactly as the CleanupOutcome type
  // requires: a non-zero delete count forces partial_applied:true; partial_applied is
  // also true when the pack was written this run even with 0 unlinks (cell-10 all-vanish).
  const mutation: CleanupMutationProgress =
    packWrittenThisRun || looseDeletedCount > 0
      ? { partial_applied: true, loose_deleted_count: looseDeletedCount }
      : { partial_applied: false, loose_deleted_count: 0 };

  // A global gate abort (G6/G7/G8) → CLEANUP_FAILED. ONLY G7 (pack_missing_event)
  // carries the pack_stale_after_cleanup block — the abort REASON is the signal. A
  // G6/G8 abort must NOT borrow a `recon.block` that the partial post-abort
  // reconciliation may have incidentally produced (that would mislabel a live-owner /
  // snapshot-divergence abort as a stale pack and send the operator to the wrong fix).
  if (loop.abort) {
    const block =
      loop.abort.reason === "pack_missing_event"
        ? "pack_stale_after_cleanup"
        : undefined;
    return {
      ok: false,
      code: "STATE_COMPACT_CLEANUP_FAILED",
      ...(block ? { block } : {}),
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: recon.cleanup_remaining_loose,
      vanished_count: vanishedCount,
      skipped: recon.skipped,
      advisories: recon.advisories,
      ...mutation,
    };
  }

  if (recon.terminal === "STATE_COMPACT_CLEANUP_FAILED") {
    return {
      ok: false,
      code: "STATE_COMPACT_CLEANUP_FAILED",
      ...(recon.block ? { block: recon.block } : {}),
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: recon.cleanup_remaining_loose,
      vanished_count: vanishedCount,
      skipped: recon.skipped,
      advisories: recon.advisories,
      ...mutation,
    };
  }
  if (recon.terminal === "STATE_COMPACT_CLEANUP_INCOMPLETE") {
    return {
      ok: false,
      code: "STATE_COMPACT_CLEANUP_INCOMPLETE",
      cleanup_pending: true,
      cleanup_started: true,
      cleanup_remaining_loose: recon.cleanup_remaining_loose,
      vanished_count: vanishedCount,
      skipped: recon.skipped,
      advisories: recon.advisories,
      ...mutation,
    };
  }

  // recon.terminal === null AND no abort → success (`cleaned`); reconciliation found
  // zero present in-scope survivors, so cleanup_remaining_loose is 0.
  // RUNTIME INVARIANT: cleaned ⇒ loose_deleted_count > 0 ∨ vanished_count > 0. A
  // `ready` prepare has a NON-EMPTY target, and with no survivor/abort every target
  // file ended deleted or vanished — so this holds; guard it loudly against a future
  // regression (a zero-op `cleaned` would be incoherent).
  if (looseDeletedCount === 0 && vanishedCount === 0) {
    throw new Error(
      "internal invariant violated: cleaned with loose_deleted_count:0 AND " +
        "vanished_count:0 (a non-empty cleanup target must delete or vanish ≥1 file)",
    );
  }
  return {
    ok: true,
    kind: "cleaned",
    cleanup_pending: false,
    cleanup_started: true,
    cleanup_remaining_loose: 0,
    vanished_count: vanishedCount,
    advisories: recon.advisories,
    ...mutation,
  };
}

/** Test seams threaded to the sub-steps. PRODUCTION passes NONE (call
 *  `runEventPackCleanup(cwd, phaseId)`); each field only exists to inject a TOCTOU
 *  change in a test. */
export type RunEventPackCleanupHooks = {
  prepare?: PrepareLooseCleanupHooks;
  apply?: ApplyEventPackHooks;
  /** Fires after the cell-10 pack write, BEFORE the re-prepare — lets a test race the
   *  loose set away to exercise the all-vanished-after-write `cleaned` path. */
  afterWrite?: () => Promise<void>;
  loop?: UnlinkGatedLooseHooks;
  reconcile?: ReconcileSurvivorsHooks;
};

/**
 * Run the full Layer 3 cleanup for a phase and return the public `CleanupOutcome`.
 * CALLER HOLDS THE WRITE LOCK (production passes no hooks):
 *   1. `prepareLooseCleanup` (G0) — the cleanup-ready state, or a pre-cleanup verdict.
 *   2. cell 10 (`needs_pack_write`): write the pack via `applyEventPackPlan` (a write/
 *      verify failure → `STATE_COMPACT_WRITE_FAILED`, no unlink), then re-prepare.
 *   3. `unlinkGatedLoose` — the gated, interleaved unlink loop (the only deletes).
 *   4. `reconcileSurvivors` — post-run R0–R5 over the SAME target.
 *   5. `buildPostLoopOutcome` — the terminal `CleanupOutcome`.
 * Wired into the CLI: `state compact --write` → `runStateCompact` → here.
 */
export async function runEventPackCleanup(
  cwd: string,
  phaseId: string,
  hooks: RunEventPackCleanupHooks = {},
): Promise<CleanupOutcome> {
  let prep = await prepareLooseCleanup(cwd, phaseId, hooks.prepare);
  let packWrittenThisRun = false;
  let preWriteLooseCount = 0;

  if (prep.kind === "needs_pack_write") {
    // Cell 10: no pack yet. Write it (Layer 2), then re-prepare for the cleanup.
    const plan = await planEventPack(cwd, phaseId);
    if (plan.kind === "write") {
      preWriteLooseCount = plan.loose_count; // the loose the pack will cover
      let outcome;
      try {
        outcome = await applyEventPackPlan(cwd, plan, hooks.apply);
      } catch (err) {
        // `cleanup_remaining_loose` reports the loose set the FAILED pack targeted
        // (plan.loose_count); the CLI-wiring PR adds `pack_path` (computed from
        // cwd+phaseId, as Layer 2 does) when it emits the error.
        if (err instanceof EventPackWriteError)
          return writeFailedOutcome(err, plan.loose_count);
        throw err;
      }
      // Only count a mutation if WE wrote the pack; a concurrent writer's pack
      // (`noop_already_packed`) is not this run's mutation.
      packWrittenThisRun = outcome.kind === "written";
    }
    if (hooks.afterWrite) await hooks.afterWrite();
    // The re-prepare can THROW (e.g. G0's planEventPack reads a now-broken loose file).
    // We already wrote the pack this run (a mutation), so return a STRUCTURED outcome
    // (a verify_pack WRITE_FAILED) rather than leaking the exception — the caller must
    // learn partial_applied:true. A throw with no prior write stays a throw (pre-mutation,
    // Layer-2-consistent).
    try {
      prep = await prepareLooseCleanup(cwd, phaseId, hooks.prepare);
    } catch (err) {
      if (packWrittenThisRun)
        return writeFailedAfterPackBrokenOutcome(preWriteLooseCount);
      throw err;
    }
  }

  switch (prep.kind) {
    case "noop_no_events":
      return noopNoEventsOutcome();
    case "ineligible":
    case "needs_pack_write":
      // If WE completed the pack step this run, this invocation already mutated the
      // tree — so a broken pre-cleanup state must NOT report partial_applied:false. The
      // pack may or may not still be present (the post-write re-prepare can fail because
      // the pack was removed/invalidated or the surrounding evidence changed), so the
      // honest terminal is a verify_pack WRITE_FAILED (partial_applied:true, cleanup
      // never started) — NOT an ineligible/partial_applied:false. Without a write this
      // run it is a plain ineligible (or the pack-absent defensive for needs_pack_write).
      if (packWrittenThisRun)
        return writeFailedAfterPackBrokenOutcome(preWriteLooseCount);
      return prep.kind === "ineligible"
        ? ineligibleOutcome(prep.block)
        : ineligibleOutcome({
            kind: "pack_invalid",
            detail: "event pack not present after write",
          });
    case "already_clean":
      // Normally nothing was removed → already_cleaned. But if WE wrote the pack this
      // run (cell 10) and every loose then vanished before the re-prepare, the pack
      // write WAS a mutation — report `cleaned` (partial_applied:true, deleted:0,
      // vanished = the pre-write loose count), not already_cleaned.
      return packWrittenThisRun
        ? cleanedAllVanishedAfterWriteOutcome(preWriteLooseCount)
        : alreadyCleanedOutcome();
    case "ready":
      break;
  }

  const { ctx, target } = prep;
  // Cell-10 only: loose that vanished between the pack write and THIS re-prepare (the
  // pack covers them but they are gone before the loop runs) — counted as pre-loop
  // vanishes so the public vanished_count is complete. `max(0, …)` is 0 on the
  // non-cell-10 path (preWriteLooseCount stays 0) and when nothing vanished pre-loop.
  const preLoopVanishedCount = Math.max(0, preWriteLooseCount - target.length);
  const loop = await unlinkGatedLoose(cwd, target, ctx, hooks.loop);
  const recon = await reconcileSurvivors(
    cwd,
    {
      target,
      packIds: ctx.packIds,
      snapshotTaskIds: ctx.snapshotTaskIds,
      loopSkipped: loop.skipped,
    },
    hooks.reconcile,
  );
  return buildPostLoopOutcome(
    loop,
    recon,
    packWrittenThisRun,
    preLoopVanishedCount,
  );
}
