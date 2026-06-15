import { describe, expect, it } from "vitest";
import { closesClaimProblem } from "../../../scripts/closes-claim.mjs";

// Rule #9 of check-doc-invariants: a CHANGELOG "closes Pxx" claim must reference a
// `done` phase — live OR archived. The verdict is the pure `closesClaimProblem`; these
// pin it, especially the fail-closed identity check (a snapshot is accepted only when its
// INTERNAL phase_id matches the claimed id — never the filename alone) and the
// archived-tolerance (a terminal snapshot satisfies the claim after the live YAML is gone).

const liveDone = { file: "P16-x.yaml", body: "id: P16\nstatus: done\n" };
const livePlanned = { file: "P16-x.yaml", body: "id: P16\nstatus: planned\n" };

describe("closesClaimProblem — live phase", () => {
  it("live + done → satisfied (null)", () => {
    expect(closesClaimProblem("P16", liveDone, null)).toBeNull();
  });
  it("live + not-done → problem (status not done)", () => {
    const p = closesClaimProblem("P16", livePlanned, null);
    expect(p?.rel).toBe("design/phases/P16-x.yaml");
    expect(p?.msg).toContain('not "done"');
  });
});

describe("closesClaimProblem — archived phase (no live YAML)", () => {
  it("matching phase_id + done → satisfied (null)", () => {
    expect(closesClaimProblem("P16", undefined, { phase_id: "P16", phase_status: "done" })).toBeNull();
  });

  it("BLOCKER: snapshot phase_id does NOT match the claimed id → fail-closed", () => {
    // A misplaced/corrupt .../P16.json whose internal phase_id is P10 must NOT satisfy
    // "closes P16" — the filename is not trusted over the snapshot's own identity.
    const p = closesClaimProblem("P16", undefined, { phase_id: "P10", phase_status: "done" });
    expect(p).not.toBeNull();
    expect(p?.rel).toBe("CHANGELOG.md");
    expect(p?.msg).toContain('phase_id "P10"');
  });

  it("matching phase_id but not done → problem", () => {
    const p = closesClaimProblem("P16", undefined, { phase_id: "P16", phase_status: "cancelled" });
    expect(p?.msg).toContain('phase_status is "cancelled"');
  });

  it("snapshot with no phase_id field → fail-closed (treated as mismatch)", () => {
    const p = closesClaimProblem("P16", undefined, { phase_status: "done" });
    expect(p?.msg).toContain('phase_id "(none)"');
  });

  it("phase_id case-insensitive match (p16 → P16)", () => {
    expect(closesClaimProblem("P16", undefined, { phase_id: "p16", phase_status: "done" })).toBeNull();
  });
});

describe("closesClaimProblem — unresolved", () => {
  it("no live YAML and no snapshot → problem (nothing resolves it)", () => {
    const p = closesClaimProblem("P16", undefined, null);
    expect(p?.rel).toBe("CHANGELOG.md");
    expect(p?.msg).toContain("no archive snapshot resolves it");
  });

  it("snapshot present but unparseable → problem (distinct from missing)", () => {
    const p = closesClaimProblem("P16", undefined, "PARSE_ERROR");
    expect(p?.msg).toContain("unparseable");
  });
});
