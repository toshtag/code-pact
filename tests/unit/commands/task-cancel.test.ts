import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskCancel } from "../../../src/commands/task-cancel.ts";
import { loadPhase } from "../../../src/core/plan/load-phase.ts";
import { loadMergedProgress } from "../../../src/core/progress/io.ts";
import type { OwnedReadPath } from "../../../src/core/project-fs/index.ts";

const phaseMock = vi.hoisted(() => ({
  enabled: false,
  snapshot: "",
  postWrite: "",
  callCount: 0,
}));

vi.mock("../../../src/core/project-fs/index.ts", async importActual => {
  const actual =
    await importActual<
      typeof import("../../../src/core/project-fs/index.ts")
    >();
  return {
    ...actual,
    readOwnedText: async (path: OwnedReadPath): Promise<string> => {
      const p = path as string;
      if (phaseMock.enabled && p.includes("P1-foundation.yaml")) {
        const call = phaseMock.callCount;
        phaseMock.callCount = call + 1;
        if (phaseMock.postWrite && call === 1) {
          return phaseMock.postWrite;
        }
        return phaseMock.snapshot;
      }
      return actual.readOwnedText(path);
    },
  };
});

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
`;

const PROGRESS_EMPTY = "events: []\n";

const TASK_BASE = `    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short`;

function phaseYaml(tasks: string): string {
  return `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: planned
objective: test phase
definition_of_done:
  - tests pass
verification:
  commands:
    - echo ok
tasks:
${tasks}`;
}

function task(id: string, status: string, extra = ""): string {
  return `  - id: ${id}
${TASK_BASE}
    status: ${status}${extra ? "\n" + extra : ""}`;
}

async function setupProject(
  dir: string,
  opts: {
    phaseYaml?: string;
    progressYaml?: string;
  } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? PROGRESS_EMPTY,
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    opts.phaseYaml ?? phaseYaml(task("P1-T1", "planned")),
    "utf8",
  );
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-cancel-"));
  phaseMock.enabled = false;
  phaseMock.snapshot = "";
  phaseMock.postWrite = "";
  phaseMock.callCount = 0;
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  phaseMock.enabled = false;
});

describe("runTaskCancel — happy path", () => {
  it("returns cancel_preview in dry-run mode and does not mutate the phase", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );

    const result = await runTaskCancel({ cwd: dir, taskId: "P1-T1" });
    expect(result.kind).toBe("cancel_preview");
    if (result.kind !== "cancel_preview") throw new Error("type narrow");
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.current_design_status).toBe("planned");
    expect(result.would_change.task_status).toEqual({
      from: "planned",
      to: "cancelled",
    });

    const after = await readFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("flips the design status to cancelled when --write is passed", async () => {
    await setupProject(dir);
    const result = await runTaskCancel({
      cwd: dir,
      taskId: "P1-T1",
      write: true,
    });
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") throw new Error("type narrow");
    expect(result.previous_design_status).toBe("planned");
    expect(result.design_status).toBe("cancelled");

    const phase = await loadPhase(dir, "design/phases/P1-foundation.yaml");
    const task = phase.tasks?.find(t => t.id === "P1-T1");
    expect(task?.status).toBe("cancelled");

    const { log } = await loadMergedProgress(dir);
    expect(log.events).toHaveLength(0);
  });
});

describe("runTaskCancel — idempotency", () => {
  it("returns already_cancelled when the task is already cancelled", async () => {
    await setupProject(dir, {
      phaseYaml: phaseYaml(task("P1-T1", "cancelled")),
    });
    const result = await runTaskCancel({
      cwd: dir,
      taskId: "P1-T1",
      write: true,
    });
    expect(result.kind).toBe("already_cancelled");
    if (result.kind !== "already_cancelled") throw new Error("type narrow");
    expect(result.design_status).toBe("cancelled");
  });
});

describe("runTaskCancel — eligibility", () => {
  it("rejects cancelling a task whose design status is done", async () => {
    await setupProject(dir, {
      phaseYaml: phaseYaml(task("P1-T1", "done")),
    });
    await expect(
      runTaskCancel({ cwd: dir, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({ code: "TASK_CANCEL_NOT_ALLOWED" });
  });

  it("rejects cancelling a task whose derived state is done", async () => {
    await setupProject(dir, {
      phaseYaml: phaseYaml(task("P1-T1", "planned")),
      progressYaml: `events:
  - task_id: P1-T1
    status: done
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
`,
    });
    await expect(
      runTaskCancel({ cwd: dir, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({ code: "TASK_CANCEL_NOT_ALLOWED" });
  });

  it("rejects cancelling a task with non-cancelled direct dependents", async () => {
    const tasks = `${task("P1-T1", "planned")}
${task("P1-T2", "planned", "    depends_on:\n      - P1-T1")}`;
    await setupProject(dir, { phaseYaml: phaseYaml(tasks) });
    await expect(
      runTaskCancel({ cwd: dir, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({
      code: "TASK_CANCEL_DEPENDENTS_EXIST",
      dependents: [{ task_id: "P1-T2" }],
    });
  });

  it("allows cancelling a task whose dependents are already cancelled", async () => {
    const tasks = `${task("P1-T1", "planned")}
${task("P1-T2", "cancelled", "    depends_on:\n      - P1-T1")}`;
    await setupProject(dir, { phaseYaml: phaseYaml(tasks) });
    const result = await runTaskCancel({
      cwd: dir,
      taskId: "P1-T1",
      write: true,
    });
    expect(result.kind).toBe("cancelled");
  });
});

describe("runTaskCancel — lifecycle guards for other commands", () => {
  it("preserves contract lock and progress history on cancellation", async () => {
    await setupProject(dir);
    const result = await runTaskCancel({
      cwd: dir,
      taskId: "P1-T1",
      write: true,
    });
    expect(result.kind).toBe("cancelled");
    if (result.kind !== "cancelled") throw new Error("type narrow");
    expect(result.contract_lock_preserved).toBe(true);
    expect(result.progress_history_preserved).toBe(true);
    expect(result.task_spec_preserved).toBe(true);

    const lockPath = join(dir, ".code-pact", "state", "locks", "P1-T1.yaml");
    const lockExists = await readFile(lockPath, "utf8").then(
      () => true,
      () => false,
    );
    expect(lockExists).toBe(false);
  });
});

describe("runTaskCancel — raw phase snapshot authority", () => {
  it("uses the raw phase snapshot for eligibility even when PlanState would be stale", async () => {
    await setupProject(dir, { phaseYaml: phaseYaml(task("P1-T1", "done")) });
    const phasePath = join(dir, "design", "phases", "P1-foundation.yaml");
    const originalBytes = await readFile(phasePath, "utf8");

    await expect(
      runTaskCancel({ cwd: dir, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({ code: "TASK_CANCEL_NOT_ALLOWED" });

    const after = await readFile(phasePath, "utf8");
    expect(after).toBe(originalBytes);

    const { log } = await loadMergedProgress(dir);
    expect(log.events).toHaveLength(0);
  });

  it("detects a concurrent phase write as a CAS conflict and preserves the writer's bytes", async () => {
    await setupProject(dir);
    const phasePath = join(dir, "design", "phases", "P1-foundation.yaml");
    const plannedBytes = await readFile(phasePath, "utf8");
    const doneBytes = plannedBytes.replace("status: planned", "status: done");
    await writeFile(phasePath, doneBytes, "utf8");

    phaseMock.enabled = true;
    phaseMock.snapshot = plannedBytes;

    await expect(
      runTaskCancel({ cwd: dir, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({
      code: "TASK_CANCEL_WRITE_CONFLICT",
      rollback_status: "not_attempted",
    });

    const after = await readFile(phasePath, "utf8");
    expect(after).toBe(doneBytes);
  });

  it("rolls back to its own candidate only when its candidate is still on disk", async () => {
    await setupProject(dir);
    const phasePath = join(dir, "design", "phases", "P1-foundation.yaml");
    const plannedBytes = await readFile(phasePath, "utf8");

    phaseMock.enabled = true;
    phaseMock.snapshot = plannedBytes;
    phaseMock.postWrite = plannedBytes.replace("P1-foundation", "corrupted");

    await expect(
      runTaskCancel({ cwd: dir, taskId: "P1-T1", write: true }),
    ).rejects.toMatchObject({
      code: "TASK_CANCEL_WRITE_FAILURE",
      rollback_status: "rolled_back",
    });

    const after = await readFile(phasePath, "utf8");
    expect(after).toBe(plannedBytes);
  });
});
