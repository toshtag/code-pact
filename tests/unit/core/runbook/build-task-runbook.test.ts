import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskRunbook } from "../../../../src/core/runbook/build-task-runbook.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-build-task-runbook-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const baseTask: Task = {
  id: "P1-T1",
  type: "feature",
  ambiguity: "low",
  risk: "low",
  context_size: "small",
  write_surface: "low",
  verification_strength: "medium",
  expected_duration: "short",
  status: "planned",
};

function ev(task_id: string, status: ProgressEvent["status"]): ProgressEvent {
  return {
    task_id,
    status,
    at: "2026-05-20T00:00:00+00:00",
    actor: "agent",
    ...(status === "blocked" ? { reason: "test blocker" } : {}),
  } as ProgressEvent;
}

describe("buildTaskRunbook", () => {
  describe("step shape invariants", () => {
    it("every step has exactly one of command / manual_action non-null", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [],
      });
      for (const step of result.next_steps) {
        const hasCommand = step.command !== null;
        const hasManual = step.manual_action !== null;
        expect(hasCommand).not.toBe(hasManual);
      }
    });

    it("every step has all six fields present in JSON output", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [],
      });
      for (const step of result.next_steps) {
        expect(step).toHaveProperty("command");
        expect(step).toHaveProperty("manual_action");
        expect(step).toHaveProperty("reason");
        expect(step).toHaveProperty("blocking");
        expect(step).toHaveProperty("safety_note");
        expect(step).toHaveProperty("expected_result");
      }
    });
  });

  describe("lifecycle states", () => {
    it("planned + no events → emits primary loop (task start, task context, implement, task complete)", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [],
      });
      expect(result.next_steps.length).toBe(4);
      expect(result.next_steps[0]!.command).toBe("code-pact task start P1-T1");
      expect(result.next_steps[1]!.command).toBe(
        "code-pact task context P1-T1",
      );
      expect(result.next_steps[2]!.manual_action).toBe("Implement the task");
      expect(result.next_steps[3]!.command).toBe(
        "code-pact task complete P1-T1",
      );
    });

    it("task context step does not embed an agent name", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [],
      });
      const contextStep = result.next_steps.find(s =>
        s.command?.startsWith("code-pact task context"),
      );
      expect(contextStep?.command).not.toContain("--agent");
    });

    it("started → continue implementation + task complete", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [ev("P1-T1", "started")],
      });
      expect(result.state_summary.derived_state).toBe("started");
      expect(result.next_steps.length).toBe(2);
      expect(result.next_steps[0]!.manual_action).toBe(
        "Continue implementation",
      );
      expect(result.next_steps[1]!.command).toBe(
        "code-pact task complete P1-T1",
      );
    });

    it("blocked → manual_action + task resume, both blocking", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [ev("P1-T1", "started"), ev("P1-T1", "blocked")],
      });
      expect(result.state_summary.derived_state).toBe("blocked");
      expect(result.next_steps.length).toBe(2);
      expect(result.next_steps[0]!.manual_action).toContain("Resolve");
      expect(result.next_steps[0]!.blocking).toBe(true);
      expect(result.next_steps[1]!.command).toContain("task resume P1-T1");
      expect(result.next_steps[1]!.blocking).toBe(true);
    });

    it("done + design planned → task finalize --write with safety_note", () => {
      const result = buildTaskRunbook({
        cwd,
        task: baseTask,
        phaseId: "P1",
        events: [ev("P1-T1", "started"), ev("P1-T1", "done")],
      });
      expect(result.state_summary.drift_kind).toBe("done-but-design-not-done");
      expect(result.next_steps.length).toBe(1);
      expect(result.next_steps[0]!.command).toBe(
        "code-pact task finalize P1-T1 --write",
      );
      expect(result.next_steps[0]!.safety_note).toContain("dry-run");
    });

    it("done + design done (consistent) → empty steps, drift null", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, status: "done" },
        phaseId: "P1",
        events: [ev("P1-T1", "started"), ev("P1-T1", "done")],
      });
      expect(result.state_summary.drift_kind).toBeNull();
      expect(result.next_steps).toEqual([]);
    });

    it("done in design + no events (done-historical) → empty steps", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, status: "done" },
        phaseId: "P1",
        events: [],
      });
      expect(result.state_summary.drift_kind).toBe("done-historical");
      expect(result.next_steps).toEqual([]);
    });

    it("cancelled → terminal manual no-op, no lifecycle steps", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, status: "cancelled" },
        phaseId: "P1",
        events: [],
      });
      expect(result.next_steps).toHaveLength(1);
      expect(result.next_steps[0]!.manual_action).toContain("cancelled");
      expect(result.next_steps[0]!.command).toBeNull();
      expect(result.next_steps[0]!.blocking).toBe(true);
    });

    it("done in design + derived blocked → manual_review (blocking)", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, status: "done" },
        phaseId: "P1",
        events: [ev("P1-T1", "started"), ev("P1-T1", "blocked")],
      });
      expect(result.state_summary.drift_kind).toBe("done-blocked-conflict");
      expect(result.next_steps.length).toBe(1);
      expect(result.next_steps[0]!.manual_action).toContain("plan analyze");
      expect(result.next_steps[0]!.blocking).toBe(true);
    });
  });

  describe("depends_on blocking", () => {
    it("emits blocking dependency step at head when a dependency is not done", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, depends_on: ["P1-T0"] },
        phaseId: "P1",
        events: [ev("P1-T0", "started")],
      });
      expect(result.next_steps[0]!.blocking).toBe(true);
      expect(result.next_steps[0]!.manual_action).toContain("P1-T0");
      expect(result.next_steps[0]!.manual_action).toContain("started");
      // Subsequent steps still emitted (runbook never refuses).
      expect(result.next_steps.length).toBeGreaterThan(1);
    });

    it("does NOT emit a dependency step when all dependencies are done", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, depends_on: ["P1-T0"] },
        phaseId: "P1",
        events: [ev("P1-T0", "started"), ev("P1-T0", "done")],
      });
      expect(result.next_steps[0]!.blocking).not.toBe(true);
      expect(result.next_steps[0]!.command).toBe("code-pact task start P1-T1");
    });

    it("groups multiple unsatisfied deps into one head step (mentions first + count)", () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, depends_on: ["P1-T0", "P1-T2"] },
        phaseId: "P1",
        events: [ev("P1-T0", "started")],
      });
      expect(result.next_steps[0]!.blocking).toBe(true);
      expect(result.next_steps[0]!.manual_action).toMatch(/\+ 1 more/);
    });
  });

  describe("state summary", () => {
    it("populates declared_writes from task.writes", async () => {
      const result = buildTaskRunbook({
        cwd,
        task: { ...baseTask, writes: ["src/foo.ts", "src/bar.ts"] },
        phaseId: "P1",
        events: [],
      });
      expect(result.state_summary.declared_writes).toEqual([
        "src/foo.ts",
        "src/bar.ts",
      ]);
    });

    it("populates decision_refs from task.decision_refs", () => {
      const result = buildTaskRunbook({
        cwd,
        task: {
          ...baseTask,
          decision_refs: ["design/decisions/foo-rfc.md"],
        },
        phaseId: "P1",
        events: [],
      });
      expect(result.state_summary.decision_refs).toEqual([
        "design/decisions/foo-rfc.md",
      ]);
    });

    it("checks acceptance_refs existence against the filesystem", async () => {
      await mkdir(join(cwd, "docs"), { recursive: true });
      await writeFile(join(cwd, "docs", "foo.md"), "# foo\n");
      const result = buildTaskRunbook({
        cwd,
        task: {
          ...baseTask,
          acceptance_refs: ["docs/foo.md", "docs/missing.md"],
        },
        phaseId: "P1",
        events: [],
      });
      expect(result.state_summary.acceptance_refs_check).toEqual([
        { path: "docs/foo.md", exists: true },
        { path: "docs/missing.md", exists: false },
      ]);
    });
  });

  it("kind is always 'runbook' regardless of state", () => {
    const r1 = buildTaskRunbook({
      cwd,
      task: baseTask,
      phaseId: "P1",
      events: [],
    });
    const r2 = buildTaskRunbook({
      cwd,
      task: { ...baseTask, status: "done" },
      phaseId: "P1",
      events: [ev("P1-T1", "started"), ev("P1-T1", "done")],
    });
    expect(r1.kind).toBe("runbook");
    expect(r2.kind).toBe("runbook");
  });
});
