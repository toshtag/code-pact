// ---------------------------------------------------------------------------
// Event-pack compaction LAYER 3 — cleanup contract types + pure classifiers.
//
// This module holds the NON-DESTRUCTIVE half of Layer 3: the public result/
// failure-contract types and the pure post-run reconciliation classifier. The
// actual `unlink` loop and the delete-time ownership gate (G0–G8) that consume
// these land in a later PR — nothing here removes a file. Pinning the contract
// and the classification logic first lets the destructive code be reviewed
// against a fixed, tested target.
//
// See design/decisions/event-pack-compaction-rfc.md — the truth table, the
// delete-time ownership gate table, the R0–R5 reconciliation, and the failure
// contract are the binding source for everything here.
// ---------------------------------------------------------------------------

import type { EventPackBlock } from "./event-pack.ts";

/**
 * Why a loose file could NOT be unlinked, recorded per surviving file. Split so
 * operator recovery differs per reason (a corrupt file vs a swapped one vs a
 * file that appeared after the gate ran). The `*_after_cleanup` reasons come from
 * the post-run reconciliation (R1.0) — a survivor the in-loop gate never saw.
 */
export type CleanupSkipReason =
  // In-loop gate skips (G1–G5, G7-as-skip is NOT here — G7 aborts):
  | "path_escape"
  | "not_regular_file"
  | "not_event_file"
  | "unreadable"
  | "parse_failed"
  | "id_mismatch"
  | "task_not_in_snapshot"
  // Post-run reconciliation (R1.0 id-unknown / R1.3 appeared):
  | "not_regular_file_after_cleanup"
  | "unreadable_after_cleanup"
  | "parse_failed_after_cleanup"
  | "id_unknown_after_cleanup"
  | "appeared_during_cleanup";

/** One surviving loose file the run could not remove, with its reason. */
export type CleanupSkip = {
  /** Project-relative path of the survivor (e.g. `.code-pact/state/events/<file>`). */
  path: string;
  reason: CleanupSkipReason;
};

/** A global anomaly: an events-dir file no phase cleanup owns (R5 out-of-scope). */
export type CleanupAdvisory = {
  code: "unclassified_loose_after_cleanup" | "legacy_progress_retained";
  /** The offending path, when the advisory names one. */
  path?: string;
};

/**
 * The three Layer 3 error codes. They are NOT merged because the operator's next
 * action differs per code (see the RFC's failure contract):
 *  - WRITE_FAILED      — the pack write/readback failed BEFORE cleanup started.
 *  - CLEANUP_FAILED    — a global safety gate (G0/G6/G8) or reconciliation R1.1
 *                        (`pack_stale_after_cleanup`) aborted the cleanup.
 *  - CLEANUP_INCOMPLETE— the run completed but ≥1 present survivor remains.
 */
export type CleanupErrorCode =
  | "STATE_COMPACT_WRITE_FAILED"
  | "STATE_COMPACT_CLEANUP_FAILED"
  | "STATE_COMPACT_CLEANUP_INCOMPLETE";

/**
 * The Layer 3 cleanup result contract. `partial_applied`, `cleanup_started`, and
 * `vanished_count` are emitted on EVERY result (success and error) so a consumer
 * reads them unconditionally — `vanished_count` is ALWAYS present (0 when none),
 * resolving the RFC's "optional?" ambiguity in favor of always-emit, consistent
 * with the other two booleans. `advisories` is always present (empty when none).
 *
 * NOTE: This type is defined and tested in Layer 3a but is WIRED into
 * `runStateCompact` only in the Layer 3b PR (together with the unlink loop and the
 * `would_cleanup_loose`/`cleaned` result-name migration). Keeping it here lets the
 * classifier below be unit-tested against a fixed shape first.
 */
export type CleanupOutcome =
  // --- success / no-op (ok: true) — every boolean is FIXED per the RFC, not just
  // typed `boolean`, so Layer 3b cannot return e.g. `cleaned` with
  // partial_applied:false without a type error. ---
  | {
      ok: true;
      /** Loose files were removed this run. */
      kind: "cleaned";
      cleanup_pending: false;
      partial_applied: true;
      cleanup_started: true;
      loose_deleted_count: number;
      cleanup_remaining_loose: 0;
      vanished_count: number;
      advisories: CleanupAdvisory[];
    }
  | {
      ok: true;
      /** A pack covered the phase but there was nothing left to remove. */
      kind: "already_cleaned";
      cleanup_pending: false;
      partial_applied: false;
      cleanup_started: false;
      loose_deleted_count: 0;
      cleanup_remaining_loose: 0;
      // cleanup_started is false (no loose to remove), so the cleanup-derived
      // vanished_count is fixed 0 — same invariant as WRITE_FAILED below. Only
      // `cleaned` (cleanup_started:true) can report a non-zero vanished_count.
      vanished_count: 0;
      advisories: CleanupAdvisory[];
    }
  | {
      ok: true;
      /** The archived phase had no events to pack or clean (attested / pre-event). */
      kind: "noop_no_events";
      cleanup_pending: false;
      partial_applied: false;
      cleanup_started: false;
      loose_deleted_count: 0;
      cleanup_remaining_loose: 0;
      vanished_count: 0;
      advisories: CleanupAdvisory[];
    }
  // --- pre-write / pre-cleanup ineligible (ok: false) — the run stopped before the
  // pack write step, so NOTHING on disk changed: partial_applied / cleanup_started /
  // loose_deleted_count are FIXED. `cleanup_pending` follows the existing CLI
  // contract (block-dependent), so it stays `boolean`. ---
  | {
      ok: false;
      code: "STATE_COMPACT_INELIGIBLE";
      kind: "ineligible";
      block: EventPackBlock;
      cleanup_pending: boolean;
      partial_applied: false;
      cleanup_started: false;
      loose_deleted_count: 0;
      /**
       * `null`, NOT 0 — the cleanup never ran, so the remaining-loose count is
       * NOT-APPLICABLE / not-computed, not "zero left". `phase_file_still_present`
       * / `pack_stale` can leave loose files on disk; returning 0 here would let a
       * consumer misread "no loose remains". Mirrors the RFC terminal table's `—`.
       */
      cleanup_remaining_loose: null;
      vanished_count: 0;
      skipped: [];
      advisories: CleanupAdvisory[];
    }
  // --- write/cleanup failures (ok: false). ---
  // WRITE_FAILED is split into two variants so the `phase`↔`partial_applied`
  // pairing is FIXED by the type (not just `boolean`): a `write_pack` failure can
  // never be `partial_applied:true`, and `verify_pack` never `false`. The field is
  // named `phase` — REUSING Layer 2's existing error field (state.ts emits
  // `phase: err.phase`), deliberately NOT a new `write_phase` field.
  //
  // Because `cleanup_started` is false (the failure is BEFORE the unlink phase — no
  // per-file gate and no reconciliation ran), the cleanup-DERIVED fields are fixed:
  // `vanished_count:0` and `skipped:[]`. Only `cleanup_remaining_loose` is a count
  // (the loose set the failed pack would have covered still sits on disk), and
  // `advisories` stays open (a pre-cleanup advisory like `legacy_progress_retained`
  // could still attach). An impossible payload — `skipped[]`/`vanished_count` from a
  // run that never started cleanup — must not type-check.
  | {
      ok: false;
      code: "STATE_COMPACT_WRITE_FAILED";
      /** `write_pack` failure: the pack never reached disk. */
      phase: "write_pack";
      cleanup_pending: true;
      partial_applied: false;
      cleanup_started: false;
      loose_deleted_count: 0;
      cleanup_remaining_loose: number;
      vanished_count: 0;
      skipped: [];
      advisories: CleanupAdvisory[];
    }
  | {
      ok: false;
      code: "STATE_COMPACT_WRITE_FAILED";
      /** `verify_pack` failure: the pack IS on disk but failed readback. */
      phase: "verify_pack";
      cleanup_pending: true;
      partial_applied: true;
      cleanup_started: false;
      loose_deleted_count: 0;
      cleanup_remaining_loose: number;
      vanished_count: 0;
      skipped: [];
      advisories: CleanupAdvisory[];
    }
  | {
      ok: false;
      code: "STATE_COMPACT_CLEANUP_FAILED";
      /**
       * On CLEANUP_FAILED via reconciliation R1.1, the coverage-failure block.
       * Currently only R1.1 emits a structured block; G0 / G6 / G8 aborts may add
       * their own cleanup-failure blocks here in Layer 3b if structured diagnostics
       * are wanted (the union would grow, not change shape).
       */
      block?: "pack_stale_after_cleanup";
      cleanup_pending: true;
      partial_applied: boolean;
      cleanup_started: true;
      loose_deleted_count: number;
      cleanup_remaining_loose: number;
      vanished_count: number;
      skipped: CleanupSkip[];
      advisories: CleanupAdvisory[];
    }
  | {
      ok: false;
      code: "STATE_COMPACT_CLEANUP_INCOMPLETE";
      cleanup_pending: true;
      partial_applied: boolean;
      cleanup_started: true;
      loose_deleted_count: number;
      cleanup_remaining_loose: number;
      vanished_count: number;
      skipped: CleanupSkip[];
      advisories: CleanupAdvisory[];
    };

// ---------------------------------------------------------------------------
// Post-run reconciliation (R1) — PURE classifier for ONE present survivor.
//
// R0 (build the in-scope candidate set + re-enumerate from disk) and the unlink
// loop are NOT here — they touch the filesystem and land in Layer 3b. This
// function is the decision core R1 applies to each present, in-scope survivor,
// in the RFC's locked order: pack-coverage (R1.1) is evaluated BEFORE any
// existing skip record (R1.2), and the id-unverifiable case (R1.0) comes first
// because the later branches all key on a known event id.
// ---------------------------------------------------------------------------

/** What the caller already knows about ONE present, in-scope survivor. */
export type SurvivorFacts = {
  /** The survivor's project-relative path. */
  path: string;
  /**
   * The survivor's CONTENT event id, or null when it cannot be read / parsed /
   * regular-file-verified / id-recomputed at reconciliation time (R1.0).
   */
  contentEventId: string | null;
  /**
   * When `contentEventId` is null, the specific R1.0 reason to record. Ignored
   * when an id is known. Defaults to `id_unknown_after_cleanup`.
   */
  idUnknownReason?: Extract<
    CleanupSkipReason,
    | "not_regular_file_after_cleanup"
    | "unreadable_after_cleanup"
    | "parse_failed_after_cleanup"
    | "id_unknown_after_cleanup"
  >;
  /** A skip record this file already carries from the in-loop gate, if any. */
  existingSkipReason: CleanupSkipReason | null;
};

/** The verified pack's covered event-id set membership test (no filesystem). */
export type PackCoverage = { has: (eventId: string) => boolean };

/**
 * The reconciliation verdict for ONE survivor. `terminal` is the error code this
 * survivor forces; a single FAILED survivor makes the whole run FAILED, otherwise
 * any survivor keeps the run at INCOMPLETE. `skip` is the record to add to
 * `skipped[]` (every present survivor produces exactly one).
 */
export type SurvivorVerdict = {
  terminal: "STATE_COMPACT_CLEANUP_FAILED" | "STATE_COMPACT_CLEANUP_INCOMPLETE";
  /** The pack-coverage block, only on the FAILED (not-in-pack) path. */
  block?: "pack_stale_after_cleanup";
  skip: CleanupSkip;
};

/**
 * Classify ONE present, in-scope survivor (R1). Order is load-bearing:
 *  R1.0  id UNKNOWN                         → INCOMPLETE, `*_after_cleanup` reason.
 *  R1.1  id known AND NOT in pack           → FAILED, pack_stale_after_cleanup
 *                                             (wins over any existing skip record).
 *  R1.2  id known, in pack, has skip record → INCOMPLETE, keep that reason.
 *  R1.3  id known, in pack, no skip record  → INCOMPLETE, appeared_during_cleanup.
 *
 * Pure: no filesystem, no unlink. The caller aggregates verdicts — if ANY is
 * FAILED the run is `STATE_COMPACT_CLEANUP_FAILED`; else if any survivor exists
 * the run is `STATE_COMPACT_CLEANUP_INCOMPLETE`; else the run is `cleaned`.
 */
export function classifyPostRunSurvivor(
  facts: SurvivorFacts,
  pack: PackCoverage,
): SurvivorVerdict {
  // R1.0 — id cannot be computed: cannot prove non-coverage, only that we cannot
  // safely classify/remove it. INCOMPLETE, never FAILED. The recorded reason is the
  // id-unverifiable reason (`*_after_cleanup`), NOT any earlier per-file skip reason:
  // once the content id is unknown the file's *current* state (changed/unreadable at
  // reconciliation time) is what the operator must act on, so the fresher reason wins.
  // (Distinct from R1.1, where a known not-in-pack id PRESERVES an earlier skip reason.)
  if (facts.contentEventId === null) {
    return {
      terminal: "STATE_COMPACT_CLEANUP_INCOMPLETE",
      skip: { path: facts.path, reason: facts.idUnknownReason ?? "id_unknown_after_cleanup" },
    };
  }

  // R1.1 — id known and NOT covered by the pack: the pack no longer matches the
  // live loose set. Coverage failure, wins over any earlier per-file skip record.
  if (!pack.has(facts.contentEventId)) {
    return {
      terminal: "STATE_COMPACT_CLEANUP_FAILED",
      block: "pack_stale_after_cleanup",
      // Keep the prior reason if one exists; otherwise the survivor is a new
      // not-in-pack file — record it as appeared_during_cleanup for skipped[].
      skip: {
        path: facts.path,
        reason: facts.existingSkipReason ?? "appeared_during_cleanup",
      },
    };
  }

  // R1.2 — id known, covered, already has a skip record: keep that reason.
  if (facts.existingSkipReason !== null) {
    return {
      terminal: "STATE_COMPACT_CLEANUP_INCOMPLETE",
      skip: { path: facts.path, reason: facts.existingSkipReason },
    };
  }

  // R1.3 — id known, covered, no skip record: a gate-bypassing file the pack
  // still covers (appeared after the loop).
  return {
    terminal: "STATE_COMPACT_CLEANUP_INCOMPLETE",
    skip: { path: facts.path, reason: "appeared_during_cleanup" },
  };
}

/**
 * Aggregate per-survivor verdicts into the run's terminal disposition. Pure.
 * FAILED dominates: any single `pack_stale_after_cleanup` makes the whole run
 * FAILED; otherwise any present survivor makes it INCOMPLETE; an empty list means
 * the cleanup is complete (the caller maps that to `cleaned`/`already_cleaned`).
 * On a FAILED run, `block: "pack_stale_after_cleanup"` is carried up so the caller
 * can populate the public failure contract WITHOUT re-scanning the verdicts — the
 * block would otherwise be lost between classify and the CleanupOutcome.
 */
export function aggregateSurvivorVerdicts(
  verdicts: readonly SurvivorVerdict[],
): {
  terminal: CleanupErrorCode | null;
  block?: "pack_stale_after_cleanup";
  skipped: CleanupSkip[];
} {
  if (verdicts.length === 0) return { terminal: null, skipped: [] };
  const skipped = verdicts.map((v) => v.skip);
  const anyFailed = verdicts.some(
    (v) => v.terminal === "STATE_COMPACT_CLEANUP_FAILED",
  );
  if (anyFailed) {
    return { terminal: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup", skipped };
  }
  return { terminal: "STATE_COMPACT_CLEANUP_INCOMPLETE", skipped };
}
