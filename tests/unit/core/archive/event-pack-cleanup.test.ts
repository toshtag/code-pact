import { describe, expect, it } from "vitest";
import {
  classifyPostRunSurvivor,
  aggregateSurvivorVerdicts,
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

  it("any FAILED survivor makes the whole run FAILED", () => {
    const r = aggregateSurvivorVerdicts([incomplete, failed, incomplete]);
    expect(r.terminal).toBe("STATE_COMPACT_CLEANUP_FAILED");
    expect(r.skipped).toHaveLength(3);
  });

  it("collects every survivor's skip record (no silent truncation)", () => {
    const r = aggregateSurvivorVerdicts([incomplete, failed]);
    expect(r.skipped.map((s) => s.path)).toEqual(["a", "b"]);
  });
});
