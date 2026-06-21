import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectDuplicatePhaseIds,
  detectDuplicateTaskIds,
  detectOrphanProgressEvents,
  detectProgressEventConflicts,
  detectPhaseIdMismatches,
  detectPhaseIdNaming,
  detectTaskIdPhasePrefix,
  detectTaskAcceptanceRefNotFound,
  detectTaskAcceptanceRefUnsafePath,
  detectTaskDecisionRefNotFound,
  detectTaskDecisionRefUnsafePath,
  detectTaskDependsOnSelfReference,
  detectTaskDependsOnUnresolved,
  detectTaskReadsGlobInvalid,
  detectTaskReadsNoMatch,
  detectTaskReadsUnsafePath,
  detectTaskWritesGlobInvalid,
  detectTaskWritesOverBroad,
  detectTaskWritesProtectedPath,
  detectTaskWritesUnsafePath,
} from "../../../../src/core/plan/checks.ts";
import type { PhaseEntry } from "../../../../src/core/plan/state.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status: "planned",
    ...overrides,
  };
}

function phase(
  id: string,
  tasks: Task[] = [],
  overrides: Partial<Phase> = {},
): Phase {
  return {
    id,
    name: id,
    weight: 10,
    confidence: "medium",
    risk: "low",
    status: "planned",
    objective: "Test objective long enough",
    definition_of_done: ["does the thing"],
    verification: { commands: ["pnpm test"] },
    tasks,
    ...overrides,
  };
}

function entry(p: Phase, refId = p.id): PhaseEntry {
  return {
    ref: { id: refId, path: `design/phases/${p.id}.yaml`, weight: p.weight },
    absPath: `/tmp/${p.id}.yaml`,
    phase: p,
  };
}

describe("detectDuplicateTaskIds", () => {
  it("returns empty when all task ids are unique", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1"), task("P1-T2")])),
      entry(phase("P2", [task("P2-T1")])),
    ];
    expect(detectDuplicateTaskIds(entries)).toEqual([]);
  });

  it("reports the second occurrence across phases", () => {
    const entries = [
      entry(phase("P1", [task("SHARED-T1")])),
      entry(phase("P2", [task("SHARED-T1")])),
    ];
    const issues = detectDuplicateTaskIds(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_TASK_ID");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("SHARED-T1");
    expect(issues[0]?.task_id).toBe("SHARED-T1");
    // Disambiguate by FILE, not just phase id — so two phase files that also
    // share a phase id don't both read as "phase P7".
    expect(issues[0]?.file).toBe("design/phases/P2.yaml");
    expect(issues[0]?.message).toContain("design/phases/P2.yaml");
    // Machine-readable collision pair (JSON-first DX): both files, both phases.
    expect(issues[0]?.details?.colliding_files).toEqual([
      "design/phases/P1.yaml",
      "design/phases/P2.yaml",
    ]);
    expect(issues[0]?.details?.colliding_phases).toEqual(["P1", "P2"]);
    // Actionable recovery (control-plane v2 PR1b re-scope): manual edit +
    // re-verify command, naming both colliding files.
    expect(issues[0]?.recovery?.manual_action).toContain("design/phases/P2.yaml");
    expect(issues[0]?.recovery?.confirm).toBe("code-pact plan lint");
    expect(issues[0]?.recovery?.reference).toContain("design/phases/P1.yaml");
    expect(issues[0]?.recovery?.reference).toContain("DUPLICATE_TASK_ID");
  });
});

describe("detectDuplicatePhaseIds", () => {
  it("returns empty when phase ids are unique", () => {
    const entries = [entry(phase("P1")), entry(phase("P2"))];
    expect(detectDuplicatePhaseIds(entries)).toEqual([]);
  });

  it("reports the second occurrence", () => {
    // Two phase files that both claim id P1 (the clean-but-wrong merge): same id,
    // DISTINCT paths — so the collision pair names two real files.
    const entries: PhaseEntry[] = [
      { ref: { id: "P1", path: "design/phases/P1-a.yaml", weight: 10 }, absPath: "/tmp/a.yaml", phase: phase("P1") },
      { ref: { id: "P1", path: "design/phases/P1-b.yaml", weight: 10 }, absPath: "/tmp/b.yaml", phase: phase("P1") },
    ];
    const issues = detectDuplicatePhaseIds(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("DUPLICATE_PHASE_ID");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.recovery?.manual_action).toContain("design/roadmap.yaml");
    expect(issues[0]?.recovery?.confirm).toBe("code-pact plan lint");
    expect(issues[0]?.recovery?.reference).toContain("DUPLICATE_PHASE_ID");
    // Machine-readable collision pair (both phase-file paths).
    expect(issues[0]?.details?.colliding_files).toEqual([
      "design/phases/P1-a.yaml",
      "design/phases/P1-b.yaml",
    ]);
  });
});

describe("detectPhaseIdMismatches", () => {
  it("returns empty when phase.id matches ref.id", () => {
    const entries = [entry(phase("P1"), "P1")];
    expect(detectPhaseIdMismatches(entries)).toEqual([]);
  });

  it("reports when phase.id does not match the roadmap ref", () => {
    const entries = [entry(phase("P1"), "P9")];
    const issues = detectPhaseIdMismatches(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PHASE_ID_MISMATCH");
    expect(issues[0]?.severity).toBe("error");
    // Recovery encodes expected vs actual + both ways to reconcile.
    expect(issues[0]?.recovery?.manual_action).toContain("id: P9"); // expected (ref.id)
    expect(issues[0]?.recovery?.manual_action).toContain('"P1"'); // actual (phase.id)
    expect(issues[0]?.recovery?.confirm).toBe("code-pact plan lint");
  });
});

describe("detectOrphanProgressEvents", () => {
  function ev(task_id: string): ProgressEvent {
    return {
      task_id,
      status: "done",
      at: "2026-05-18T09:00:00+00:00",
      actor: "agent",
    };
  }

  it("returns empty when every event references a known task", () => {
    const index = new Map([["P1-T1", true]]);
    expect(detectOrphanProgressEvents([ev("P1-T1")], index)).toEqual([]);
  });

  it("reports unknown task ids as warnings", () => {
    const index = new Map([["P1-T1", true]]);
    const issues = detectOrphanProgressEvents([ev("GHOST")], index);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("ORPHAN_PROGRESS_EVENT");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.task_id).toBe("GHOST");
  });

  it("deduplicates repeated unknown task ids so the user sees each ghost once", () => {
    const index = new Map([["P1-T1", true]]);
    const issues = detectOrphanProgressEvents(
      [ev("GHOST"), ev("GHOST"), ev("GHOST")],
      index,
    );
    expect(issues).toHaveLength(1);
  });
});

describe("detectPhaseIdNaming", () => {
  it("accepts P<N> style ids", () => {
    expect(detectPhaseIdNaming([entry(phase("P1")), entry(phase("P42"))])).toEqual(
      [],
    );
  });

  it("warns for non-conforming phase ids", () => {
    const issues = detectPhaseIdNaming([entry(phase("Phase1"))]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PHASE_ID_NAMING");
    expect(issues[0]?.severity).toBe("warning");
  });
});

describe("detectTaskIdPhasePrefix", () => {
  it("accepts <phase>-T<N> style task ids", () => {
    const entries = [entry(phase("P1", [task("P1-T1"), task("P1-T2")]))];
    expect(detectTaskIdPhasePrefix(entries)).toEqual([]);
  });

  it("warns when the task id does not start with the phase id", () => {
    const entries = [entry(phase("P1", [task("P2-T1")]))];
    const issues = detectTaskIdPhasePrefix(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_ID_PHASE_PREFIX");
    expect(issues[0]?.severity).toBe("warning");
  });
});

// ---------------------------------------------------------------------------
// P10 — Task Readiness Schema detectors
// ---------------------------------------------------------------------------

describe("detectTaskDependsOnUnresolved", () => {
  it("no issue when depends_on references existing tasks in the same phase", () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", { depends_on: ["P1-T2"] }),
          task("P1-T2"),
        ]),
      ),
    ];
    expect(detectTaskDependsOnUnresolved(entries)).toEqual([]);
  });

  it("error when depends_on references a task not in the same phase", () => {
    const entries = [
      entry(
        phase("P1", [task("P1-T1", { depends_on: ["P1-T9"] }), task("P1-T2")]),
      ),
    ];
    const issues = detectTaskDependsOnUnresolved(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DEPENDS_ON_UNRESOLVED");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.task_id).toBe("P1-T1");
    expect(issues[0]?.details?.value).toBe("P1-T9");
  });
});

describe("detectTaskDependsOnSelfReference", () => {
  it("no issue when depends_on contains only other task ids", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { depends_on: ["P1-T2"] }), task("P1-T2")])),
    ];
    expect(detectTaskDependsOnSelfReference(entries)).toEqual([]);
  });

  it("error when a task depends on itself", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { depends_on: ["P1-T1"] })])),
    ];
    const issues = detectTaskDependsOnSelfReference(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DEPENDS_ON_SELF_REFERENCE");
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.task_id).toBe("P1-T1");
  });
});

describe("detectTaskDecisionRefUnsafePath", () => {
  it("no issue for safe repo-root-relative paths", () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", { decision_refs: ["design/decisions/foo.md"] }),
        ]),
      ),
    ];
    expect(detectTaskDecisionRefUnsafePath(entries)).toEqual([]);
  });

  it("error for traversal attempts", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { decision_refs: ["../etc/passwd"] })])),
    ];
    const issues = detectTaskDecisionRefUnsafePath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DECISION_REF_UNSAFE_PATH");
    expect(issues[0]?.severity).toBe("error");
  });

  // Security (Blocker 1): the lint layer of the multi-layer defense. A safe
  // repo-relative path that is OUTSIDE the decision namespace (.env, a doc,
  // README/PRUNED) is still an error — the detector shares the schema's
  // `decisionRefPathReason`, so a value reaching lint by a non-schema route
  // is reported precisely.
  it.each([
    [".env", "in-project non-decision file"],
    ["docs/cli-contract.md", "doc outside the namespace"],
    ["design/decisions/README.md", "the index"],
    ["design/decisions/PRUNED.md", "the tombstone"],
    ["design/decisions/notes.txt", "not a .md"],
  ])("error for %s (%s)", (badRef) => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { decision_refs: [badRef] })])),
    ];
    const issues = detectTaskDecisionRefUnsafePath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DECISION_REF_UNSAFE_PATH");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectTaskReadsUnsafePath", () => {
  it("no issue for safe repo-root-relative globs", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { reads: ["src/commands/*.ts"] })])),
    ];
    expect(detectTaskReadsUnsafePath(entries)).toEqual([]);
  });

  it("error for absolute path in reads", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { reads: ["/etc/passwd"] })])),
    ];
    const issues = detectTaskReadsUnsafePath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_READS_UNSAFE_PATH");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectTaskReadsGlobInvalid", () => {
  it("no issue for in-subset globs", () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            reads: ["src/commands/*.ts", "tests/**/integration/*.test.ts"],
          }),
        ]),
      ),
    ];
    expect(detectTaskReadsGlobInvalid(entries)).toEqual([]);
  });

  it("error for brace expansion (out of subset)", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { reads: ["src/{a,b}/*.ts"] })])),
    ];
    const issues = detectTaskReadsGlobInvalid(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_READS_GLOB_INVALID");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectTaskWritesUnsafePath", () => {
  it("no issue for safe write globs", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["src/core/path-safety.ts"] })])),
    ];
    expect(detectTaskWritesUnsafePath(entries)).toEqual([]);
  });

  it("error for parent traversal in writes", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["../outside.txt"] })])),
    ];
    const issues = detectTaskWritesUnsafePath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_UNSAFE_PATH");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectTaskWritesGlobInvalid", () => {
  it("no issue for in-subset write globs", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["src/**/*.ts"] })])),
    ];
    expect(detectTaskWritesGlobInvalid(entries)).toEqual([]);
  });

  it("error for character class (out of subset)", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["src/[abc].ts"] })])),
    ];
    const issues = detectTaskWritesGlobInvalid(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_GLOB_INVALID");
    expect(issues[0]?.severity).toBe("error");
  });
});

describe("detectTaskWritesProtectedPath", () => {
  it("no issue when writes do not touch protected paths", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["src/commands/foo.ts"] })])),
    ];
    expect(detectTaskWritesProtectedPath(entries)).toEqual([]);
  });

  it("warning when writes target the design/phases protected pattern", () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", { writes: ["design/phases/P1-foundation.yaml"] }),
        ]),
      ),
    ];
    const issues = detectTaskWritesProtectedPath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_PROTECTED_PATH");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.details?.protected_pattern).toBe("design/phases/*.yaml");
  });

  it("warning when writes target the .code-pact protected tree", () => {
    const entries = [
      entry(
        phase("P1", [task("P1-T1", { writes: [".code-pact/state/progress.yaml"] })]),
      ),
    ];
    const issues = detectTaskWritesProtectedPath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_PROTECTED_PATH");
  });

  it("v1.6 P15-T3: respects an injected protected-paths list (override mode)", () => {
    // Caller (lint orchestrator) supplies a custom list. The defaults
    // are NOT consulted — the user overrode them.
    const customList = [
      { pattern: "secrets/**", sample: "secrets/x.env" },
    ] as const;

    // `design/roadmap.yaml` is in the hardcoded defaults but NOT in
    // the custom list — so no warning should fire here.
    const noiseEntries = [
      entry(phase("P1", [task("P1-T1", { writes: ["design/roadmap.yaml"] })])),
    ];
    expect(
      detectTaskWritesProtectedPath(noiseEntries, customList),
    ).toEqual([]);

    // `secrets/**` is in the custom list — should fire.
    const hitEntries = [
      entry(phase("P1", [task("P1-T1", { writes: ["secrets/api-keys.env"] })])),
    ];
    const issues = detectTaskWritesProtectedPath(hitEntries, customList);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.details?.protected_pattern).toBe("secrets/**");
  });

  it("v1.6 P15-T3: an empty injected list = explicit no-protection (no warnings)", () => {
    // The loader returns `paths: []` when the rule file is present but
    // contains no valid entries. The detector must treat that as
    // "user opted out", NOT "fall back to defaults".
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["design/roadmap.yaml"] })])),
    ];
    expect(detectTaskWritesProtectedPath(entries, [])).toEqual([]);
  });
});

describe("detectTaskWritesOverBroad", () => {
  it("no issue for a task-scoped writes glob with a concrete root", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["src/core/audit/**"] })])),
    ];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });

  it("no issue for a src-scoped deep glob (src/**/*.ts)", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["src/**/*.ts"] })])),
    ];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });

  it("no issue for a single-file declared write", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["docs/cli-contract.md"] })])),
    ];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });

  it("no issue for a root-level glob without ** (e.g. *.md)", () => {
    // `*.md` is narrow — it only matches root-level files. Not flagged.
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["*.md"] })])),
    ];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });

  it("warning when writes is just **", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["**"] })])),
    ];
    const issues = detectTaskWritesOverBroad(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_OVER_BROAD");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.details?.value).toBe("**");
  });

  it("warning when writes is **/*", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["**/*"] })])),
    ];
    const issues = detectTaskWritesOverBroad(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_OVER_BROAD");
  });

  it("warning when writes is **/*.ts (matches every .ts in the repo)", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["**/*.ts"] })])),
    ];
    const issues = detectTaskWritesOverBroad(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_OVER_BROAD");
  });

  it("warning when writes is **/foo.ts (matches foo.ts anywhere)", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["**/foo.ts"] })])),
    ];
    const issues = detectTaskWritesOverBroad(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_WRITES_OVER_BROAD");
  });

  it("flags each over-broad glob independently when several are declared", () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            writes: ["src/core/audit/**", "**", "**/*.json"],
          }),
        ]),
      ),
    ];
    const issues = detectTaskWritesOverBroad(entries);
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.details?.value)).toEqual(["**", "**/*.json"]);
  });

  it("does not double-report on already-broken patterns (unsafe path)", () => {
    // `/abs/**` is unsafe (absolute path); the unsafe-path detector
    // will fire. The over-broad detector must stay silent here so
    // a single broken pattern produces a single, actionable diagnostic.
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["/abs/**"] })])),
    ];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });

  it("does not double-report on already-broken patterns (invalid glob syntax)", () => {
    // Brace expansion is out of the P10 supported subset; the
    // glob-invalid detector owns this one.
    const entries = [
      entry(phase("P1", [task("P1-T1", { writes: ["**/{a,b}/*.ts"] })])),
    ];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });

  it("no issue when task has no writes at all", () => {
    const entries = [entry(phase("P1", [task("P1-T1")]))];
    expect(detectTaskWritesOverBroad(entries)).toEqual([]);
  });
});

describe("detectTaskAcceptanceRefUnsafePath", () => {
  it("no issue for safe acceptance_refs paths", () => {
    const entries = [
      entry(
        phase("P1", [task("P1-T1", { acceptance_refs: ["docs/cli-contract.md"] })]),
      ),
    ];
    expect(detectTaskAcceptanceRefUnsafePath(entries)).toEqual([]);
  });

  it("error for absolute acceptance_refs path", () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { acceptance_refs: ["/abs/path.md"] })])),
    ];
    const issues = detectTaskAcceptanceRefUnsafePath(entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_ACCEPTANCE_REF_UNSAFE_PATH");
    expect(issues[0]?.severity).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Filesystem-backed detectors (decision_refs / acceptance_refs not-found,
// reads no-match). Use a temp project tree so we can control which paths
// exist on disk.
// ---------------------------------------------------------------------------

let cwd: string;

async function makeFile(p: string, content = ""): Promise<void> {
  const abs = join(cwd, p);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-checks-p10-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("detectTaskDecisionRefNotFound (fs-backed)", () => {
  it("no issue when every decision_refs path exists on disk", async () => {
    await makeFile("design/decisions/stability-taxonomy.md", "stub");
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/stability-taxonomy.md"],
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues).toEqual([]);
  });

  it("error when decision_refs path does not exist", async () => {
    const entries = [
      entry(
        phase("P1", [task("P1-T1", { decision_refs: ["design/decisions/missing.md"] })]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DECISION_REF_NOT_FOUND");
    expect(issues[0]?.severity).toBe("error");
  });

  it("skips entries already flagged as unsafe (no double-reporting)", async () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { decision_refs: ["../escape.md"] })])),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues).toEqual([]);
  });

  it("soft (warning, affects_exit:false) when a DONE task's decision_refs is gone", async () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/retired.md"],
            status: "done",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_DECISION_REF_NOT_FOUND");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.affects_exit).toBe(false);
    expect(issues[0]?.details?.historical).toBe(true);
  });

  it("still ERROR when the PHASE is done but the task itself is live (phase status must not loosen a live task's gate)", async () => {
    const entries = [
      entry(
        phase(
          "P1",
          [task("P1-T1", { decision_refs: ["design/decisions/retired.md"] })],
          { status: "done" },
        ),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.affects_exit).toBeUndefined();
  });

  it("still ERROR for a CANCELLED task (cancelled is deliberately NOT terminal in PR-A — pending an explicit RFC decision)", async () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/retired.md"],
            status: "cancelled",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues[0]?.severity).toBe("error");
  });

  it("still ERROR for a live (in_progress) task with a missing ref", async () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/retired.md"],
            status: "in_progress",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.affects_exit).toBeUndefined();
  });

  it("SILENT (no issue) when a DONE task's missing ref is recorded in PRUNED.md", async () => {
    await makeFile(
      "design/decisions/PRUNED.md",
      `| Decision | Pruned |\n| --- | --- |\n| \`design/decisions/retired.md\` | 2026-06-08 |\n`,
    );
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/retired.md"],
            status: "done",
          }),
        ]),
      ),
    ];
    expect(await detectTaskDecisionRefNotFound(cwd, entries)).toEqual([]);
  });

  it("still WARNING for a DONE task's missing ref NOT in the ledger (accidental delete is not silenced)", async () => {
    await makeFile(
      "design/decisions/PRUNED.md",
      `| Decision | Pruned |\n| --- | --- |\n| \`design/decisions/something-else.md\` | 2026-06-08 |\n`,
    );
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/retired.md"],
            status: "done",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues[0]?.severity).toBe("warning");
  });

  it("still ERROR for a LIVE task even if the missing ref is in the ledger (ledger never silences a live gate)", async () => {
    await makeFile(
      "design/decisions/PRUNED.md",
      `| Decision | Pruned |\n| --- | --- |\n| \`design/decisions/retired.md\` | 2026-06-08 |\n`,
    );
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["design/decisions/retired.md"],
            status: "planned",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues[0]?.severity).toBe("error");
  });

  it("still WARNING when a non-decision path (docs/) is listed in the ledger — the ledger only tombstones design/decisions/**.md", async () => {
    await makeFile(
      "design/decisions/PRUNED.md",
      `| Decision | Pruned |\n| --- | --- |\n| \`docs/cli-contract.md\` | 2026-06-08 |\n`,
    );
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            decision_refs: ["docs/cli-contract.md"],
            status: "done",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskDecisionRefNotFound(cwd, entries);
    expect(issues[0]?.severity).toBe("warning"); // NOT silenced
  });
});

describe("detectTaskReadsNoMatch (fs-backed)", () => {
  it("no issue when the glob matches at least one file", async () => {
    await makeFile("src/commands/foo.ts", "stub");
    const entries = [
      entry(phase("P1", [task("P1-T1", { reads: ["src/commands/*.ts"] })])),
    ];
    const issues = await detectTaskReadsNoMatch(cwd, entries);
    expect(issues).toEqual([]);
  });

  it("warning when the glob matches nothing", async () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { reads: ["src/commands/*.ts"] })])),
    ];
    const issues = await detectTaskReadsNoMatch(cwd, entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_READS_NO_MATCH");
    expect(issues[0]?.severity).toBe("warning");
  });
});

describe("detectTaskAcceptanceRefNotFound (fs-backed)", () => {
  it("no issue when every acceptance_refs path exists", async () => {
    await makeFile("docs/cli-contract.md", "stub");
    const entries = [
      entry(
        phase("P1", [task("P1-T1", { acceptance_refs: ["docs/cli-contract.md"] })]),
      ),
    ];
    const issues = await detectTaskAcceptanceRefNotFound(cwd, entries);
    expect(issues).toEqual([]);
  });

  it("error when acceptance_refs path does not exist", async () => {
    const entries = [
      entry(phase("P1", [task("P1-T1", { acceptance_refs: ["docs/missing.md"] })])),
    ];
    const issues = await detectTaskAcceptanceRefNotFound(cwd, entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("TASK_ACCEPTANCE_REF_NOT_FOUND");
    expect(issues[0]?.severity).toBe("error");
  });

  it("soft (warning, affects_exit:false) when a DONE task's acceptance_refs is gone", async () => {
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            acceptance_refs: ["docs/retired.md"],
            status: "done",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskAcceptanceRefNotFound(cwd, entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.affects_exit).toBe(false);
    expect(issues[0]?.details?.historical).toBe(true);
  });

  it("PRUNED.md never silences an acceptance_ref (the ledger is a decision tombstone, not a retired-ref table)", async () => {
    await makeFile(
      "design/decisions/PRUNED.md",
      `| Decision | Pruned |\n| --- | --- |\n| \`design/decisions/retired.md\` | 2026-06-08 |\n`,
    );
    const entries = [
      entry(
        phase("P1", [
          task("P1-T1", {
            // even an acceptance_ref pointing at the ledgered decision path
            acceptance_refs: ["design/decisions/retired.md"],
            status: "done",
          }),
        ]),
      ),
    ];
    const issues = await detectTaskAcceptanceRefNotFound(cwd, entries);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning"); // advisory, but NOT silent
  });
});

describe("detectProgressEventConflicts (B6)", () => {
  const ev = (
    task_id: string,
    status: ProgressEvent["status"],
    at: string,
    extra: Partial<ProgressEvent> = {},
  ): ProgressEvent =>
    ({ task_id, status, at, actor: "agent", ...extra }) as ProgressEvent;

  it("no conflict on a valid lifecycle (started → blocked → resumed → done)", () => {
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "started", "2026-05-18T10:00:00.000Z"),
      ev("P1-T1", "blocked", "2026-05-18T11:00:00.000Z", { reason: "x" }),
      ev("P1-T1", "resumed", "2026-05-18T12:00:00.000Z"),
      ev("P1-T1", "done", "2026-05-18T13:00:00.000Z", { source: "loop" }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("no conflict on the planned → done legacy shortcut", () => {
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "done", "2026-05-18T10:00:00.000Z", { source: "loop" }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("flags a second started while already started", () => {
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "started", "2026-05-18T10:00:00.000Z"),
      ev("P1-T1", "started", "2026-05-18T10:00:01.000Z"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PROGRESS_EVENT_CONFLICT");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.task_id).toBe("P1-T1");
  });

  it("names the conflicting side(s) with attribution in details.events[] (D3)", () => {
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "done", "2026-05-18T10:00:00.000Z", { source: "loop", author: "Ada" }),
      ev("P1-T1", "done", "2026-05-18T11:00:00.000Z", { source: "loop", author: "Bo" }),
    ]);
    expect(issues).toHaveLength(1);
    const events = (issues[0]?.details as { events: unknown[] }).events as {
      event_id: string;
      status: string;
      at: string;
      author?: string;
    }[];
    // Both conflicting sides named here, chronological (the establishing event
    // then the offender); the first-event-invalid case below names just one.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.status)).toEqual(["done", "done"]);
    expect(events.map((e) => e.author)).toEqual(["Ada", "Bo"]);
    expect(events.map((e) => e.at)).toEqual([
      "2026-05-18T10:00:00.000Z",
      "2026-05-18T11:00:00.000Z",
    ]);
    // event_id is the 64-hex content id (the filename's id suffix), the two differ.
    for (const e of events) expect(e.event_id).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0]?.event_id).not.toBe(events[1]?.event_id);
    // The human message names the authors too (the same facts, rendered).
    expect(issues[0]?.message).toContain("by Ada");
    expect(issues[0]?.message).toContain("by Bo");
    // The message must NOT assert a per-event file path: the conflict can come
    // from a legacy progress.yaml with no `.code-pact/state/events/` file. It
    // points at details.events[] instead.
    expect(issues[0]?.message).not.toContain(".code-pact/state/events/");
    expect(issues[0]?.message).toContain("details.events[]");
  });

  it("omits author per-event for legacy/anonymous events (D3)", () => {
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "started", "2026-05-18T10:00:00.000Z"), // no author
      ev("P1-T1", "started", "2026-05-18T10:00:01.000Z", { author: "Bo" }),
    ]);
    const events = (issues[0]?.details as { events: { author?: string }[] }).events;
    expect(events[0]).not.toHaveProperty("author");
    expect(events[1]?.author).toBe("Bo");
  });

  it("names the single side when the very first event is invalid (no prior event)", () => {
    // resumed from planned: no establishing event exists, so only one side.
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "resumed", "2026-05-18T10:00:00.000Z", { author: "Ada" }),
    ]);
    expect(issues).toHaveLength(1);
    const events = (issues[0]?.details as { events: unknown[] }).events;
    expect(events).toHaveLength(1);
  });

  it("flags done after done, and an event after a terminal done", () => {
    expect(
      detectProgressEventConflicts([
        ev("P1-T1", "done", "2026-05-18T10:00:00.000Z", { source: "loop" }),
        ev("P1-T1", "done", "2026-05-18T11:00:00.000Z", { source: "loop" }),
      ]),
    ).toHaveLength(1);
    expect(
      detectProgressEventConflicts([
        ev("P1-T1", "started", "2026-05-18T10:00:00.000Z"),
        ev("P1-T1", "done", "2026-05-18T11:00:00.000Z", { source: "loop" }),
        ev("P1-T1", "blocked", "2026-05-18T12:00:00.000Z", { reason: "x" }),
      ]),
    ).toHaveLength(1);
  });

  it("reports at most one conflict per task and keeps tasks independent", () => {
    const issues = detectProgressEventConflicts([
      ev("P1-T1", "started", "2026-05-18T10:00:00.000Z"),
      ev("P1-T1", "started", "2026-05-18T10:00:01.000Z"),
      ev("P1-T1", "started", "2026-05-18T10:00:02.000Z"),
      ev("P1-T2", "started", "2026-05-18T10:00:00.000Z"),
      ev("P1-T2", "done", "2026-05-18T11:00:00.000Z", { source: "loop" }),
    ]);
    expect(issues).toHaveLength(1); // only P1-T1, once
    expect(issues[0]?.task_id).toBe("P1-T1");
  });
});
