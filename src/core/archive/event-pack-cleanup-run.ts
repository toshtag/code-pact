// ---------------------------------------------------------------------------
// Event-pack compaction LAYER 3b-2b-2a — the interleaved delete-time gate + unlink
// LOOP. THE destructive core: this is the ONLY place an event-pack-compaction
// `unlink` happens.
//
// For each candidate loose file it re-runs the merged delete-time gate
// (`evaluateDeleteGate`) IMMEDIATELY before the unlink — never a batch decision, so
// a change since the plan (a reappearing live owner, a swapped file, a vanished
// file) is caught right at the irreversible step (TOCTOU). A file is removed ONLY
// when every G1–G8 check passes. A global safety gate (G6 live owner / G7 pack
// missing / G8 snapshot diverged) ABORTS the whole loop, unlinking no further files.
//
// NOT yet wired into the CLI, and NOT yet wrapped with the R0–R5 post-run
// reconciliation / `CleanupOutcome` mapping (Layer 3b-2b-2b). This PR ships and tests
// the loop in isolation so the irreversible step is reviewed before it is reachable
// — the same "decision/logic first, wiring later" cadence as Layers 3a / 3b-1 /
// 3b-2b-1.
//
// CALLER CONTRACT: hold the write lock, and pass a `ctx` + `target` built UNDER THAT
// LOCK from a verified G0 re-plan (a bound pack that covers the snapshot) — NOT from
// the dry-run `planLooseCleanup` cross-read.
// ---------------------------------------------------------------------------

import { unlink } from "node:fs/promises";
import {
  evaluateDeleteGate,
  looseEventRelPath,
  type DeleteGateContext,
  type DeleteGateAbortReason,
} from "./event-pack-cleanup-gate.ts";
import type { CleanupSkip } from "./event-pack-cleanup.ts";

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
   *  end. On abort, `deleted` holds the files removed BEFORE the aborting file. */
  abort: { reason: DeleteGateAbortReason; detail: string } | null;
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
        abort: { reason: verdict.reason, detail: verdict.detail },
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
      await unlink(verdict.abs);
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
      else skipped.push({ path: looseEventRelPath(file), reason: "unreadable" });
    }
  }

  return { deleted, vanished, skipped, abort: null };
}
