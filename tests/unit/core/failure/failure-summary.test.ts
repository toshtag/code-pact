import { describe, expect, it } from "vitest";
import {
  buildFailureSummaryFromChecks,
  buildFailureSummaryFromFinalizeCode,
  type FailureCheckLike,
} from "../../../../src/core/failure/failure-summary.ts";

const ok = (name: string): FailureCheckLike => ({ name, ok: true });
const fail = (name: string, reason?: string): FailureCheckLike => ({
  name,
  ok: false,
  reason,
});

describe("buildFailureSummaryFromChecks", () => {
  it("returns an empty summary when there are no checks", () => {
    expect(buildFailureSummaryFromChecks([], "P1-T1")).toEqual({
      failed_checks: [],
      first_failure: null,
      suggested_next_command: null,
    });
  });

  it("returns an empty summary when every check passed", () => {
    expect(
      buildFailureSummaryFromChecks([ok("commands"), ok("decision")], "P1-T1"),
    ).toEqual({
      failed_checks: [],
      first_failure: null,
      suggested_next_command: null,
    });
  });

  it("maps a failing commands check to `task complete`", () => {
    expect(
      buildFailureSummaryFromChecks(
        [fail("commands", '"false" exited with code 1')],
        "P1-T1",
      ),
    ).toEqual({
      failed_checks: ["commands"],
      first_failure: { name: "commands", reason: '"false" exited with code 1' },
      suggested_next_command: "code-pact task complete P1-T1",
    });
  });

  it("maps a failing decision check to `task complete`", () => {
    const reason = 'decision_refs for "P2-T1" not all accepted: ...';
    expect(
      buildFailureSummaryFromChecks([fail("decision", reason)], "P2-T1"),
    ).toEqual({
      failed_checks: ["decision"],
      first_failure: { name: "decision", reason },
      suggested_next_command: "code-pact task complete P2-T1",
    });
  });

  it("maps a failing task_status check to `task finalize --write`", () => {
    const s = buildFailureSummaryFromChecks([fail("task_status", "r")], "P1-T1");
    expect(s.suggested_next_command).toBe("code-pact task finalize P1-T1 --write");
  });

  it("maps a failing progress_event check to `task complete`", () => {
    const s = buildFailureSummaryFromChecks(
      [fail("progress_event", "r")],
      "P1-T1",
    );
    expect(s.suggested_next_command).toBe("code-pact task complete P1-T1");
  });

  it("returns null for an unknown check name", () => {
    const s = buildFailureSummaryFromChecks([fail("mystery", "r")], "P1-T1");
    expect(s.first_failure).toEqual({ name: "mystery", reason: "r" });
    expect(s.suggested_next_command).toBeNull();
  });

  it("preserves verify order, lists all failures, and the first one wins", () => {
    const s = buildFailureSummaryFromChecks(
      [ok("commands"), fail("decision", "d"), fail("task_status", "t")],
      "P1-T1",
    );
    expect(s.failed_checks).toEqual(["decision", "task_status"]);
    expect(s.first_failure).toEqual({ name: "decision", reason: "d" });
    expect(s.suggested_next_command).toBe("code-pact task complete P1-T1");
  });

  it("coerces a missing reason to an empty string", () => {
    const s = buildFailureSummaryFromChecks([fail("commands")], "P1-T1");
    expect(s.first_failure).toEqual({ name: "commands", reason: "" });
  });
});

describe("buildFailureSummaryFromFinalizeCode", () => {
  it("maps TASK_FINALIZE_NOT_ELIGIBLE to eligibility + `task complete`", () => {
    expect(
      buildFailureSummaryFromFinalizeCode(
        "TASK_FINALIZE_NOT_ELIGIBLE",
        "P1-T1",
        "not done yet",
      ),
    ).toEqual({
      failed_checks: ["eligibility"],
      first_failure: { name: "eligibility", reason: "not done yet" },
      suggested_next_command: "code-pact task complete P1-T1",
    });
  });

  it("maps TASK_FINALIZE_WRITE_REFUSED to write_safety + null command", () => {
    const s = buildFailureSummaryFromFinalizeCode(
      "TASK_FINALIZE_WRITE_REFUSED",
      "P1-T1",
      "unsafe path",
    );
    expect(s.first_failure).toEqual({ name: "write_safety", reason: "unsafe path" });
    expect(s.suggested_next_command).toBeNull();
  });

  it("maps WRITES_AUDIT_STRICT_FAILED to write_audit + null command", () => {
    const s = buildFailureSummaryFromFinalizeCode(
      "WRITES_AUDIT_STRICT_FAILED",
      "P1-T1",
      "audit-strict + warnings",
    );
    expect(s.first_failure).toEqual({
      name: "write_audit",
      reason: "audit-strict + warnings",
    });
    expect(s.suggested_next_command).toBeNull();
  });
});
