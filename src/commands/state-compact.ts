import type { EventPackBlock } from "../core/archive/event-pack.ts";
import { planEventPack } from "../core/archive/event-pack.ts";
import type { CoveredLooseRelationship, CleanupOutcome } from "../core/archive/event-pack-cleanup.ts";
import {
  runEventPackCleanup,
  type RunEventPackCleanupHooks,
} from "../core/archive/event-pack-cleanup-run.ts";

// ---------------------------------------------------------------------------
// `state compact <phase-id>` runner.
//   - DRY-RUN (no `--write`): a no-mutation `planEventPack` verdict (`would_pack` /
//     `would_already_packed` / `would_noop_no_events` / `ineligible`). (The Layer-3
//     dry-run naming migration — `would_cleanup_loose` / `would_resume_cleanup` — is a
//     follow-up; the dry-run still reports cleanup as PENDING, consistent with the
//     `--write` path now performing it.)
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
  // --- dry-run verdicts (no disk mutation) ---
  | {
      kind: "would_pack";
      phase_id: string;
      pack_path: string;
      would_pack_event_count: number;
      would_leave_loose_count: number;
      cleanup_pending: true;
    }
  | {
      kind: "would_already_packed";
      phase_id: string;
      pack_path: string;
      loose_remaining_count: number;
      cleanup_pending: boolean;
      loose_relationship: CoveredLooseRelationship;
    }
  | { kind: "would_noop_no_events"; phase_id: string }
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

  // DRY-RUN: the Layer-2 `planEventPack` verdict, no disk mutation.
  const plan = await planEventPack(cwd, phaseId);
  if (plan.kind === "ineligible") {
    return { kind: "ineligible", phase_id: phaseId, block: plan.block };
  }
  if (plan.kind === "noop_no_events") {
    return { kind: "would_noop_no_events", phase_id: phaseId };
  }
  if (plan.kind === "noop_already_packed") {
    return {
      kind: "would_already_packed",
      phase_id: phaseId,
      pack_path: plan.packPath,
      loose_remaining_count: plan.loose_remaining_count,
      cleanup_pending: plan.cleanup_pending,
      loose_relationship: plan.loose_relationship,
    };
  }
  // plan.kind === "write"
  return {
    kind: "would_pack",
    phase_id: phaseId,
    pack_path: plan.packPath,
    would_pack_event_count: plan.pack.events.length,
    would_leave_loose_count: plan.loose_count,
    cleanup_pending: true,
  };
}
