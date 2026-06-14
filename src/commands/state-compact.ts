import type { EventPackBlock } from "../core/archive/event-pack.ts";
import { planEventPack } from "../core/archive/event-pack.ts";
import type { CleanupOutcome } from "../core/archive/event-pack-cleanup.ts";
import {
  runEventPackCleanup,
  type RunEventPackCleanupHooks,
} from "../core/archive/event-pack-cleanup-run.ts";

// ---------------------------------------------------------------------------
// `state compact <phase-id>` runner.
//   - DRY-RUN (no `--write`): a no-mutation `planEventPack` verdict. The verdict `kind`s
//     mirror the RFC truth table's dry-run column, so a dry-run name says what `--write`
//     WOULD do (it cleans, not just packs): `would_pack_and_cleanup` (cell 10, no pack
//     yet) / `would_cleanup_loose` (cell 12, pack == loose) / `would_resume_cleanup`
//     (cell 14, loose ⊊ pack — a resumable partial cleanup) / `noop_already_cleaned`
//     (cell 11, pack present, no loose left) / `noop_no_events` (cell 9) / `ineligible`.
//   - `--write` (Layer 3): writes the pack if needed AND removes the gated loose files,
//     returning the public `CleanupOutcome` (`cleaned` / `already_cleaned` / `noop` /
//     `ineligible` / the three failure codes). This is the FIRST path that actually
//     deletes loose event files. The caller (`cmdStateCompact`) holds the write lock.
// ---------------------------------------------------------------------------

export type StateCompactOptions = {
  cwd: string;
  phaseId: string;
  write?: boolean;
  /** Test seam, threaded to `runEventPackCleanup` on the `--write` path. */
  hooks?: RunEventPackCleanupHooks;
};

export type StateCompactResult =
  // --- dry-run verdicts (no disk mutation; `kind`s mirror the RFC truth table's
  // dry-run column — see the file header for the cell mapping) ---
  | {
      kind: "would_pack_and_cleanup"; // cell 10: no pack yet — write it, then clean
      phase_id: string;
      pack_path: string;
      would_pack_event_count: number;
      would_leave_loose_count: number;
      cleanup_pending: true;
    }
  | {
      kind: "would_cleanup_loose"; // cell 12: pack == loose set — clean all of it
      phase_id: string;
      pack_path: string;
      loose_remaining_count: number;
      cleanup_pending: true;
    }
  | {
      kind: "would_resume_cleanup"; // cell 14: loose ⊊ pack — resume a partial cleanup
      phase_id: string;
      pack_path: string;
      loose_remaining_count: number;
      cleanup_pending: true;
    }
  | {
      kind: "noop_already_cleaned"; // cell 11: pack present, no loose left
      phase_id: string;
      pack_path: string;
      cleanup_pending: false;
    }
  | { kind: "noop_no_events"; phase_id: string } // cell 9
  | { kind: "ineligible"; phase_id: string; block: EventPackBlock }
  // --- `--write` result: the public Layer-3 cleanup outcome ---
  | { kind: "cleanup_outcome"; phase_id: string; outcome: CleanupOutcome };

export async function runStateCompact(opts: StateCompactOptions): Promise<StateCompactResult> {
  const { cwd, phaseId, write = false } = opts;

  if (write) {
    // Layer 3: write the pack if needed, then unlink the gated loose files. The caller
    // holds the write lock. `runEventPackCleanup` returns a structured `CleanupOutcome`
    // — it does NOT throw `EventPackWriteError` (it maps a pack-step failure to a
    // `STATE_COMPACT_WRITE_FAILED` outcome itself).
    const outcome = await runEventPackCleanup(cwd, phaseId, opts.hooks);
    return { kind: "cleanup_outcome", phase_id: phaseId, outcome };
  }

  // DRY-RUN: the `planEventPack` verdict, no disk mutation. The verdict `kind` is
  // chosen per the RFC truth table so a dry-run name says what `--write` WOULD do.
  const plan = await planEventPack(cwd, phaseId);
  if (plan.kind === "ineligible") {
    return { kind: "ineligible", phase_id: phaseId, block: plan.block };
  }
  if (plan.kind === "noop_no_events") {
    return { kind: "noop_no_events", phase_id: phaseId };
  }
  if (plan.kind === "noop_already_packed") {
    // `loose_relationship` is `empty | equal | strict_subset` (diverged → `pack_stale`
    // ineligible, never here), so this switch is exhaustive — each maps to one RFC cell.
    const base = { phase_id: phaseId, pack_path: plan.packPath };
    switch (plan.loose_relationship) {
      case "empty": // cell 11
        return { kind: "noop_already_cleaned", ...base, cleanup_pending: false };
      case "equal": // cell 12
        return {
          kind: "would_cleanup_loose",
          ...base,
          loose_remaining_count: plan.loose_remaining_count,
          cleanup_pending: true,
        };
      case "strict_subset": // cell 14
        return {
          kind: "would_resume_cleanup",
          ...base,
          loose_remaining_count: plan.loose_remaining_count,
          cleanup_pending: true,
        };
    }
  }
  // plan.kind === "write" — cell 10: no pack yet.
  return {
    kind: "would_pack_and_cleanup",
    phase_id: phaseId,
    pack_path: plan.packPath,
    would_pack_event_count: plan.pack.events.length,
    would_leave_loose_count: plan.loose_count,
    cleanup_pending: true,
  };
}
