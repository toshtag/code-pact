import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evaluatePrune } from "../../../../src/core/decisions/prune.ts";
import type { PhaseEntry } from "../../../../src/core/plan/state.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-prune-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeDecision(name: string, content: string): Promise<void> {
  await writeFile(join(cwd, "design", "decisions", name), content, "utf8");
}

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

function entry(id: string, tasks: Task[], phaseOverrides: Partial<Phase> = {}): PhaseEntry {
  const phase: Phase = {
    id,
    name: id,
    weight: 10,
    confidence: "medium",
    risk: "low",
    status: "planned",
    objective: "Objective long enough",
    definition_of_done: ["does the thing"],
    verification: { commands: ["pnpm test"] },
    tasks,
    ...phaseOverrides,
  };
  return {
    ref: { id, path: `design/phases/${id}.yaml`, weight: 10 },
    absPath: `/tmp/${id}.yaml`,
    phase,
  };
}

const ACCEPTED = "# RFC\n\n**Status:** accepted\n\n## Decision\n\nbody";

describe("evaluatePrune — target validation", () => {
  it("rejects a non-decision path (docs/) as target_invalid", async () => {
    const res = await evaluatePrune(cwd, "docs/cli-contract.md", []);
    expect(res.decision).toBeNull();
    expect(res.eligible).toBe(false);
    expect(res.blocks[0]?.gate).toBe("target_invalid");
  });

  it("rejects README.md / PRUNED.md as target_invalid", async () => {
    expect((await evaluatePrune(cwd, "design/decisions/README.md", [])).blocks[0]?.gate).toBe(
      "target_invalid",
    );
    expect((await evaluatePrune(cwd, "design/decisions/PRUNED.md", [])).blocks[0]?.gate).toBe(
      "target_invalid",
    );
  });

  it("blocks target_missing when the decision file is absent", async () => {
    const res = await evaluatePrune(cwd, "design/decisions/gone-rfc.md", []);
    expect(res.decision).toBe("design/decisions/gone-rfc.md");
    expect(res.eligible).toBe(false);
    expect(res.blocks.some((b) => b.gate === "target_missing")).toBe(true);
  });
});

describe("evaluatePrune — eligible", () => {
  it("is eligible when referenced only by a DONE task, no commitments, no live dependants", async () => {
    await writeDecision("foo-rfc.md", ACCEPTED);
    const phases = [
      entry("P1", [task("P1-T1", { status: "done", decision_refs: ["design/decisions/foo-rfc.md"] })]),
    ];
    const res = await evaluatePrune(cwd, "design/decisions/foo-rfc.md", phases);
    expect(res.eligible).toBe(true);
    expect(res.blocks).toEqual([]);
    expect(res.referencing_tasks).toEqual([
      { task_id: "P1-T1", phase_id: "P1", status: "done", via: "decision_refs" },
    ]);
  });
});

describe("evaluatePrune — gate 1: referencing task not done", () => {
  it("blocks when a NOT-done task references it via decision_refs", async () => {
    await writeDecision("foo-rfc.md", ACCEPTED);
    const phases = [
      entry("P1", [task("P1-T1", { status: "in_progress", decision_refs: ["design/decisions/foo-rfc.md"] })]),
    ];
    const res = await evaluatePrune(cwd, "design/decisions/foo-rfc.md", phases);
    expect(res.eligible).toBe(false);
    const b = res.blocks.find((x) => x.gate === "referencing_task_not_done");
    expect(b).toMatchObject({ task_id: "P1-T1", via: "decision_refs", status: "in_progress" });
  });

  it("blocks when a NOT-done requires_decision task resolves to it via the filename scan", async () => {
    await writeDecision("P1-T1.md", ACCEPTED); // filename matches the task id
    const phases = [
      entry("P1", [task("P1-T1", { status: "planned", requires_decision: true })]),
    ];
    const res = await evaluatePrune(cwd, "design/decisions/P1-T1.md", phases);
    expect(res.eligible).toBe(false);
    expect(res.blocks.find((b) => b.gate === "referencing_task_not_done")).toMatchObject({
      via: "decision_gate",
    });
  });
});

describe("evaluatePrune — gate 2: open commitments", () => {
  it("blocks when the decision has unchecked Implementation commitments", async () => {
    await writeDecision(
      "foo-rfc.md",
      `# RFC\n\n**Status:** accepted\n\n## Implementation commitments\n\n- [x] done thing\n- [ ] still open\n`,
    );
    const phases = [entry("P1", [task("P1-T1", { status: "done", decision_refs: ["design/decisions/foo-rfc.md"] })])];
    const res = await evaluatePrune(cwd, "design/decisions/foo-rfc.md", phases);
    expect(res.eligible).toBe(false);
    expect(res.blocks.find((b) => b.gate === "open_commitments")).toMatchObject({ open_items: 1 });
  });

  it("does NOT block when all commitments are checked", async () => {
    await writeDecision(
      "foo-rfc.md",
      `# RFC\n\n**Status:** accepted\n\n## Implementation commitments\n\n- [x] all done\n`,
    );
    const phases = [entry("P1", [task("P1-T1", { status: "done", decision_refs: ["design/decisions/foo-rfc.md"] })])];
    const res = await evaluatePrune(cwd, "design/decisions/foo-rfc.md", phases);
    expect(res.blocks.some((b) => b.gate === "open_commitments")).toBe(false);
  });
});

describe("evaluatePrune — gate 3: live decision depends", () => {
  it("blocks when a PROPOSED decision links to the target", async () => {
    await writeDecision("foo-rfc.md", ACCEPTED);
    await writeDecision(
      "bar-rfc.md",
      `# RFC\n\n**Status:** proposed\n\n## Decision\n\nBuilds on [foo](foo-rfc.md).`,
    );
    const res = await evaluatePrune(cwd, "design/decisions/foo-rfc.md", []);
    expect(res.eligible).toBe(false);
    expect(res.blocks.find((b) => b.gate === "live_decision_depends")).toMatchObject({
      decision: "design/decisions/bar-rfc.md",
    });
  });

  it("does NOT block when an ACCEPTED decision links to the target (settled, not live)", async () => {
    await writeDecision("foo-rfc.md", ACCEPTED);
    await writeDecision(
      "bar-rfc.md",
      `# RFC\n\n**Status:** accepted\n\n## Decision\n\nRelated: [foo](foo-rfc.md).`,
    );
    const res = await evaluatePrune(cwd, "design/decisions/foo-rfc.md", []);
    expect(res.blocks.some((b) => b.gate === "live_decision_depends")).toBe(false);
    expect(res.eligible).toBe(true);
  });
});
