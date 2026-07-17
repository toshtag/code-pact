import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateDevelopmentEfficiency,
  isDesignOnlyTask,
  loadDoneEvents,
  loadDevelopmentEfficiencyCheckpoint,
  // @ts-expect-error Node-executed .mjs script imported directly for unit testing.
} from "../../../scripts/check-development-efficiency.mjs";

const baseline = {
  id: "baseline",
  task_id: "P72-T4",
  at: "2026-07-16T00:00:00.000Z",
  file: "baseline",
};
const designTask = { writes: ["design/phases/P1.yaml", "docs/example.md"] };
const runtimeTask = {
  writes: ["src/core/example.ts", "tests/unit/example.test.ts"],
};
const rootDocTask = { writes: ["README.md"] };
const rootDocAndDocsTask = { writes: ["README.md", "docs/example.md"] };
const rootDocAndSrcTask = { writes: ["README.md", "src/core/example.ts"] };
const licenseTask = { writes: ["LICENSE"] };
const noticeTask = { writes: ["NOTICE"] };
const anyRootMdTask = { writes: ["FAQ.md"] };
const packageJsonTask = { writes: ["package.json"] };

function events(taskIds: string[]) {
  return [
    baseline,
    ...taskIds.map((task_id, index) => ({
      id: `${task_id}-event`,
      task_id,
      at: `2026-07-16T00:00:0${index + 1}.000Z`,
      file: `${index}.yaml`,
    })),
  ];
}

function tasks() {
  return new Map<string, unknown>([
    ["D1", designTask],
    ["D2", designTask],
    ["D3", designTask],
    ["R1", runtimeTask],
    ["ROOT", rootDocTask],
    ["ROOT_DOCS", rootDocAndDocsTask],
    ["ROOT_SRC", rootDocAndSrcTask],
    ["LICENSE", licenseTask],
    ["NOTICE", noticeTask],
    ["ANY_MD", anyRootMdTask],
    ["PKG", packageJsonTask],
  ]);
}

const baseCheckpoint = {
  schema_version: 1,
  baseline: {
    task_id: "P72-T4",
    event_id: "baseline",
    at: "2026-07-16T00:00:00.000Z",
  },
  checkpoint: {
    task_id: "P55-T1",
    event_id: "p55-t1-event",
    at: "2026-07-16T00:00:05.000Z",
  },
  state: {
    completed_design_only_tasks: 2,
    completed_runtime_tasks: 8,
    consecutive_design_only_tasks: 1,
    max_consecutive_design_only_tasks: 1,
  },
};

type DoneEvent = { id: string; task_id: string; at: string; file: string };

function checkpointEvents(): DoneEvent[] {
  return [
    {
      id: baseCheckpoint.baseline.event_id,
      task_id: baseCheckpoint.baseline.task_id,
      at: baseCheckpoint.baseline.at,
      file: "baseline.yaml",
    },
    {
      id: "e1",
      task_id: "P63-T2",
      at: "2026-07-16T00:00:01.000Z",
      file: "1.yaml",
    },
    {
      id: "e2",
      task_id: "P63-T3",
      at: "2026-07-16T00:00:02.000Z",
      file: "2.yaml",
    },
    {
      id: "e3",
      task_id: "P66-T1",
      at: "2026-07-16T00:00:03.000Z",
      file: "3.yaml",
    },
    {
      id: "e4",
      task_id: "P66-T2",
      at: "2026-07-16T00:00:04.000Z",
      file: "4.yaml",
    },
    {
      id: "p55-t1-event",
      task_id: "P55-T1",
      at: "2026-07-16T00:00:05.000Z",
      file: "5.yaml",
    },
  ];
}

function makeBundle(
  events: {
    id: string;
    task_id: string;
    at: string;
    file: string;
    status?: string;
  }[],
) {
  const memberEvents = events.map(e => ({
    id: e.id,
    file: e.file,
    event: {
      task_id: e.task_id,
      status: e.status || "done",
      at: e.at,
      actor: "agent",
      agent: "test",
    },
  }));
  const pack = JSON.stringify({
    schema_version: 1,
    phase_id: "P99",
    snapshot_sha256: "deadbeef",
    event_ids_sha256: "deadbeef",
    events: memberEvents,
  });
  return JSON.stringify({
    schema_version: 1,
    kind: "event_pack",
    member_ids_sha256: "deadbeef",
    members: [
      {
        id: "P99",
        sha256: "deadbeef",
        bytes: pack,
      },
    ],
  });
}

function makeTempRepo() {
  const repo = mkdtempSync(join(tmpdir(), "dev-eff-"));
  mkdirSync(join(repo, ".code-pact", "state", "archive", "bundles"), {
    recursive: true,
  });
  mkdirSync(join(repo, ".code-pact", "state", "events"), { recursive: true });
  return repo;
}

function cleanup(repo: string) {
  rmSync(repo, { recursive: true, force: true });
}

describe("check-development-efficiency", () => {
  it("classifies design-only and implementation tasks", () => {
    expect(isDesignOnlyTask(designTask)).toBe(true);
    expect(isDesignOnlyTask(runtimeTask)).toBe(false);
    expect(isDesignOnlyTask({ writes: ["scripts/check.mjs"] })).toBe(false);
    expect(isDesignOnlyTask({ writes: [] })).toBe(true);
  });

  it("classifies root-level documentation as design-only", () => {
    expect(isDesignOnlyTask(rootDocTask)).toBe(true);
    expect(isDesignOnlyTask({ writes: ["CONTRIBUTING.md"] })).toBe(true);
    expect(isDesignOnlyTask({ writes: ["SECURITY.md"] })).toBe(true);
    expect(isDesignOnlyTask({ writes: ["CHANGELOG.md"] })).toBe(true);
    expect(isDesignOnlyTask(licenseTask)).toBe(true);
    expect(isDesignOnlyTask(noticeTask)).toBe(true);
    expect(isDesignOnlyTask(anyRootMdTask)).toBe(true);
  });

  it("classifies root docs combined with docs as design-only", () => {
    expect(isDesignOnlyTask(rootDocAndDocsTask)).toBe(true);
  });

  it("classifies root docs combined with implementation as runtime", () => {
    expect(isDesignOnlyTask(rootDocAndSrcTask)).toBe(false);
  });

  it("classifies package.json as runtime", () => {
    expect(isDesignOnlyTask(packageJsonTask)).toBe(false);
  });

  it("allows one completed design-only task", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1"]),
        tasks: tasks(),
      }),
    ).toMatchObject({
      consecutive_design_only_tasks: 1,
      max_consecutive_design_only_tasks: 1,
      status: "pass",
    });
  });

  it("fails on two current consecutive design-only tasks", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1", "D2"]),
        tasks: tasks(),
      }),
    ).toMatchObject({
      consecutive_design_only_tasks: 2,
      max_consecutive_design_only_tasks: 2,
      status: "fail",
      code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
    });
  });

  it("recovers after a runtime task while preserving historical maximum", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1", "D2", "R1"]),
        tasks: tasks(),
      }),
    ).toMatchObject({
      consecutive_design_only_tasks: 0,
      max_consecutive_design_only_tasks: 2,
      status: "pass",
    });
  });

  it("fails prospectively when the next task would create a design loop", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1"]),
        tasks: tasks(),
        nextTask: "D2",
      }),
    ).toMatchObject({
      next_task: "D2",
      next_task_design_only: true,
      prospective_consecutive_design_only_tasks: 2,
      status: "fail",
      code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
    });
  });

  it("passes prospectively for a runtime next task after design-only work", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1"]),
        tasks: tasks(),
        nextTask: "R1",
      }),
    ).toMatchObject({
      next_task_design_only: false,
      prospective_consecutive_design_only_tasks: 0,
      status: "pass",
    });
  });

  it("passes prospectively for a runtime next task even from a design loop", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1", "D2"]),
        tasks: tasks(),
        nextTask: "R1",
      }),
    ).toMatchObject({
      next_task_design_only: false,
      prospective_consecutive_design_only_tasks: 0,
      status: "pass",
    });
  });

  it("fails prospectively when the next task deepens a design loop", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["D1", "D2"]),
        tasks: tasks(),
        nextTask: "D3",
      }),
    ).toMatchObject({
      next_task: "D3",
      next_task_design_only: true,
      prospective_consecutive_design_only_tasks: 3,
      status: "fail",
      code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
    });
  });

  it("passes prospectively for a design next task after runtime work", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["R1"]),
        tasks: tasks(),
        nextTask: "D1",
      }),
    ).toMatchObject({
      consecutive_design_only_tasks: 0,
      prospective_consecutive_design_only_tasks: 1,
      status: "pass",
    });
  });

  it("treats unknown next task as configuration failure", () => {
    expect(
      evaluateDevelopmentEfficiency({
        doneEvents: events(["R1"]),
        tasks: tasks(),
        nextTask: "NOPE",
      }),
    ).toMatchObject({
      status: "fail",
      code: "CONFIG_ERROR",
      next_task: "NOPE",
    });
  });

  describe("checkpoint", () => {
    it("maintains the checkpoint current streak when no events follow it", () => {
      const result = evaluateDevelopmentEfficiency({
        doneEvents: checkpointEvents(),
        tasks: tasks(),
        checkpoint: baseCheckpoint,
      });
      expect(result).toMatchObject({
        baseline_task: "P72-T4",
        checkpoint_task: "P55-T1",
        completed_design_only_tasks: 2,
        completed_runtime_tasks: 8,
        consecutive_design_only_tasks: 1,
        max_consecutive_design_only_tasks: 1,
        status: "pass",
      });
    });

    it("resets the streak after a runtime task following the checkpoint", () => {
      const events = [
        ...checkpointEvents(),
        {
          id: "r2",
          task_id: "R1",
          at: "2026-07-16T00:00:06.000Z",
          file: "6.yaml",
        },
      ];
      const result = evaluateDevelopmentEfficiency({
        doneEvents: events,
        tasks: tasks(),
        checkpoint: baseCheckpoint,
      });
      expect(result).toMatchObject({
        completed_design_only_tasks: 2,
        completed_runtime_tasks: 9,
        consecutive_design_only_tasks: 0,
        max_consecutive_design_only_tasks: 1,
        status: "pass",
      });
    });

    it("fails after a design-only task following the checkpoint deepens the streak", () => {
      const events = [
        ...checkpointEvents(),
        {
          id: "d2",
          task_id: "D2",
          at: "2026-07-16T00:00:06.000Z",
          file: "6.yaml",
        },
      ];
      const result = evaluateDevelopmentEfficiency({
        doneEvents: events,
        tasks: tasks(),
        checkpoint: baseCheckpoint,
      });
      expect(result).toMatchObject({
        completed_design_only_tasks: 3,
        completed_runtime_tasks: 8,
        consecutive_design_only_tasks: 2,
        max_consecutive_design_only_tasks: 2,
        status: "fail",
        code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
      });
    });

    it("fails prospectively when a design task follows a streak of 1", () => {
      const result = evaluateDevelopmentEfficiency({
        doneEvents: checkpointEvents(),
        tasks: tasks(),
        checkpoint: baseCheckpoint,
        nextTask: "D2",
      });
      expect(result).toMatchObject({
        next_task: "D2",
        next_task_design_only: true,
        prospective_consecutive_design_only_tasks: 2,
        status: "fail",
        code: "DEVELOPMENT_DESIGN_LOOP_EXCEEDED",
      });
    });

    it("passes prospectively when a runtime task follows a streak of 1", () => {
      const result = evaluateDevelopmentEfficiency({
        doneEvents: checkpointEvents(),
        tasks: tasks(),
        checkpoint: baseCheckpoint,
        nextTask: "R1",
      });
      expect(result).toMatchObject({
        next_task: "R1",
        next_task_design_only: false,
        prospective_consecutive_design_only_tasks: 0,
        status: "pass",
      });
    });

    it("fails closed when a post-checkpoint done task has no definition", () => {
      const events = [
        ...checkpointEvents(),
        {
          id: "unknown-event",
          task_id: "UNKNOWN",
          at: "2026-07-16T00:00:06.000Z",
          file: "6.yaml",
        },
      ];
      const result = evaluateDevelopmentEfficiency({
        doneEvents: events,
        tasks: tasks(),
        checkpoint: baseCheckpoint,
      });
      expect(result).toMatchObject({
        status: "fail",
        code: "CONFIG_ERROR",
        message: "completed task definitions are unavailable",
        unclassified_done_tasks: ["UNKNOWN"],
      });
    });
  });

  describe("archive bundle loading", () => {
    it("reads done events from event-pack bundles when no loose events exist", () => {
      const repo = makeTempRepo();
      try {
        writeFileSync(
          join(repo, ".code-pact/state/archive/bundles/event_pack-test.json"),
          makeBundle([
            {
              id: "b1",
              task_id: "P72-T4",
              at: "2026-07-16T06:15:11.411Z",
              file: "b1.yaml",
            },
            {
              id: "b2",
              task_id: "P55-T1",
              at: "2026-07-16T14:37:39.022Z",
              file: "b2.yaml",
            },
          ]),
        );
        const events = loadDoneEvents(repo) as DoneEvent[];
        const ids = events.map(e => e.id);
        expect(ids).toContain("b1");
        expect(ids).toContain("b2");
        expect(events).toHaveLength(2);
      } finally {
        cleanup(repo);
      }
    });

    it("deduplicates the same event present as both loose YAML and bundle", () => {
      const repo = makeTempRepo();
      try {
        const sharedId =
          "96d28965b07f040c4b5d7112611415bdfadd748032bcc0df3fbe2770e5237aa2";
        const loose = `id: ${sharedId}\ntask_id: P55-T1\nstatus: done\nat: 2026-07-16T14:37:39.022Z\n`;
        writeFileSync(
          join(
            repo,
            `.code-pact/state/events/20260716T143739022Z-${sharedId}.yaml`,
          ),
          loose,
        );
        writeFileSync(
          join(repo, ".code-pact/state/archive/bundles/event_pack-test.json"),
          makeBundle([
            {
              id: sharedId,
              task_id: "P55-T1",
              at: "2026-07-16T14:37:39.022Z",
              file: "bundled.yaml",
            },
          ]),
        );
        const events = loadDoneEvents(repo) as DoneEvent[];
        expect(events).toHaveLength(1);
        expect(events[0]?.id).toBe(sharedId.toLowerCase());
      } finally {
        cleanup(repo);
      }
    });
  });

  describe("checkpoint validation", () => {
    it("rejects a missing checkpoint file as a configuration error", () => {
      const repo = makeTempRepo();
      try {
        const result = loadDevelopmentEfficiencyCheckpoint(repo);
        expect(result.valid).toBe(false);
        expect(result.message).toMatch(/checkpoint file not found/);
      } finally {
        cleanup(repo);
      }
    });

    it("rejects an invalid checkpoint schema", () => {
      const repo = makeTempRepo();
      try {
        const checkpointPath = join(
          repo,
          "scripts/development-efficiency-checkpoint.json",
        );
        mkdirSync(join(repo, "scripts"), { recursive: true });
        writeFileSync(checkpointPath, JSON.stringify({ schema_version: 2 }));
        const result = loadDevelopmentEfficiencyCheckpoint(repo);
        expect(result.valid).toBe(false);
        expect(result.message).toMatch(/schema_version must be 1/);
      } finally {
        cleanup(repo);
      }
    });

    it("rejects a checkpoint whose event cannot be found", () => {
      const events = checkpointEvents().filter(e => e.id !== "p55-t1-event");
      const result = evaluateDevelopmentEfficiency({
        doneEvents: events,
        tasks: tasks(),
        checkpoint: baseCheckpoint,
      });
      expect(result).toMatchObject({
        status: "fail",
        code: "CONFIG_ERROR",
        message: expect.stringContaining("checkpoint event not resolved"),
      });
    });

    it("rejects a checkpoint with consecutive > maximum", () => {
      const checkpoint = {
        ...baseCheckpoint,
        state: {
          ...baseCheckpoint.state,
          consecutive_design_only_tasks: 5,
          max_consecutive_design_only_tasks: 1,
        },
      };
      const result = evaluateDevelopmentEfficiency({
        doneEvents: checkpointEvents(),
        tasks: tasks(),
        checkpoint,
      });
      expect(result).toMatchObject({
        status: "fail",
        code: "CONFIG_ERROR",
        message: expect.stringContaining("consecutive exceeds maximum"),
      });
    });
  });
});
