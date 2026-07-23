import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  countLogicalLines,
  INELIGIBLE_REASONS,
  resolveOneShotEligibility,
} from "../../../../src/core/execute-once/eligibility.ts";
import type { Phase } from "../../../../src/core/schemas/phase.ts";
import type { Task } from "../../../../src/core/schemas/task.ts";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";

async function withTempProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-execute-once-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function makePhase(overrides?: Partial<Phase>): Phase {
  return {
    id: "P78",
    name: "One-shot",
    weight: 1,
    confidence: "medium",
    risk: "low",
    status: "in_progress",
    objective: "test objective",
    non_goals: [],
    definition_of_done: ["done"],
    verification: { commands: ["echo ok"] },
    requires_decision: false,
    tasks: [],
    ...overrides,
  } as Phase;
}

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: "P78-T1",
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "medium",
    expected_duration: "short",
    status: "planned",
    description: "test goal",
    reads: ["src/example.ts"],
    writes: ["src/example.ts"],
    ...overrides,
  } as Task;
}

function makeEvent(
  status: ProgressEvent["status"],
  taskId = "P78-T1",
): ProgressEvent {
  return {
    task_id: taskId,
    status,
    at: new Date().toISOString(),
    actor: "agent",
  } as ProgressEvent;
}

describe("resolveOneShotEligibility", () => {
  it("accepts an eligible single-file task", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "line1\nline2\n", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(true);
      if (result.eligible) {
        expect(result.sourcePath).toBe("src/example.ts");
        expect(result.verificationCommand).toBe("echo ok");
      }
    });
  });

  it("rejects multiple read paths", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ reads: ["src/a.ts", "src/b.ts"] }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.MULTIPLE_READ_PATHS,
        );
      }
    });
  });

  it("rejects multiple write paths", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ writes: ["src/a.ts", "src/b.ts"] }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.MULTIPLE_WRITE_PATHS,
        );
      }
    });
  });

  it("rejects read/write path mismatch", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "a.ts"), "x", "utf8");
      await writeFile(join(cwd, "src", "b.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ reads: ["src/a.ts"], writes: ["src/b.ts"] }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.READ_WRITE_PATH_MISMATCH,
        );
      }
    });
  });

  it("rejects glob scope", async () => {
    await withTempProject(async cwd => {
      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({
          reads: ["src/*.ts"],
          writes: ["src/*.ts"],
        }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.GLOB_SCOPE_UNSUPPORTED,
        );
      }
    });
  });

  it("rejects absolute/unsafe source paths", async () => {
    const result = await resolveOneShotEligibility({
      cwd: "/tmp",
      phase: makePhase(),
      task: makeTask({ reads: ["/etc/passwd"], writes: ["/etc/passwd"] }),
      events: [],
    });

    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.reasons).toContain(INELIGIBLE_REASONS.INVALID_SOURCE_PATH);
    }
  });

  it("rejects decision-required tasks", async () => {
    await withTempProject(async cwd => {
      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase({ requires_decision: true }),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(INELIGIBLE_REASONS.DECISION_REQUIRED);
      }
    });
  });

  it("rejects incomplete dependencies", async () => {
    await withTempProject(async cwd => {
      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ depends_on: ["P77-T1"] }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.DEPENDENCY_INCOMPLETE,
        );
      }
    });
  });

  it("accepts completed dependencies", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ depends_on: ["P77-T1"] }),
        events: [makeEvent("done", "P77-T1")],
      });

      expect(result.eligible).toBe(true);
    });
  });

  it("rejects files over the byte limit", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x".repeat(9000), "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(INELIGIBLE_REASONS.SOURCE_TOO_LARGE);
      }
    });
  });

  it("rejects files over the line limit", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      const lines = Array.from({ length: 121 }, (_, i) => `line${i}`).join(
        "\n",
      );
      await writeFile(join(cwd, "src", "example.ts"), lines, "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.LINE_COUNT_EXCEEDS_LIMIT,
        );
      }
    });
  });

  it("rejects symlinks", async () => {
    await withTempProject(async cwd => {
      await writeFile(join(cwd, "target.txt"), "x", "utf8");
      await symlink("target.txt", join(cwd, "link.txt"));

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ reads: ["link.txt"], writes: ["link.txt"] }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(INELIGIBLE_REASONS.SOURCE_IS_SYMLINK);
      }
    });
  });

  it("rejects directories", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ reads: ["src"], writes: ["src"] }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.SOURCE_NOT_REGULAR_FILE,
        );
      }
    });
  });

  it("rejects missing source files", async () => {
    await withTempProject(async cwd => {
      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(INELIGIBLE_REASONS.SOURCE_NOT_FOUND);
      }
    });
  });

  it("rejects already-done tasks", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [makeEvent("done")],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.TASK_STATE_NOT_ALLOWED,
        );
      }
    });
  });

  it("rejects cancelled design status", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask({ status: "cancelled" }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(INELIGIBLE_REASONS.DESIGN_CANCELLED);
      }
    });
  });

  it("rejects empty goal", async () => {
    await withTempProject(async cwd => {
      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase({ objective: "" }),
        task: makeTask({ description: "" }),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(INELIGIBLE_REASONS.GOAL_EMPTY);
      }
    });
  });

  it("rejects multiple verification commands", async () => {
    await withTempProject(async cwd => {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), "x", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase({
          verification: { commands: ["echo ok", "echo ok2"] } as any,
        }),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.MULTIPLE_VERIFICATION_COMMANDS,
        );
      }
    });
  });

  it("rejects content exceeding the line count limit", async () => {
    await withTempProject(async cwd => {
      const lines121 = Array.from({ length: 121 }, (_, i) => `line ${i}`).join(
        "\n",
      );
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), lines121 + "\n", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(false);
      if (!result.eligible) {
        expect(result.reasons).toContain(
          INELIGIBLE_REASONS.LINE_COUNT_EXCEEDS_LIMIT,
        );
      }
    });
  });

  it("accepts content at the line count limit with trailing newline", async () => {
    await withTempProject(async cwd => {
      const lines120 = Array.from({ length: 120 }, (_, i) => `line ${i}`).join(
        "\n",
      );
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src", "example.ts"), lines120 + "\n", "utf8");

      const result = await resolveOneShotEligibility({
        cwd,
        phase: makePhase(),
        task: makeTask(),
        events: [],
      });

      expect(result.eligible).toBe(true);
    });
  });
});

describe("countLogicalLines", () => {
  it("counts empty content as zero", () => {
    expect(countLogicalLines("")).toBe(0);
  });

  it("does not count a trailing newline", () => {
    expect(countLogicalLines("line1\nline2\n")).toBe(2);
  });

  it("counts lines without a trailing newline", () => {
    expect(countLogicalLines("line1\nline2")).toBe(2);
  });

  it("handles CRLF", () => {
    expect(countLogicalLines("line1\r\nline2\r\n")).toBe(2);
  });
});
