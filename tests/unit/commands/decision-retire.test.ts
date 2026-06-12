import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A test seam in the WRITER module: run `afterWrite` between the real
// writeDecisionRecord and the post-write recheck, so a test can mutate plan/task
// artifacts in the write→delete window (the TOCTOU the recheck closes).
const writeHook = { afterWrite: null as null | (() => Promise<void>) };
vi.mock("../../../src/core/archive/decision-record.ts", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/core/archive/decision-record.ts")>();
  return {
    ...actual,
    writeDecisionRecord: vi.fn(async (...args: Parameters<typeof actual.writeDecisionRecord>) => {
      const out = await actual.writeDecisionRecord(...args);
      if (writeHook.afterWrite) await writeHook.afterWrite();
      return out;
    }),
  };
});

import { runDecisionRetire } from "../../../src/commands/decision-retire.ts";
import { evaluateRetire } from "../../../src/core/decisions/retire.ts";
import { evaluatePrune } from "../../../src/core/decisions/prune.ts";
import { collectPlanArtifacts } from "../../../src/core/plan/state.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");
const XREF = "design/decisions/x-rfc.md";
const ACCEPTED = "# RFC: X\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\nSettled.\n";
const BLOCKED = "# RFC: X\n\n**Status:** proposed\n\n## Decision\n\nNot yet settled.\n";

const TF = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;
const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 1\n`;
function phaseYaml(body: string): string {
  return `id: P1
name: P1
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
${body}`;
}
const TASK_DECISION_REFS = `  - id: P1-T1
    type: feature
${TF}
    status: in_progress
    description: Implements the thing
    requires_decision: true
    decision_refs:
      - ${XREF}
`;
const TASK_FILENAME_SCAN = `  - id: P1-T1
    type: feature
${TF}
    status: in_progress
    description: Implements the thing
    requires_decision: true
`;
const TASK_NONE = `  - id: P1-T1
    type: feature
${TF}
    status: in_progress
    description: Implements the thing
`;

let cwd: string;
const X_MD = () => join(cwd, XREF);
const P1 = () => join(cwd, "design", "phases", "P1.yaml");
const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
async function scaffold(adr: string, taskBody: string): Promise<void> {
  cwd = await mkdtemp(join(tmpdir(), "decision-retire-unit-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(P1(), phaseYaml(taskBody), "utf8");
  await writeFile(X_MD(), adr, "utf8");
}

beforeEach(() => {
  writeHook.afterWrite = null;
});
afterEach(async () => {
  writeHook.afterWrite = null;
  vi.clearAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("evaluateRetire — status-sensitive referencing gate (verdict unit)", () => {
  async function verdict(adr: string, taskBody: string) {
    await scaffold(adr, taskBody);
    const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
    return evaluateRetire(cwd, XREF, state?.phases ?? fallbackPhases);
  }
  const gates = (v: Awaited<ReturnType<typeof evaluateRetire>>) => v.blocks.map((b) => b.gate);

  it("accepted + active decision_refs → eligible", async () => {
    expect((await verdict(ACCEPTED, TASK_DECISION_REFS)).eligible).toBe(true);
  });
  it("blocked + active decision_refs → referencing_task_not_done", async () => {
    const v = await verdict(BLOCKED, TASK_DECISION_REFS);
    expect(v.eligible).toBe(false);
    expect(gates(v)).toContain("referencing_task_not_done");
  });
  it("blocked + active acceptance_refs → eligible (any valid record softens)", async () => {
    const body = TASK_DECISION_REFS.replace("decision_refs:", "acceptance_refs:").replace("requires_decision: true", "requires_decision: false");
    expect((await verdict(BLOCKED, body)).eligible).toBe(true);
  });
  it("accepted + active filename-scan gate → referencing_task_not_done (never carriable)", async () => {
    // A filename-scan gate resolves when the DECISION FILENAME contains the task id
    // (matchesTaskId). So the target decision must be named to match `P1-T1`.
    cwd = await mkdtemp(join(tmpdir(), "decision-retire-unit-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(P1(), phaseYaml(TASK_FILENAME_SCAN), "utf8");
    const scanRef = "design/decisions/P1-T1-notes.md";
    await writeFile(join(cwd, scanRef), ACCEPTED, "utf8");
    const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
    const v = await evaluateRetire(cwd, scanRef, state?.phases ?? fallbackPhases);
    expect(v.eligible).toBe(false);
    expect(gates(v)).toContain("referencing_task_not_done");
  });
  it("unreferenced → eligible at any status", async () => {
    expect((await verdict(BLOCKED, TASK_NONE)).eligible).toBe(true);
  });

  it("acceptance_refs to a target that is ALSO a filename-scan gate → BLOCKED (filename-scan outranks; never carriable)", async () => {
    // P1-T1, requires_decision:true, NO decision_refs, acceptance_refs → P1-T1-notes.md
    // (filename contains the task id → also a filename-scan gate). The acceptance_refs
    // must NOT suppress the filename-scan gate (which a record can't carry).
    cwd = await mkdtemp(join(tmpdir(), "decision-retire-unit-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    const scanRef = "design/decisions/P1-T1-notes.md";
    const body = `  - id: P1-T1
    type: feature
${TF}
    status: in_progress
    description: Implements the thing
    requires_decision: true
    acceptance_refs:
      - ${scanRef}
`;
    await writeFile(P1(), phaseYaml(body), "utf8");
    await writeFile(join(cwd, scanRef), ACCEPTED, "utf8");
    const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
    const v = await evaluateRetire(cwd, scanRef, state?.phases ?? fallbackPhases);
    expect(v.eligible).toBe(false);
    expect(v.blocks.map((b) => b.gate)).toContain("referencing_task_not_done");
    expect(v.referencing_tasks.find((t) => t.task_id === "P1-T1")?.via).toBe("filename_scan");
  });
});

describe("evaluateRetire vs evaluatePrune — parity (extraction guard)", () => {
  it("the shared integrity gates agree for an accepted, unreferenced target (prune unchanged)", async () => {
    await scaffold(ACCEPTED, TASK_NONE);
    const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
    const phases = state?.phases ?? fallbackPhases;
    const retire = await evaluateRetire(cwd, XREF, phases);
    const prune = await evaluatePrune(cwd, XREF, phases);
    // Both eligible on an accepted, unreferenced, commitment-free, no-dependant target.
    expect(retire.eligible).toBe(true);
    expect(prune.eligible).toBe(true);
  });
  it("only prune blocks a non-accepted target (target_not_accepted) — retire accepts it", async () => {
    await scaffold(BLOCKED, TASK_NONE);
    const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
    const phases = state?.phases ?? fallbackPhases;
    const prune = await evaluatePrune(cwd, XREF, phases);
    const retire = await evaluateRetire(cwd, XREF, phases);
    expect(prune.blocks.map((b) => b.gate)).toContain("target_not_accepted");
    expect(retire.eligible).toBe(true); // retire has no target_not_accepted gate
  });
});

describe("runDecisionRetire — post-write recheck (TOCTOU) + readback", () => {
  it("a NEW active filename-scan gate appears post-write → STALE gate_would_orphan, .md survives", async () => {
    // Retire a decision named to MATCH a filename-scan of task `P1-T1`
    // (matchesTaskId: the filename contains the task id). Unreferenced at verdict
    // time (the phase task has no gate); the swap adds a `requires_decision` task
    // whose filename-scan resolves this decision.
    cwd = await mkdtemp(join(tmpdir(), "decision-retire-unit-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(P1(), phaseYaml(TASK_NONE), "utf8"); // no gate at verdict time
    const scanRef = "design/decisions/P1-T1-notes.md";
    await writeFile(join(cwd, scanRef), ACCEPTED, "utf8");
    writeHook.afterWrite = async () => {
      await writeFile(P1(), phaseYaml(TASK_FILENAME_SCAN), "utf8"); // P1-T1 requires_decision
    };
    const res = await runDecisionRetire({ cwd, path: scanRef, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("gate_would_orphan");
    expect(await exists(join(cwd, scanRef))).toBe(true);
  });

  it("a NEW non-accepted decision_refs appears post-write → STALE gate_would_orphan, .md survives", async () => {
    // Target is BLOCKED (record may_satisfy:false). Unreferenced at verdict time.
    await scaffold(BLOCKED, TASK_NONE);
    writeHook.afterWrite = async () => {
      await writeFile(P1(), phaseYaml(TASK_DECISION_REFS), "utf8");
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("gate_would_orphan");
    expect(await exists(X_MD())).toBe(true);
  });

  it("a NEW accepted decision_refs appears post-write → record carries it → retired", async () => {
    await scaffold(ACCEPTED, TASK_NONE);
    writeHook.afterWrite = async () => {
      await writeFile(P1(), phaseYaml(TASK_DECISION_REFS), "utf8");
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("retired");
    expect(await exists(X_MD())).toBe(false);
  });

  it("happy path with no post-write drift → retired", async () => {
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("retired");
    expect(await exists(X_MD())).toBe(false);
  });

  it("DRY-RUN: an unreadable existing record path (a directory) → STALE record_unverified, not an internal error", async () => {
    const { decisionRecordPath } = await import("../../../src/core/archive/paths.ts");
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    // Put a DIRECTORY where the record file would be, so planDecisionRecord's read throws.
    const recPath = decisionRecordPath(cwd, XREF);
    await mkdir(recPath, { recursive: true });
    const res = await runDecisionRetire({ cwd, path: XREF, write: false, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("record_unverified");
    expect(await exists(X_MD())).toBe(true); // dry-run wrote nothing
  });

  it("POST-WRITE: a NEW acceptance_refs+filename-scan task appears → STALE gate_would_orphan, .md survives", async () => {
    // Target is named to match filename-scan of P1-T1. Unreferenced at verdict time.
    cwd = await mkdtemp(join(tmpdir(), "decision-retire-unit-"));
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(P1(), phaseYaml(TASK_NONE), "utf8");
    const scanRef = "design/decisions/P1-T1-notes.md";
    await writeFile(join(cwd, scanRef), ACCEPTED, "utf8");
    writeHook.afterWrite = async () => {
      // Swap in a requires_decision task with an acceptance_refs to the same target —
      // the filename-scan gate must still be detected (acceptance_refs doesn't suppress it).
      const body = `  - id: P1-T1
    type: feature
${TF}
    status: in_progress
    description: Implements the thing
    requires_decision: true
    acceptance_refs:
      - ${scanRef}
`;
      await writeFile(P1(), phaseYaml(body), "utf8");
    };
    const res = await runDecisionRetire({ cwd, path: scanRef, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("gate_would_orphan");
    expect(await exists(join(cwd, scanRef))).toBe(true);
  });
});
