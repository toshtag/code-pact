import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gap-3 (Codex): the done-task-inaccessible case uses an fs mock (deterministic,
// not chmod) scoped to the X.md path → access() rejects EACCES.
const fail = { accessError: null as { code: string } | null };
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn((...args: Parameters<typeof actual.access>) => {
      if (fail.accessError && /design[\\/]decisions[\\/]x-rfc\.md/.test(String(args[0]))) {
        return Promise.reject(Object.assign(new Error("x"), fail.accessError));
      }
      return (actual.access as (...a: unknown[]) => unknown)(...(args as unknown[]));
    }),
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectTaskAcceptanceRefNotFound,
  detectTaskDecisionRefNotFound,
} from "../../../../../src/core/plan/checks/path-fields.ts";
import { writeDecisionRecord } from "../../../../../src/core/archive/decision-record.ts";
import { decisionRecordPath, sha256Hex } from "../../../../../src/core/archive/paths.ts";
import type { PhaseEntry } from "../../../../../src/core/plan/state.ts";
import type { Phase } from "../../../../../src/core/schemas/phase.ts";
import type { Task } from "../../../../../src/core/schemas/task.ts";

// Step 5 — record-aware decision_refs / acceptance_refs lint softening.

const NOW = new Date("2026-06-10T00:00:00.000Z");
const XREF = "design/decisions/x-rfc.md";
const ACCEPTED = `# RFC\n\n**Status:** accepted (P9, 2026-06)\n\n## Summary\n\nSettled.\n`;
const BLOCKED = `# RFC\n\n**Status:** proposed\n\n## Summary\n\nPending.\n`;

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-decrec-lint-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state", "archive", "decisions"), { recursive: true });
});
afterEach(async () => {
  fail.accessError = null;
  vi.restoreAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function task(id: string, o: Partial<Task> = {}): Task {
  return {
    id,
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status: "in_progress",
    ...o,
  } as Task;
}
function entry(tasks: Task[]): PhaseEntry {
  const phase = { id: "P1", name: "P1", weight: 1, tasks } as Phase;
  return { ref: { id: "P1", path: "design/phases/P1.yaml", weight: 1 }, absPath: "/x", phase };
}
/** Write the ADR + its decision-state record, then retire (delete the .md). */
async function retireWithRecord(adr: string): Promise<void> {
  await writeFile(join(cwd, XREF), adr, "utf8");
  expect((await writeDecisionRecord(cwd, XREF, { now: NOW })).kind).toBe("written");
  await rm(join(cwd, XREF));
}

function only(issues: { code: string; severity: string; affects_exit?: boolean }[]) {
  expect(issues).toHaveLength(1);
  return issues[0]!;
}

describe("detectTaskDecisionRefNotFound — record-aware (step 5)", () => {
  it("ACTIVE task + retired + ACCEPTED record → advisory (affects_exit:false) — A3-positive green", async () => {
    await retireWithRecord(ACCEPTED);
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF] })])]));
    expect(i.code).toBe("TASK_DECISION_REF_NOT_FOUND");
    expect(i.severity).toBe("warning");
    expect(i.affects_exit).toBe(false);
  });

  it("ACTIVE task + retired + BLOCKED record → ERROR (gate not released)", async () => {
    await retireWithRecord(BLOCKED);
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF] })])]));
    expect(i.severity).toBe("error");
  });

  it("ACTIVE task + retired + NO record → ERROR", async () => {
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF] })])]));
    expect(i.severity).toBe("error");
  });

  it("DONE task + retired + any valid record → silent (continue)", async () => {
    await retireWithRecord(BLOCKED);
    const issues = await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF], status: "done" })])]);
    expect(issues).toEqual([]); // suppressed entirely
  });

  it("DONE task + retired + NO record → advisory (existing baseline, never error)", async () => {
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF], status: "done" })])]));
    expect(i.severity).toBe("warning");
    expect(i.affects_exit).toBe(false);
  });
});

describe("detectTaskAcceptanceRefNotFound — record-aware (step 5)", () => {
  it("NOT-done task + acceptance_refs:[X] retired + BLOCKED record → advisory (any valid record softens)", async () => {
    await retireWithRecord(BLOCKED);
    const i = only(await detectTaskAcceptanceRefNotFound(cwd, [entry([task("P1-T1", { acceptance_refs: [XREF] })])]));
    expect(i.severity).toBe("warning");
    expect(i.affects_exit).toBe(false);
    expect(i.code).toBe("TASK_ACCEPTANCE_REF_NOT_FOUND");
  });

  it("NOT-done task + acceptance_refs:[docs/...] missing → ERROR (non-decision target never softens)", async () => {
    await retireWithRecord(ACCEPTED); // record exists for X, irrelevant to docs/
    const i = only(await detectTaskAcceptanceRefNotFound(cwd, [entry([task("P1-T1", { acceptance_refs: ["docs/cli-contract.md"] })])]));
    expect(i.severity).toBe("error");
  });

  it("NOT-done task + acceptance_refs:[X] retired + NO record → ERROR", async () => {
    const i = only(await detectTaskAcceptanceRefNotFound(cwd, [entry([task("P1-T1", { acceptance_refs: [XREF] })])]));
    expect(i.severity).toBe("error");
  });

  it("DONE task + acceptance_refs:[docs/...] missing → advisory (existing baseline, ANY target, no record)", async () => {
    const i = only(await detectTaskAcceptanceRefNotFound(cwd, [entry([task("P1-T1", { acceptance_refs: ["docs/cli-contract.md"], status: "done" })])]));
    expect(i.severity).toBe("warning");
    expect(i.affects_exit).toBe(false);
  });

  it("NOT-done task + acceptance_refs:[nested decision] missing → ERROR (nested never normalizes, never softened)", async () => {
    await retireWithRecord(BLOCKED);
    const i = only(await detectTaskAcceptanceRefNotFound(cwd, [entry([task("P1-T1", { acceptance_refs: ["design/decisions/p3/nested.md"] })])]));
    expect(i.severity).toBe("error");
  });
});

// Codex coverage-gap closers (review round 1).
describe("step 5 — Codex coverage gaps", () => {
  it("DONE task + INACCESSIBLE decision_ref (EACCES) → advisory, severity UNCHANGED (no record consulted)", async () => {
    await writeFile(join(cwd, XREF), ACCEPTED, "utf8");
    expect((await writeDecisionRecord(cwd, XREF, { now: NOW })).kind).toBe("written");
    // File is present on disk, but access() reports EACCES (inaccessible, not absent).
    fail.accessError = { code: "EACCES" };
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF], status: "done" })])]));
    expect(i.severity).toBe("warning"); // done baseline preserved on inaccessible, NOT error
    expect(i.affects_exit).toBe(false);
  });

  it("ACTIVE task + INACCESSIBLE decision_ref (EACCES) + accepted record → ERROR (never record-softened on inaccessible)", async () => {
    await writeFile(join(cwd, XREF), ACCEPTED, "utf8");
    expect((await writeDecisionRecord(cwd, XREF, { now: NOW })).kind).toBe("written");
    fail.accessError = { code: "EACCES" };
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF] })])]));
    expect(i.severity).toBe("error"); // inaccessible never consults the record
  });

  it("ACTIVE task + retired + record whose original_path is hand-edited to diverge → ERROR (reader re-checks identity)", async () => {
    await retireWithRecord(ACCEPTED);
    const p = decisionRecordPath(cwd, XREF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.original_path = "design/decisions/other.md"; // diverges from canonical_ref
    await writeFile(p, JSON.stringify(obj), "utf8");
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF] })])]));
    expect(i.severity).toBe("error"); // identity mismatch → not released → not softened
  });

  it("ACTIVE task + retired + record whose path_sha256 is hand-edited to diverge → ERROR", async () => {
    await retireWithRecord(ACCEPTED);
    const p = decisionRecordPath(cwd, XREF);
    const obj = JSON.parse(await readFile(p, "utf8"));
    obj.path_sha256 = sha256Hex("design/decisions/something-else.md");
    await writeFile(p, JSON.stringify(obj), "utf8");
    const i = only(await detectTaskDecisionRefNotFound(cwd, [entry([task("P1-T1", { decision_refs: [XREF] })])]));
    expect(i.severity).toBe("error");
  });
});
