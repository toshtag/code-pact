import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let project: Awaited<ReturnType<typeof createTempProject>> | undefined;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

async function setupPhase(
  p: Awaited<ReturnType<typeof createTempProject>>,
): Promise<Awaited<ReturnType<typeof createTempProject>>> {
  expectJsonOk(
    p.run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--weight",
      "1",
      "--objective",
      "Test phase",
      "--verify-command",
      "echo ok",
      "--json",
    ]),
  );
  return p;
}

async function setupSingleTask(): Promise<
  Awaited<ReturnType<typeof createTempProject>>
> {
  const p = await createTempProject();
  await setupPhase(p);
  expectJsonOk(
    p.run([
      "task",
      "add",
      "P1",
      "--type",
      "feature",
      "--description",
      "First task",
      "--json",
    ]),
  );
  return p;
}

async function setupDependentTask(): Promise<
  Awaited<ReturnType<typeof createTempProject>>
> {
  const p = await createTempProject();
  await setupPhase(p);
  expectJsonOk(
    p.run([
      "task",
      "add",
      "P1",
      "--type",
      "feature",
      "--description",
      "First task",
      "--json",
    ]),
  );
  expectJsonOk(
    p.run([
      "task",
      "add",
      "P1",
      "--type",
      "feature",
      "--description",
      "Dependent task",
      "--depends-on",
      "P1-T1",
      "--json",
    ]),
  );
  return p;
}

describe("task cancel", () => {
  it("dry-run returns cancel_preview and does not write", async () => {
    project = await setupSingleTask();
    const before = await readFile(
      join(project.dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );

    const result = expectJsonOk(
      project.run(["task", "cancel", "P1-T1", "--json"]),
    );
    expect(result.data).toMatchObject({
      kind: "cancel_preview",
      task_id: "P1-T1",
      phase_id: "P1",
      current_design_status: "planned",
      would_change: { task_status: { from: "planned", to: "cancelled" } },
    });

    const after = await readFile(
      join(project.dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("writes cancelled status with --write", async () => {
    project = await setupSingleTask();
    const result = expectJsonOk(
      project.run(["task", "cancel", "P1-T1", "--write", "--json"]),
    );
    expect(result.data).toMatchObject({
      kind: "cancelled",
      task_id: "P1-T1",
      previous_design_status: "planned",
      design_status: "cancelled",
    });

    const phaseRaw = await readFile(
      join(project.dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    expect(phaseRaw).toContain("status: cancelled");
  });

  it("is idempotent for already cancelled tasks", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));
    const result = expectJsonOk(
      project.run(["task", "cancel", "P1-T1", "--write", "--json"]),
    );
    expect(result.data).toMatchObject({
      kind: "already_cancelled",
      task_id: "P1-T1",
    });
  });

  it("refuses to cancel a task with non-cancelled dependents", async () => {
    project = await setupDependentTask();
    const result = expectJsonErr(
      project.run(["task", "cancel", "P1-T1", "--write", "--json"]),
      "TASK_CANCEL_DEPENDENTS_EXIST",
    );
    expect(result.error.message).toContain("P1-T2");
  });

  it("lifecycle commands reject cancelled tasks", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));

    const start = expectJsonErr(
      project.run(["task", "start", "P1-T1", "--json"]),
      "TASK_CANCELLED",
    );
    expect(start.error.message).toContain("cancelled");
  });
});
