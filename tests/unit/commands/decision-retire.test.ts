import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  // ---- command-level record / readback / stale-guard safety (the writer's own
  //      refusal + the writer-not-trusted readback + the pre-delete identity guard
  //      must all stop the unlink; the writer-unit test alone can't prove this) ----

  it("writeDecisionRecord ineligible (a STALE existing record refuses overwrite) → STALE record_unverified, .md survives", async () => {
    const { writeDecisionRecord } = await import("../../../src/core/archive/decision-record.ts");
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    // Pre-seed a record for the CURRENT bytes, then change the .md so the record is
    // stale (source_sha256 mismatch) — writeDecisionRecord refuses to overwrite it.
    expect((await writeDecisionRecord(cwd, XREF, { now: NOW })).kind).toBe("written");
    await writeFile(X_MD(), ACCEPTED + "\n<!-- edited, record now stale -->\n", "utf8");
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("record_unverified");
    expect(await exists(X_MD())).toBe(true);
  });

  it("writer succeeds but the written record's identity is corrupted before readback → STALE record_unverified, .md survives", async () => {
    const { decisionRecordPath } = await import("../../../src/core/archive/paths.ts");
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    writeHook.afterWrite = async () => {
      // Corrupt the just-written record's identity so recordMatchingRef rejects it.
      const p = decisionRecordPath(cwd, XREF);
      const obj = JSON.parse(await readFile(p, "utf8"));
      obj.original_path = "design/decisions/other.md"; // diverges from canonical_ref
      await writeFile(p, JSON.stringify(obj), "utf8");
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("record_unverified");
    expect(await exists(X_MD())).toBe(true);
  });

  it("STALE GUARD: target bytes change after the record write → STALE source_changed, .md survives", async () => {
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    writeHook.afterWrite = async () => {
      // Edit the .md AFTER the record was written (and matched the original bytes),
      // so the pre-delete stale guard's sha check refuses.
      await writeFile(X_MD(), ACCEPTED + "\n# edited\n", "utf8");
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("source_changed");
    expect(await exists(X_MD())).toBe(true);
  });

  it("STALE GUARD: a same-content inode swap after the record write → STALE identity_changed, .md survives", async () => {
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    const original = await readFile(X_MD(), "utf8");
    writeHook.afterWrite = async () => {
      // Replace the .md with a byte-identical file at a DIFFERENT inode (rename a
      // separate file over it — deterministic across filesystems, unlike rm+rewrite).
      const swap = join(cwd, "design", "decisions", "x-rfc.swap.md");
      await writeFile(swap, original, "utf8");
      await rename(swap, X_MD());
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("identity_changed");
    expect(await exists(X_MD())).toBe(true);
  });

  // ---- post-write EXTERNAL-dependency TOCTOU (not just task references) ----

  it("a NEW live_decision_depends appears post-write (a proposed decision links to the target) → STALE gate_would_orphan, .md survives", async () => {
    await scaffold(ACCEPTED, TASK_NONE); // no referencing task
    writeHook.afterWrite = async () => {
      // A proposed decision that LINKS to the target appears in the window.
      await writeFile(
        join(cwd, "design", "decisions", "dep-rfc.md"),
        "# Dep\n\n**Status:** proposed\n\n## Decision\n\nBuilds on [X](x-rfc.md).\n",
        "utf8",
      );
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("gate_would_orphan");
    expect(await exists(X_MD())).toBe(true);
  });

  it("plan artifacts become unreadable post-write (roadmap → a directory) → STALE path_inaccessible, .md survives", async () => {
    await scaffold(ACCEPTED, TASK_NONE);
    writeHook.afterWrite = async () => {
      // Make the roadmap unreadable so the post-write recheck's plan-artifacts gate fires.
      await rm(join(cwd, "design", "roadmap.yaml"));
      await mkdir(join(cwd, "design", "roadmap.yaml"), { recursive: true });
    };
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    if (res.kind === "stale") expect(res.reason).toBe("path_inaccessible");
    expect(await exists(X_MD())).toBe(true);
  });

  it("post-write dependant scan ignores a directory named *.md instead of crashing", async () => {
    await scaffold(ACCEPTED, TASK_NONE);
    writeHook.afterWrite = async () => {
      // Only regular files are decision bodies; a directory named like a decision
      // is skipped rather than read as markdown or surfaced as raw EISDIR.
      await mkdir(join(cwd, "design", "decisions", "bogus.md"), { recursive: true });
    };
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

describe("runDecisionRetire — lstat-first presence (PR-B1 regression class)", () => {
  it("dangling ANCESTOR symlink (design/decisions -> /nonexistent) → STALE, NOT already_retired/NOT_RETIRED, no unlink", async () => {
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    // Write the record so a (wrong) live-absent branch could otherwise say already_retired.
    const { writeDecisionRecord } = await import("../../../src/core/archive/decision-record.ts");
    expect((await writeDecisionRecord(cwd, XREF, { now: NOW })).kind).toBe("written");
    const outside = await mkdtemp(join(tmpdir(), "decision-retire-outside-"));
    try {
      await rm(join(cwd, "design", "decisions"), { recursive: true, force: true });
      await symlink(join(outside, "no-such-dir"), join(cwd, "design", "decisions")); // dangling
      const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
      expect(res.kind).toBe("stale"); // never already_retired / not_retired
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("final-component symlink → STALE, never deletes through the symlink", async () => {
    await scaffold(ACCEPTED, TASK_DECISION_REFS);
    const real = join(cwd, "design", "decisions", "real.md");
    await writeFile(real, ACCEPTED, "utf8");
    await rm(X_MD());
    await symlink(real, X_MD());
    const res = await runDecisionRetire({ cwd, path: XREF, write: true, now: NOW });
    expect(res.kind).toBe("stale");
    expect(await exists(real)).toBe(true); // target untouched
  });
});
