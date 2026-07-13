// P30 — Adapter contract hardening. Unit tests for the pure conformance
// helpers: the post-P29 `task prepare` primary checks, the activation-
// rule presence check, the version→severity gating, and the
// compliance computation (advisory failures do not break compliance).

import { describe, it, expect } from "vitest";

import {
  gteVersion,
  resolveBoundedRepairSeverity,
  resolveHardeningSeverity,
  resolveConsumptionSeverity,
  checkConsumptionAnchors,
  checkTaskPrepareIsPrimary,
  checkNoContractAntipatterns,
  checkActivationRulesDocumented,
  isAdapterCompliant,
  type ConformanceCheck,
} from "../../../src/commands/adapter-conformance.ts";
import {
  ADAPTER_CONTRACT_HARDENING_FROM_VERSION,
  BOUNDED_REPAIR_GUIDANCE_FROM_VERSION,
  RECOMMENDATION_CONSUMPTION_FROM_VERSION,
} from "../../../src/core/adapters/conformance-spec.ts";

describe("gteVersion", () => {
  it("compares semver cores numerically (not lexically)", () => {
    expect(gteVersion("1.14.0", "1.14.0")).toBe(true);
    expect(gteVersion("1.14.1", "1.14.0")).toBe(true);
    expect(gteVersion("2.0.0", "1.14.0")).toBe(true);
    expect(gteVersion("1.13.3", "1.14.0")).toBe(false);
    expect(gteVersion("1.9.0", "1.14.0")).toBe(false); // 9 < 14 numerically
  });

  it("orders a prerelease below the equal-core release", () => {
    expect(gteVersion("1.14.0-rc.1", "1.14.0")).toBe(false);
    expect(gteVersion("1.14.1-rc.1", "1.14.0")).toBe(true); // higher core wins
  });

  it("returns false for an unparseable left operand", () => {
    expect(gteVersion("not-a-version", "1.14.0")).toBe(false);
    expect(gteVersion("1.14", "1.14.0")).toBe(false);
  });
});

describe("resolveHardeningSeverity", () => {
  it("is advisory when generator_version is missing or below threshold", () => {
    expect(resolveHardeningSeverity(undefined)).toBe("advisory");
    expect(resolveHardeningSeverity("0.9.0-alpha.0")).toBe("advisory");
    expect(resolveHardeningSeverity("1.13.3")).toBe("advisory");
  });

  it("is required at or above the threshold", () => {
    expect(resolveHardeningSeverity(ADAPTER_CONTRACT_HARDENING_FROM_VERSION)).toBe(
      "required",
    );
    expect(resolveHardeningSeverity("1.14.0")).toBe("required");
    expect(resolveHardeningSeverity("2.3.4")).toBe("required");
  });
});

describe("resolveConsumptionSeverity (P33, own threshold)", () => {
  it("is advisory when generator_version is missing or below the P33 threshold", () => {
    expect(resolveConsumptionSeverity(undefined)).toBe("advisory");
    // The existing P30 threshold (1.14.0) must NOT make P33 checks required —
    // 1.14–1.25 adapters predate the consumption guidance.
    expect(resolveConsumptionSeverity(ADAPTER_CONTRACT_HARDENING_FROM_VERSION)).toBe(
      "advisory",
    );
    expect(resolveConsumptionSeverity("1.25.0")).toBe("advisory");
  });

  it("is required at or above the P33 threshold", () => {
    expect(
      resolveConsumptionSeverity(RECOMMENDATION_CONSUMPTION_FROM_VERSION),
    ).toBe("required");
    expect(resolveConsumptionSeverity("2.0.0")).toBe("required");
  });
});

describe("resolveBoundedRepairSeverity (P51, own threshold)", () => {
  it("is advisory when generator_version is missing or before bounded repair shipped", () => {
    expect(resolveBoundedRepairSeverity(undefined)).toBe("advisory");
    expect(resolveBoundedRepairSeverity("2.1.0")).toBe("advisory");
  });

  it("is required at or above the bounded repair threshold", () => {
    expect(resolveBoundedRepairSeverity(BOUNDED_REPAIR_GUIDANCE_FROM_VERSION)).toBe(
      "required",
    );
    expect(resolveBoundedRepairSeverity("2.2.0")).toBe("required");
  });
});

describe("checkConsumptionAnchors (P33)", () => {
  it("passes when every anchor is present", () => {
    const content = "read data.recommendation; lifecycleMode record_only";
    expect(checkConsumptionAnchors(content, ["data.recommendation"]).ok).toBe(true);
    expect(
      checkConsumptionAnchors(content, ["lifecycleMode", "record_only"]).ok,
    ).toBe(true);
  });

  it("fails and names the missing anchors", () => {
    const r = checkConsumptionAnchors("only lifecycleMode here", [
      "lifecycleMode",
      "record_only",
    ]);
    expect(r.ok).toBe(false);
    expect(r.details.missing).toEqual(["record_only"]);
  });
});

describe("checkTaskPrepareIsPrimary", () => {
  it("passes when task prepare precedes recommend and task context", () => {
    const content = [
      "0. code-pact task prepare <task-id> --agent claude-code --json",
      "Diagnostics: code-pact recommend ...; code-pact task context ...",
    ].join("\n");
    expect(checkTaskPrepareIsPrimary(content).ok).toBe(true);
  });

  it("fails when recommend is introduced before task prepare", () => {
    const content = [
      "0. code-pact recommend --phase <p> --task <t> --json",
      "1. code-pact task prepare <task-id> --agent claude-code --json",
    ].join("\n");
    const r = checkTaskPrepareIsPrimary(content);
    expect(r.ok).toBe(false);
    expect(r.details.preceded_by).toContain("code-pact recommend");
  });

  it("fails when task prepare is absent entirely", () => {
    expect(checkTaskPrepareIsPrimary("code-pact task context <t>").ok).toBe(false);
  });
});

describe("checkNoContractAntipatterns", () => {
  it("passes on guidance free of the P29 anti-patterns", () => {
    const content = "code-pact task finalize <id> --write --json";
    expect(checkNoContractAntipatterns(content).ok).toBe(true);
  });

  it("fails on the `task finalize ... --agent` anti-pattern", () => {
    const content = "code-pact task finalize <id> --agent <agent>";
    const r = checkNoContractAntipatterns(content);
    expect(r.ok).toBe(false);
    expect(r.details.found).toContain("finalize_agent_flag");
  });
});

describe("checkActivationRulesDocumented", () => {
  const conformant = [
    "Run `task finalize --write` only after `task complete`.",
    "If next_action.type is `wait_for_dependencies`, do not implement.",
    "On `CONTEXT_OVER_BUDGET`, report rather than widen.",
  ].join("\n");

  it("passes when every activation-rule anchor is present", () => {
    expect(checkActivationRulesDocumented(conformant).ok).toBe(true);
  });

  it("fails and names the missing rule when an anchor is absent", () => {
    const missingBudget = conformant.replace("CONTEXT_OVER_BUDGET", "over budget");
    const r = checkActivationRulesDocumented(missingBudget);
    expect(r.ok).toBe(false);
    expect(r.details.missing).toContain("context_over_budget");
  });

  it("documents that it checks presence, not runtime obedience", () => {
    expect(String(checkActivationRulesDocumented(conformant).details.checks)).toContain(
      "not runtime obedience",
    );
  });
});

describe("isAdapterCompliant", () => {
  const required = (status: "pass" | "fail"): ConformanceCheck => ({
    id: "x",
    status,
    severity: "required",
  });
  const advisory = (status: "pass" | "fail"): ConformanceCheck => ({
    id: "y",
    status,
    severity: "advisory",
  });

  it("is true when all checks pass", () => {
    expect(isAdapterCompliant([required("pass"), advisory("pass")])).toBe(true);
  });

  it("stays true when only advisory checks fail", () => {
    expect(isAdapterCompliant([required("pass"), advisory("fail")])).toBe(true);
  });

  it("is false when a required check fails", () => {
    expect(isAdapterCompliant([required("fail"), advisory("pass")])).toBe(false);
  });
});
