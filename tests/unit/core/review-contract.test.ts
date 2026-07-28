import { describe, it, expect } from "vitest";
import type { Task } from "../../../src/core/schemas/task.ts";
import type { ReviewContract } from "../../../src/core/schemas/review-contract.ts";
import { ReviewContract as ReviewContractSchema } from "../../../src/core/schemas/review-contract.ts";
import {
  validateReviewContractForTask,
  assertSuppliedReviewContractValid,
} from "../../../src/core/review-contract.ts";

// ---------------------------------------------------------------------------
// Fixtures
//
// The declared scope below is what every ref in the contracts must resolve
// against: stage refs are covered by `reads`/`writes`; platform and evidence
// refs are covered by `writes`/`acceptance_refs`.
// ---------------------------------------------------------------------------

const READ_REF = "src/core/verify/classify.ts";
const WRITE_REF = "src/core/process/bounded-command.ts";
const ACCEPTANCE_REF = "tests/unit/core/windows-command-launch.test.ts";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "P1-T1",
    type: "feature",
    ambiguity: "medium",
    risk: "medium",
    context_size: "medium",
    write_surface: "medium",
    verification_strength: "strong",
    expected_duration: "medium",
    status: "planned",
    description: "A task",
    reads: [READ_REF],
    writes: [WRITE_REF],
    acceptance_refs: [ACCEPTANCE_REF],
    ...overrides,
  };
}

function minimalTask(overrides: Partial<Task> = {}): Task {
  return task({
    type: "docs",
    ambiguity: "low",
    risk: "low",
    write_surface: "low",
    ...overrides,
  });
}

function minimalContract(overrides: Partial<ReviewContract> = {}): ReviewContract {
  return {
    version: 1,
    mode: "minimal",
    rationale:
      "Documentation-only change with no executable, platform, or security boundary.",
    ...overrides,
  } as ReviewContract;
}

type StageEntry = NonNullable<ReviewContract["stages"]>[number];
type PlatformEntry = NonNullable<ReviewContract["platforms"]>[number];
type EvidenceEntry = NonNullable<ReviewContract["evidence"]>[number];

function stages(): StageEntry[] {
  return [
    {
      stage: "producer",
      disposition: "in_scope",
      claim: "The scope script emits flat argv.",
      refs: [READ_REF],
    },
    {
      stage: "consumer",
      disposition: "in_scope",
      claim: "The classifier validates the producer envelope.",
      refs: [READ_REF],
    },
    {
      stage: "runner",
      disposition: "in_scope",
      claim: "Validated argv reaches a bounded process runner.",
      refs: [WRITE_REF],
    },
    {
      stage: "os",
      disposition: "in_scope",
      claim: "Windows launch semantics are exercised on Windows.",
      refs: [WRITE_REF],
    },
    {
      stage: "security",
      disposition: "in_scope",
      claim: "Shell and filesystem authority boundaries fail closed.",
      refs: [WRITE_REF],
    },
  ];
}

function platforms(): PlatformEntry[] {
  return [
    {
      platform: "linux",
      disposition: "required",
      level: "integration",
      refs: [ACCEPTANCE_REF],
    },
    {
      platform: "macos",
      disposition: "not_required",
      rationale: "No macOS-specific launch or filesystem behavior changes.",
    },
    {
      platform: "windows",
      disposition: "required",
      level: "actual_platform",
      refs: [ACCEPTANCE_REF],
    },
  ];
}

function evidence(): EvidenceEntry[] {
  return [
    {
      id: "flat-argv-contract",
      claim: "Producer and consumer agree on a non-empty flat argv.",
      level: "integration",
      refs: [WRITE_REF],
    },
    {
      id: "windows-runtime",
      claim: "The real Windows package-manager launch succeeds.",
      level: "actual_platform",
      platform: "windows",
      refs: [ACCEPTANCE_REF],
    },
  ];
}

function boundaryContract(
  overrides: Partial<ReviewContract> = {},
): ReviewContract {
  return {
    version: 1,
    mode: "boundary",
    stages: stages(),
    platforms: platforms(),
    evidence: evidence(),
    ...overrides,
  } as ReviewContract;
}

function reasons(t: Task): string[] {
  return validateReviewContractForTask(t).map(
    issue => String(issue.details?.reason ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Schema — strict object handling
// ---------------------------------------------------------------------------

describe("ReviewContract schema", () => {
  it("accepts a minimal contract", () => {
    expect(ReviewContractSchema.safeParse(minimalContract()).success).toBe(true);
  });

  it("accepts a boundary contract", () => {
    expect(ReviewContractSchema.safeParse(boundaryContract()).success).toBe(
      true,
    );
  });

  it("rejects an unknown key on the contract", () => {
    const parsed = ReviewContractSchema.safeParse({
      ...minimalContract(),
      raitonale: "typo",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown key on a stage entry", () => {
    const bad = stages();
    (bad[0] as unknown as Record<string, unknown>).clam = "typo";
    expect(
      ReviewContractSchema.safeParse(boundaryContract({ stages: bad })).success,
    ).toBe(false);
  });

  it("rejects an unknown key on a platform entry", () => {
    const bad = platforms();
    (bad[0] as unknown as Record<string, unknown>).lvl = "integration";
    expect(
      ReviewContractSchema.safeParse(boundaryContract({ platforms: bad }))
        .success,
    ).toBe(false);
  });

  it("rejects an unknown key on an evidence entry", () => {
    const bad = evidence();
    (bad[0] as unknown as Record<string, unknown>).plateform = "linux";
    expect(
      ReviewContractSchema.safeParse(boundaryContract({ evidence: bad }))
        .success,
    ).toBe(false);
  });

  it("rejects an unknown stage name", () => {
    const bad = stages();
    (bad[0] as unknown as Record<string, unknown>).stage = "deployment";
    expect(
      ReviewContractSchema.safeParse(boundaryContract({ stages: bad })).success,
    ).toBe(false);
  });

  it("rejects an unknown platform name", () => {
    const bad = platforms();
    (bad[0] as unknown as Record<string, unknown>).platform = "freebsd";
    expect(
      ReviewContractSchema.safeParse(boundaryContract({ platforms: bad }))
        .success,
    ).toBe(false);
  });

  it("rejects a version other than 1", () => {
    expect(
      ReviewContractSchema.safeParse({ ...minimalContract(), version: 2 })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Minimal mode
// ---------------------------------------------------------------------------

describe("minimal review contracts", () => {
  it("accepts a docs task with all-low readiness metadata", () => {
    expect(
      validateReviewContractForTask(
        minimalTask({ review_contract: minimalContract() }),
      ),
    ).toEqual([]);
  });

  it("accepts a mechanical_refactor task with all-low readiness metadata", () => {
    expect(
      validateReviewContractForTask(
        minimalTask({
          type: "mechanical_refactor",
          review_contract: minimalContract(),
        }),
      ),
    ).toEqual([]);
  });

  it("rejects minimal mode for a feature task", () => {
    expect(
      reasons(minimalTask({ type: "feature", review_contract: minimalContract() })),
    ).toContain("minimal_mode_not_allowed");
  });

  it("rejects minimal mode for a bugfix task", () => {
    expect(
      reasons(minimalTask({ type: "bugfix", review_contract: minimalContract() })),
    ).toContain("minimal_mode_not_allowed");
  });

  it("rejects minimal mode at risk: medium", () => {
    expect(
      reasons(minimalTask({ risk: "medium", review_contract: minimalContract() })),
    ).toContain("minimal_mode_not_allowed");
  });

  it("rejects minimal mode at ambiguity: medium", () => {
    expect(
      reasons(
        minimalTask({ ambiguity: "medium", review_contract: minimalContract() }),
      ),
    ).toContain("minimal_mode_not_allowed");
  });

  it("rejects minimal mode at write_surface: medium", () => {
    expect(
      reasons(
        minimalTask({
          write_surface: "medium",
          review_contract: minimalContract(),
        }),
      ),
    ).toContain("minimal_mode_not_allowed");
  });

  it("rejects a minimal contract with a blank rationale", () => {
    expect(
      reasons(
        minimalTask({ review_contract: minimalContract({ rationale: "   " }) }),
      ),
    ).toContain("minimal_rationale_missing");
  });

  it("rejects a minimal contract that carries boundary fields", () => {
    expect(
      reasons(
        minimalTask({
          review_contract: minimalContract({ stages: stages() }),
        }),
      ),
    ).toContain("minimal_boundary_fields_present");
  });
});

// ---------------------------------------------------------------------------
// Boundary mode — stages
// ---------------------------------------------------------------------------

describe("boundary review contracts", () => {
  it("accepts a complete boundary contract", () => {
    expect(
      validateReviewContractForTask(
        task({ review_contract: boundaryContract() }),
      ),
    ).toEqual([]);
  });

  it("accepts a not_applicable stage with a rationale and no refs", () => {
    const s = stages();
    s[4] = {
      stage: "security",
      disposition: "not_applicable",
      rationale: "No shell, filesystem, or network authority is touched.",
    };
    expect(
      validateReviewContractForTask(
        task({ review_contract: boundaryContract({ stages: s }) }),
      ),
    ).toEqual([]);
  });

  it("rejects a missing stage", () => {
    const s = stages().filter(entry => entry.stage !== "runner");
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("boundary_stage_missing");
  });

  it("rejects a duplicate stage", () => {
    const s = stages();
    s.push({ ...s[0]! });
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("boundary_stage_duplicate");
  });

  it("rejects an in_scope stage with no refs", () => {
    const s = stages();
    s[0] = { ...s[0]!, refs: [] };
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("boundary_stage_refs_missing");
  });

  it("rejects an in_scope stage with a blank claim", () => {
    const s = stages();
    s[0] = { ...s[0]!, claim: "  " };
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("boundary_stage_claim_missing");
  });

  it("rejects a not_applicable stage that still declares refs", () => {
    const s = stages();
    s[4] = {
      stage: "security",
      disposition: "not_applicable",
      rationale: "Nothing security-relevant changes.",
      refs: [WRITE_REF],
    };
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("boundary_stage_refs_not_allowed");
  });

  it("rejects a not_applicable stage with no rationale", () => {
    const s = stages();
    s[4] = { stage: "security", disposition: "not_applicable" };
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("boundary_stage_rationale_missing");
  });

  // -------------------------------------------------------------------------
  // Boundary mode — platform matrix
  // -------------------------------------------------------------------------

  it("rejects a missing platform", () => {
    const p = platforms().filter(entry => entry.platform !== "macos");
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_missing");
  });

  it("rejects a duplicate platform", () => {
    const p = platforms();
    p.push({ ...p[0]! });
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_duplicate");
  });

  it("rejects a required platform with no refs", () => {
    const p = platforms();
    p[0] = { ...p[0]!, refs: [] };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_refs_missing");
  });

  it("rejects a required platform with no level", () => {
    const p = platforms();
    p[0] = {
      platform: "linux",
      disposition: "required",
      refs: [ACCEPTANCE_REF],
    };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_level_missing");
  });

  it("rejects a required platform whose level is only unit", () => {
    const p = platforms();
    p[0] = { ...p[0]!, level: "unit" };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_level_too_weak");
  });

  it("rejects a not_required platform that still declares refs", () => {
    const p = platforms();
    p[1] = {
      platform: "macos",
      disposition: "not_required",
      rationale: "No macOS-specific behavior changes.",
      refs: [ACCEPTANCE_REF],
    };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_refs_not_allowed");
  });

  it("rejects a not_required platform with no rationale", () => {
    const p = platforms();
    p[1] = { platform: "macos", disposition: "not_required" };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("platform_rationale_missing");
  });

  it("rejects an in_scope os stage with no actual-platform requirement", () => {
    const p = platforms();
    p[2] = { ...p[2]!, level: "integration" };
    const e = evidence().filter(entry => entry.level !== "actual_platform");
    expect(
      reasons(
        task({
          review_contract: boundaryContract({ platforms: p, evidence: e }),
        }),
      ),
    ).toContain("os_stage_requires_actual_platform");
  });

  it("accepts a not_applicable os stage with no actual-platform requirement", () => {
    const s = stages();
    s[3] = {
      stage: "os",
      disposition: "not_applicable",
      rationale: "No OS-specific launch or filesystem behavior changes.",
    };
    const p = platforms();
    p[2] = { ...p[2]!, level: "integration" };
    const e = evidence().filter(entry => entry.level !== "actual_platform");
    expect(
      validateReviewContractForTask(
        task({
          review_contract: boundaryContract({
            stages: s,
            platforms: p,
            evidence: e,
          }),
        }),
      ),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Boundary mode — evidence
  // -------------------------------------------------------------------------

  it("rejects an empty evidence list", () => {
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: [] }) })),
    ).toContain("evidence_missing");
  });

  it("rejects a duplicate evidence id", () => {
    const e = evidence();
    e.push({ ...e[0]! });
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: e }) })),
    ).toContain("evidence_id_duplicate");
  });

  it("rejects evidence with a blank claim", () => {
    const e = evidence();
    e[0] = { ...e[0]!, claim: " " };
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: e }) })),
    ).toContain("evidence_claim_missing");
  });

  it("rejects evidence with no refs", () => {
    const e = evidence();
    e[0] = { ...e[0]!, refs: [] };
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: e }) })),
    ).toContain("evidence_refs_missing");
  });

  it("rejects actual_platform evidence with no platform", () => {
    const e = evidence();
    e[1] = {
      id: "windows-runtime",
      claim: "The real Windows launch succeeds.",
      level: "actual_platform",
      refs: [ACCEPTANCE_REF],
    };
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: e }) })),
    ).toContain("evidence_platform_missing");
  });

  it("rejects actual_platform evidence bound to a not_required platform", () => {
    const e = evidence();
    e[1] = { ...e[1]!, platform: "macos" };
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: e }) })),
    ).toContain("evidence_platform_not_required");
  });

  it("rejects actual_platform evidence whose platform level is weaker", () => {
    const p = platforms();
    p[2] = { ...p[2]!, level: "integration" };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("evidence_platform_level_mismatch");
  });

  // -------------------------------------------------------------------------
  // Ref coherence
  // -------------------------------------------------------------------------

  it("rejects a stage ref that is not a safe repository-relative path", () => {
    const s = stages();
    s[0] = { ...s[0]!, refs: ["../outside.ts"] };
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("ref_unsafe_path");
  });

  it("rejects an absolute evidence ref", () => {
    const e = evidence();
    e[0] = { ...e[0]!, refs: ["/etc/passwd"] };
    expect(
      reasons(task({ review_contract: boundaryContract({ evidence: e }) })),
    ).toContain("ref_unsafe_path");
  });

  it("rejects a stage ref outside reads and writes", () => {
    const s = stages();
    s[0] = { ...s[0]!, refs: ["src/core/unrelated.ts"] };
    expect(
      reasons(task({ review_contract: boundaryContract({ stages: s }) })),
    ).toContain("ref_outside_task_scope");
  });

  it("accepts a stage ref covered by a reads glob", () => {
    const s = stages();
    s[0] = { ...s[0]!, refs: ["src/core/verify/nested/deep.ts"] };
    expect(
      validateReviewContractForTask(
        task({
          reads: ["src/core/verify/**"],
          review_contract: boundaryContract({ stages: s }),
        }),
      ),
    ).toEqual([]);
  });

  it("rejects a platform ref that only appears in reads", () => {
    const p = platforms();
    p[0] = { ...p[0]!, refs: [READ_REF] };
    expect(
      reasons(task({ review_contract: boundaryContract({ platforms: p }) })),
    ).toContain("ref_outside_task_scope");
  });

  it("accepts an evidence ref covered by acceptance_refs", () => {
    const e = evidence();
    e[0] = { ...e[0]!, refs: [ACCEPTANCE_REF] };
    expect(
      validateReviewContractForTask(
        task({ review_contract: boundaryContract({ evidence: e }) }),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lock readiness gate
// ---------------------------------------------------------------------------

describe("assertSuppliedReviewContractValid", () => {
  it("passes for a valid boundary contract", () => {
    expect(() =>
      assertSuppliedReviewContractValid(
        task({ review_contract: boundaryContract() }),
      ),
    ).not.toThrow();
  });

  it("passes for a valid minimal contract", () => {
    expect(() =>
      assertSuppliedReviewContractValid(
        minimalTask({ review_contract: minimalContract() }),
      ),
    ).not.toThrow();
  });

  it("passes when the task declares no contract at all", () => {
    // The missing-contract refusal is NOT part of this stage: activating it
    // needs an authoring path and a rollout policy, both of which land with the
    // migration. Until then a task with no contract locks exactly as before,
    // and plan lint's advisory is what surfaces the gap.
    expect(() => assertSuppliedReviewContractValid(task())).not.toThrow();
  });

  it("throws TASK_REVIEW_CONTRACT_INVALID for a semantically invalid contract", () => {
    expect(() =>
      assertSuppliedReviewContractValid(
        task({ review_contract: minimalContract() }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "TASK_REVIEW_CONTRACT_INVALID" }),
    );
  });

  it("reports every invalid reason on the thrown error", () => {
    let thrown: unknown;
    try {
      assertSuppliedReviewContractValid(
        task({
          review_contract: boundaryContract({
            stages: stages().filter(entry => entry.stage !== "runner"),
          }),
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const issues = (thrown as { issues?: { details?: { reason?: string } }[] })
      .issues;
    expect(issues?.map(i => i.details?.reason)).toContain(
      "boundary_stage_missing",
    );
  });

  it("returns no issues for a task with no contract", () => {
    // Absence is not a semantic failure — the plan-lint advisory reports it
    // separately so historical tasks stay clean.
    expect(validateReviewContractForTask(task())).toEqual([]);
  });
});
