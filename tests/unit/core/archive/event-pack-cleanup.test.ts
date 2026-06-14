import { describe, expect, it } from "vitest";
import {
  classifyPostRunSurvivor,
  aggregateSurvivorVerdicts,
  classifyLoosePackRelationship,
  type CleanupOutcome,
  type PackCoverage,
  type SurvivorFacts,
  type SurvivorVerdict,
} from "../../../../src/core/archive/event-pack-cleanup.ts";

// ---------------------------------------------------------------------------
// Layer 3 post-run reconciliation (R1) pure classifier. No filesystem, no unlink.
// Pins the RFC's locked R1 order: R1.0 (id-unknown) → R1.1 (not-in-pack, FAILED,
// wins over a skip record) → R1.2 (skip record kept) → R1.3 (appeared, covered).
// See design/decisions/event-pack-compaction-rfc.md (Final reconciliation step).
// ---------------------------------------------------------------------------

/** A PackCoverage whose covered id set is the given list. */
function coverage(ids: string[]): PackCoverage {
  const set = new Set(ids);
  return { has: (id) => set.has(id) };
}

const PACK = coverage(["id-A", "id-B"]);

describe("classifyPostRunSurvivor — R1 branch order", () => {
  it("R1.0 — id UNKNOWN → CLEANUP_INCOMPLETE with the id-unknown reason", () => {
    const facts: SurvivorFacts = {
      path: ".code-pact/state/events/x.yaml",
      contentEventId: null,
      idUnknownReason: "parse_failed_after_cleanup",
      existingSkipReason: null,
    };
    const v = classifyPostRunSurvivor(facts, PACK);
    expect(v.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(v.block).toBeUndefined();
    expect(v.skip).toEqual({ path: facts.path, reason: "parse_failed_after_cleanup" });
  });

  it("R1.0 — id UNKNOWN with no explicit reason defaults to id_unknown_after_cleanup", () => {
    const v = classifyPostRunSurvivor(
      { path: "p", contentEventId: null, existingSkipReason: null },
      PACK,
    );
    expect(v.skip.reason).toBe("id_unknown_after_cleanup");
  });

  it("R1.0 wins even if the file carries an existing skip record (cannot classify coverage without an id)", () => {
    const v = classifyPostRunSurvivor(
      { path: "p", contentEventId: null, existingSkipReason: "unreadable" },
      PACK,
    );
    expect(v.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(v.skip.reason).toBe("id_unknown_after_cleanup");
  });

  it("R1.1 — id known but NOT in pack → CLEANUP_FAILED / pack_stale_after_cleanup", () => {
    const v = classifyPostRunSurvivor(
      { path: "p", contentEventId: "id-Z", existingSkipReason: null },
      PACK,
    );
    expect(v.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(v.block).toBe("pack_stale_after_cleanup");
    expect(v.skip.reason).toBe("appeared_during_cleanup");
  });

  it("R1.1 WINS OVER an existing skip record — pack-coverage is evaluated before R1.2", () => {
    // A file with a prior G-skip (e.g. id_mismatch) that is ALSO not in the pack
    // must be CLEANUP_FAILED, not downgraded to INCOMPLETE by the skip record.
    const v = classifyPostRunSurvivor(
      { path: "p", contentEventId: "id-Z", existingSkipReason: "id_mismatch" },
      PACK,
    );
    expect(v.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(v.block).toBe("pack_stale_after_cleanup");
    // The existing skip reason is preserved in skipped[] for the operator.
    expect(v.skip.reason).toBe("id_mismatch");
  });

  it("R1.2 — id known, in pack, has a skip record → INCOMPLETE, keep that reason", () => {
    const v = classifyPostRunSurvivor(
      { path: "p", contentEventId: "id-A", existingSkipReason: "task_not_in_snapshot" },
      PACK,
    );
    expect(v.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(v.block).toBeUndefined();
    expect(v.skip.reason).toBe("task_not_in_snapshot");
  });

  it("R1.3 — id known, in pack, NO skip record → INCOMPLETE, appeared_during_cleanup", () => {
    const v = classifyPostRunSurvivor(
      { path: "p", contentEventId: "id-B", existingSkipReason: null },
      PACK,
    );
    expect(v.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(v.skip.reason).toBe("appeared_during_cleanup");
  });
});

describe("aggregateSurvivorVerdicts — FAILED dominates", () => {
  const incomplete: SurvivorVerdict = {
    terminal: "STATE_COMPACT_CLEANUP_INCOMPLETE",
    skip: { path: "a", reason: "appeared_during_cleanup" },
  };
  const failed: SurvivorVerdict = {
    terminal: "STATE_COMPACT_CLEANUP_FAILED",
    block: "pack_stale_after_cleanup",
    skip: { path: "b", reason: "appeared_during_cleanup" },
  };

  it("empty list → terminal null (cleanup is complete)", () => {
    expect(aggregateSurvivorVerdicts([])).toEqual({ terminal: null, skipped: [] });
  });

  it("only INCOMPLETE survivors → CLEANUP_INCOMPLETE", () => {
    const r = aggregateSurvivorVerdicts([incomplete, incomplete]);
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(r.skipped).toHaveLength(2);
  });

  it("any FAILED survivor makes the whole run FAILED and carries the block up", () => {
    const r = aggregateSurvivorVerdicts([incomplete, failed, incomplete]);
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(r.block).toBe("pack_stale_after_cleanup");
    expect(r.skipped).toHaveLength(3);
  });

  it("INCOMPLETE runs carry no block", () => {
    const r = aggregateSurvivorVerdicts([incomplete, incomplete]);
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_INCOMPLETE");
    expect(r.block).toBeUndefined();
  });

  it("empty run carries no block", () => {
    expect(aggregateSurvivorVerdicts([]).block).toBeUndefined();
  });

  it("collects every survivor's skip record (no silent truncation)", () => {
    const r = aggregateSurvivorVerdicts([incomplete, failed]);
    expect(r.skipped.map((s) => s.path)).toEqual(["a", "b"]);
  });
});

describe("CleanupOutcome — every terminal-table result is representable, impossible combinations rejected", () => {
  // These are compile-time contract assertions: each literal must type-check as a
  // CleanupOutcome with the RFC's value combinations — some FIXED (e.g. ineligible's
  // cleanup_remaining_loose:null), some PAIRED (e.g. cleaned's partial_applied ↔
  // loose_deleted_count via CleanupMutationProgress). An impossible combination
  // (e.g. cleaned with partial_applied:false AND files deleted) fails typecheck,
  // which is the point — the contract type, not just docs, enforces it.
  it("represents cleaned / already_cleaned / noop_no_events / ineligible / write+cleanup failures", () => {
    const cleaned: CleanupOutcome = {
      ok: true, kind: "cleaned", cleanup_pending: false,
      partial_applied: true, cleanup_started: true,
      loose_deleted_count: 3, cleanup_remaining_loose: 0, vanished_count: 0, advisories: [],
    };
    // The all-vanished edge: the cleanup ran but every targeted loose file VANISHED
    // concurrently (a pre-existing pack, no pack write) — the phase ended clean, but
    // this run mutated nothing, so partial_applied:false / loose_deleted_count:0 with
    // a non-zero vanished_count. This must be representable as `cleaned`.
    const cleanedAllVanished: CleanupOutcome = {
      ok: true, kind: "cleaned", cleanup_pending: false,
      partial_applied: false, cleanup_started: true,
      loose_deleted_count: 0, cleanup_remaining_loose: 0, vanished_count: 2, advisories: [],
    };
    const alreadyCleaned: CleanupOutcome = {
      ok: true, kind: "already_cleaned", cleanup_pending: false,
      partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 0, vanished_count: 0, advisories: [],
    };
    const noopNoEvents: CleanupOutcome = {
      ok: true, kind: "noop_no_events", cleanup_pending: false,
      partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 0, vanished_count: 0, advisories: [],
    };
    const ineligible: CleanupOutcome = {
      ok: false, code: "STATE_COMPACT_INELIGIBLE", kind: "ineligible",
      block: { kind: "snapshot_missing" },
      cleanup_pending: false, partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: null, vanished_count: 0,
      skipped: [], advisories: [],
    };
    const writeFailed: CleanupOutcome = {
      ok: false, code: "STATE_COMPACT_WRITE_FAILED", phase: "verify_pack",
      cleanup_pending: true, partial_applied: true, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 2, vanished_count: 0,
      skipped: [], advisories: [],
    };
    const cleanupFailed: CleanupOutcome = {
      ok: false, code: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup",
      cleanup_pending: true, partial_applied: true, cleanup_started: true,
      loose_deleted_count: 1, cleanup_remaining_loose: 1, vanished_count: 0,
      skipped: [{ path: "x", reason: "appeared_during_cleanup" }], advisories: [],
    };
    const cleanupIncomplete: CleanupOutcome = {
      ok: false, code: "STATE_COMPACT_CLEANUP_INCOMPLETE",
      cleanup_pending: true, partial_applied: true, cleanup_started: true,
      loose_deleted_count: 2, cleanup_remaining_loose: 1, vanished_count: 1,
      skipped: [{ path: "y", reason: "task_not_in_snapshot" }], advisories: [],
    };
    // Runtime touch so the literals are not dead code.
    for (const o of [cleaned, cleanedAllVanished, alreadyCleaned, noopNoEvents, ineligible, writeFailed, cleanupFailed, cleanupIncomplete]) {
      expect(o).toBeTruthy();
    }
    expect(cleaned.partial_applied).toBe(true);
    expect(cleanedAllVanished.partial_applied).toBe(false); // all-vanished mutated nothing
    expect(cleanedAllVanished.vanished_count).toBe(2);
    expect(noopNoEvents.cleanup_started).toBe(false);
    expect(ineligible.ok).toBe(false);
  });

  it("NEGATIVE compile guards — the fixed RFC values cannot be violated (type errors are the assertion)", () => {
    // Route each bad literal through a typed identity so the type error is reported
    // ON THE CALL LINE (right after the @ts-expect-error), not on whichever inner
    // field happens to mismatch — a multi-line literal would otherwise put the error
    // on a field line and leave the directive "unused".
    const out = (o: CleanupOutcome): CleanupOutcome => o;

    // @ts-expect-error cleaned pairs partial_applied↔loose_deleted_count: partial_applied:false forbids deleted>0
    out({
      ok: true, kind: "cleaned", cleanup_pending: false,
      partial_applied: false, cleanup_started: true,
      loose_deleted_count: 1, cleanup_remaining_loose: 0, vanished_count: 0, advisories: [],
    });
    // @ts-expect-error cleaned always started the cleanup, so cleanup_started must be true
    out({
      ok: true, kind: "cleaned", cleanup_pending: false,
      partial_applied: true, cleanup_started: false,
      loose_deleted_count: 1, cleanup_remaining_loose: 0, vanished_count: 0, advisories: [],
    });
    // @ts-expect-error write_pack failure must imply partial_applied:false (pack never on disk)
    out({
      ok: false, code: "STATE_COMPACT_WRITE_FAILED", phase: "write_pack",
      cleanup_pending: true, partial_applied: true, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 2, vanished_count: 0,
      skipped: [], advisories: [],
    });
    // @ts-expect-error verify_pack failure must imply partial_applied:true (pack on disk)
    out({
      ok: false, code: "STATE_COMPACT_WRITE_FAILED", phase: "verify_pack",
      cleanup_pending: true, partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 2, vanished_count: 0,
      skipped: [], advisories: [],
    });
    // @ts-expect-error ineligible must use cleanup_remaining_loose:null, not 0 (cleanup never ran)
    out({
      ok: false, code: "STATE_COMPACT_INELIGIBLE", kind: "ineligible",
      block: { kind: "snapshot_missing" },
      cleanup_pending: false, partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 0, vanished_count: 0,
      skipped: [], advisories: [],
    });
    out({
      ok: false, code: "STATE_COMPACT_WRITE_FAILED", phase: "write_pack",
      cleanup_pending: true, partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 2, vanished_count: 0,
      // @ts-expect-error write failure is before cleanup, so skipped must be [] (no gate ran).
      // (TS reports the tuple-overflow on this field line, so the directive sits here.)
      skipped: [{ path: "x", reason: "appeared_during_cleanup" }],
      advisories: [],
    });
    // @ts-expect-error write failure is before cleanup, so vanished_count must be 0
    out({
      ok: false, code: "STATE_COMPACT_WRITE_FAILED", phase: "verify_pack",
      cleanup_pending: true, partial_applied: true, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 2, vanished_count: 1,
      skipped: [], advisories: [],
    });
    // @ts-expect-error already_cleaned never started cleanup, so vanished_count must be 0
    out({
      ok: true, kind: "already_cleaned", cleanup_pending: false,
      partial_applied: false, cleanup_started: false,
      loose_deleted_count: 0, cleanup_remaining_loose: 0, vanished_count: 3, advisories: [],
    });
    // @ts-expect-error CLEANUP_INCOMPLETE deleted files, so partial_applied cannot be false
    out({
      ok: false, code: "STATE_COMPACT_CLEANUP_INCOMPLETE",
      cleanup_pending: true, partial_applied: false, cleanup_started: true,
      loose_deleted_count: 1, cleanup_remaining_loose: 1, vanished_count: 0,
      skipped: [{ path: "x", reason: "task_not_in_snapshot" }], advisories: [],
    });
    // @ts-expect-error CLEANUP_FAILED deleted files, so partial_applied cannot be false
    out({
      ok: false, code: "STATE_COMPACT_CLEANUP_FAILED", block: "pack_stale_after_cleanup",
      cleanup_pending: true, partial_applied: false, cleanup_started: true,
      loose_deleted_count: 2, cleanup_remaining_loose: 1, vanished_count: 0,
      skipped: [{ path: "y", reason: "appeared_during_cleanup" }], advisories: [],
    });

    // The call above only exist to host the @ts-expect-error directives; the test
    // passes iff each directive sees a real type error (tsc fails otherwise).
    expect(typeof out).toBe("function");
  });
});

describe("classifyLoosePackRelationship — the cell 11/12/13/14 split", () => {
  const set = (...ids: string[]) => new Set(ids);

  it("empty — no loose remains (cell 11)", () => {
    expect(classifyLoosePackRelationship(set(), set("a", "b"))).toBe("empty");
    // empty wins even against an empty pack.
    expect(classifyLoosePackRelationship(set(), set())).toBe("empty");
  });

  it("equal — loose id-set equals pack id-set (cell 12, clean the full set)", () => {
    expect(classifyLoosePackRelationship(set("a", "b"), set("a", "b"))).toBe("equal");
    expect(classifyLoosePackRelationship(set("a"), set("a"))).toBe("equal");
  });

  it("strict_subset — non-empty, every loose id in pack, loose ⊊ pack (cell 14, resumable)", () => {
    // The partial-cleanup case: pack covers {a,b}, only {a} survived a prior unlink.
    expect(classifyLoosePackRelationship(set("a"), set("a", "b"))).toBe("strict_subset");
    expect(classifyLoosePackRelationship(set("a", "b"), set("a", "b", "c"))).toBe("strict_subset");
  });

  it("diverged — at least one loose id NOT in pack (cell 13, pack_stale; never unlink)", () => {
    // An extra id outside the pack: not a clean subset, genuine staleness.
    expect(classifyLoosePackRelationship(set("a", "z"), set("a", "b"))).toBe("diverged");
    expect(classifyLoosePackRelationship(set("z"), set("a", "b"))).toBe("diverged");
  });

  it("diverged by membership, not count — same size, different members is NOT equal", () => {
    // {a,c} and {a,b} are both size 2; c ∉ pack makes it diverged, not equal.
    expect(classifyLoosePackRelationship(set("a", "c"), set("a", "b"))).toBe("diverged");
  });

  it("diverged is checked before subset/equal — an extra id is never read as resumable", () => {
    // loose has every pack id PLUS an extra → diverged (a superset is not a subset).
    expect(classifyLoosePackRelationship(set("a", "b", "z"), set("a", "b"))).toBe("diverged");
  });
});
