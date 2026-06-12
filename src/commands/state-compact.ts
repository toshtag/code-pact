import type { EventPackBlock } from "../core/archive/event-pack.ts";
import {
  planEventPack,
  applyEventPackPlan,
  type ApplyEventPackHooks,
} from "../core/archive/event-pack.ts";

// ---------------------------------------------------------------------------
// `state compact <phase-id>` runner (Layer 2 — write pack + readback verify,
// NO loose-event unlink). The result naming is reality-matching: after `--write`
// the pack is on disk but the loose files REMAIN, so it is `packed` /
// `already_packed` with `cleanup_pending` + a `next_action` naming Layer 3 —
// NEVER `compacted` (which would read as "files removed, done").
// ---------------------------------------------------------------------------

const LOOSE_NOTE =
  "Layer 3 (state prune) will remove the loose event files after verified pack coverage.";

export type StateCompactOptions = {
  cwd: string;
  phaseId: string;
  write?: boolean;
  /** Test seam, threaded to applyEventPackPlan. */
  hooks?: ApplyEventPackHooks;
};

export type StateCompactResult =
  | {
      kind: "would_pack";
      phase_id: string;
      pack_path: string;
      would_pack_event_count: number;
      would_leave_loose_count: number;
      cleanup_pending: true;
    }
  | {
      kind: "packed";
      phase_id: string;
      pack_path: string;
      packed_event_count: number;
      loose_remaining_count: number;
      loose_deleted_count: 0;
      cleanup_pending: true;
      next_action: string;
    }
  | {
      kind: "would_already_packed";
      phase_id: string;
      pack_path: string;
      loose_remaining_count: number;
      cleanup_pending: boolean;
    }
  | {
      kind: "already_packed";
      phase_id: string;
      pack_path: string;
      loose_remaining_count: number;
      cleanup_pending: boolean;
    }
  | { kind: "would_noop_no_events"; phase_id: string }
  | { kind: "noop_no_events"; phase_id: string }
  | { kind: "ineligible"; phase_id: string; block: EventPackBlock };

export async function runStateCompact(opts: StateCompactOptions): Promise<StateCompactResult> {
  const { cwd, phaseId, write = false } = opts;
  const plan = await planEventPack(cwd, phaseId);

  if (plan.kind === "ineligible") {
    return { kind: "ineligible", phase_id: phaseId, block: plan.block };
  }
  if (plan.kind === "noop_no_events") {
    return write
      ? { kind: "noop_no_events", phase_id: phaseId }
      : { kind: "would_noop_no_events", phase_id: phaseId };
  }
  if (plan.kind === "noop_already_packed") {
    const shape = {
      phase_id: phaseId,
      pack_path: plan.packPath,
      loose_remaining_count: plan.loose_remaining_count,
      cleanup_pending: plan.cleanup_pending,
    } as const;
    return write
      ? { kind: "already_packed", ...shape }
      : { kind: "would_already_packed", ...shape };
  }

  // plan.kind === "write"
  if (!write) {
    return {
      kind: "would_pack",
      phase_id: phaseId,
      pack_path: plan.packPath,
      would_pack_event_count: plan.pack.events.length,
      would_leave_loose_count: plan.loose_count,
      cleanup_pending: true,
    };
  }

  // --write: apply under the caller's lock. May throw EventPackWriteError (the
  // CLI maps it to STATE_COMPACT_WRITE_FAILED). The re-plan inside apply may
  // also reclassify (concurrent write → already_packed).
  const outcome = await applyEventPackPlan(cwd, plan, opts.hooks);
  if (outcome.kind === "ineligible") {
    return { kind: "ineligible", phase_id: phaseId, block: outcome.block };
  }
  if (outcome.kind === "noop_no_events") {
    return { kind: "noop_no_events", phase_id: phaseId };
  }
  if (outcome.kind === "noop_already_packed") {
    return {
      kind: "already_packed",
      phase_id: phaseId,
      pack_path: outcome.packPath,
      loose_remaining_count: outcome.loose_remaining_count,
      cleanup_pending: outcome.cleanup_pending,
    };
  }
  // outcome.kind === "written"
  return {
    kind: "packed",
    phase_id: phaseId,
    pack_path: outcome.packPath,
    packed_event_count: outcome.pack.events.length,
    loose_remaining_count: outcome.loose_count,
    loose_deleted_count: 0,
    cleanup_pending: true,
    next_action: LOOSE_NOTE,
  };
}
