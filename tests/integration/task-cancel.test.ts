import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";
import { chmod, readFile, writeFile } from "node:fs/promises";
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

  it("prepare returns a no-op for cancelled tasks", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));

    const minimal = expectJsonOk<{
      next: { type: string; command: string | null };
    }>(
      project.run([
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        "claude-code",
        "--json",
      ]),
    );
    expect(minimal.data.next).toMatchObject({
      type: "noop_cancelled",
      command: null,
    });

    const full = expectJsonOk<{
      next_action: { type: string };
      commands: Record<string, never>;
      context_pack_path: null;
      context_pack_bytes: number;
    }>(
      project.run([
        "task",
        "prepare",
        "P1-T1",
        "--agent",
        "claude-code",
        "--detail",
        "full",
        "--json",
      ]),
    );
    expect(full.data.next_action).toMatchObject({ type: "noop_cancelled" });
    expect(full.data.commands).toEqual({});
    expect(full.data.context_pack_path).toBeNull();
    expect(full.data.context_pack_bytes).toBe(0);
  });

  it("lock exits 2 with TASK_CANCELLED and does not create a lock", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));

    const res = project.run(["task", "lock", "P1-T1", "--json"]);
    const parsed = expectJsonErr(res, "TASK_CANCELLED");
    expect(res.code).toBe(2);
    expect(res.stderr).toBe("");
    expect(parsed.error.message).toContain("cancelled");

    const lockPath = join(
      project.dir,
      ".code-pact",
      "state",
      "locks",
      "P1-T1.yaml",
    );
    const lockExists = await readFile(lockPath, "utf8").then(
      () => true,
      () => false,
    );
    expect(lockExists).toBe(false);
  });

  it("block exits 2 with TASK_CANCELLED", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));

    const res = project.run([
      "task",
      "block",
      "P1-T1",
      "--reason",
      "stuck",
      "--json",
    ]);
    const parsed = expectJsonErr(res, "TASK_CANCELLED");
    expect(res.code).toBe(2);
    expect(parsed.error.message).toContain("cancelled");
  });

  it("resume exits 2 with TASK_CANCELLED", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));

    const res = project.run(["task", "resume", "P1-T1", "--json"]);
    const parsed = expectJsonErr(res, "TASK_CANCELLED");
    expect(res.code).toBe(2);
    expect(parsed.error.message).toContain("cancelled");
  });

  it("execute short-circuits with DESIGN_CANCELLED and performs no side effects", async () => {
    project = await setupSingleTask();
    expectJsonOk(project.run(["task", "cancel", "P1-T1", "--write", "--json"]));

    const executorPath = join(project.dir, "executor.mjs");
    await writeFile(
      executorPath,
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({ kind: 'done' }));\n",
      "utf8",
    );
    await chmod(executorPath, 0o755);

    const res = project.run([
      "task",
      "execute",
      "P1-T1",
      "--executor-file",
      "executor.mjs",
      "--json",
    ]);
    const parsed = expectJsonErr(res, "EXECUTION_INELIGIBLE");
    expect(res.code).toBe(1);
    expect((parsed as { data?: { reasons?: string[] } }).data?.reasons).toEqual(
      ["DESIGN_CANCELLED"],
    );

    const phaseRaw = await readFile(
      join(project.dir, "design", "phases", "P1-foundation.yaml"),
      "utf8",
    );
    expect(phaseRaw).toContain("status: cancelled");
  });
});
