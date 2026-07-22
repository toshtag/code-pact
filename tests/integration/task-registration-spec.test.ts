import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";

let project: Awaited<ReturnType<typeof createTempProject>> | undefined;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function specBody(opts: {
  phaseId: string;
  taskId: string;
  dependsOn?: string[];
}): string {
  return `schema_version: 1
phase_id: ${opts.phaseId}
task:
  id: ${opts.taskId}
  type: feature
  ambiguity: low
  risk: medium
  context_size: medium
  write_surface: medium
  verification_strength: medium
  expected_duration: medium
  status: planned
  description: "Registered from a strict spec"
  requires_decision: false
  depends_on: ${yamlArray(opts.dependsOn ?? [])}
  decision_refs: []
  reads: []
  writes: []
  acceptance_refs: []
`;
}

function yamlArray(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return "\n" + arr.map(v => `    - ${v}`).join("\n");
}

async function setupPhase(
  p: Awaited<ReturnType<typeof createTempProject>>,
): Promise<void> {
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
}

describe("task add --spec-file", () => {
  it("registers a task losslessly and reports digest round-trip", async () => {
    project = await createTempProject();
    await setupPhase(project);

    const specPath = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(specPath, specBody({ phaseId: "P1", taskId: "P1-T1" }));

    const res = expectJsonOk<{
      registrationMode?: string;
      specDigest?: string;
      storedTaskDigest?: string;
      roundTripEqual?: boolean;
    }>(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );
    expect(res.data.registrationMode).toBe("spec_file");
    expect(res.data.roundTripEqual).toBe(true);
    expect(typeof res.data.specDigest).toBe("string");
    expect(res.data.specDigest).toBe(res.data.storedTaskDigest);
  });

  it("rejects conflicting flags with --spec-file", async () => {
    project = await createTempProject();
    await setupPhase(project);

    const specPath = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(specPath, specBody({ phaseId: "P1", taskId: "P1-T1" }));

    const res = expectJsonErr(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--description",
        "X",
        "--json",
      ]),
      "CONFIG_ERROR",
    );
    expect(res.error.message).toContain("cannot be combined");
  });
});

describe("task lock --spec-file", () => {
  it("locks with a matching spec and stores the registration digest", async () => {
    project = await createTempProject();
    await setupPhase(project);

    const specPath = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(specPath, specBody({ phaseId: "P1", taskId: "P1-T1" }));

    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );

    git(project.dir, ["init", "--quiet"]);
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);

    const res = expectJsonOk<{ task_id: string }>(
      project.run([
        "task",
        "lock",
        "P1-T1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );
    expect(res.data.task_id).toBe("P1-T1");

    const lockPath = join(
      project.dir,
      ".code-pact",
      "state",
      "locks",
      "P1-T1.yaml",
    );
    expect(existsSync(lockPath)).toBe(true);
    const lock = parseYaml(readFileSync(lockPath, "utf8")) as {
      registration?: { mode: string; spec_digest: string };
    };
    expect(lock.registration?.mode).toBe("spec_file");
    expect(typeof lock.registration?.spec_digest).toBe("string");
  });

  it("fails without side effects when depends_on is omitted (P80 replay)", async () => {
    project = await createTempProject();
    await setupPhase(project);

    // Create a base task and a downstream task that depends on it.
    const baseSpec = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(baseSpec, specBody({ phaseId: "P1", taskId: "P1-T1" }));
    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );

    const depSpec = join(project.dir, "p1-t2-spec.yaml");
    writeFileSync(
      depSpec,
      specBody({ phaseId: "P1", taskId: "P1-T2", dependsOn: ["P1-T1"] }),
    );
    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t2-spec.yaml",
        "--json",
      ]),
    );

    git(project.dir, ["init", "--quiet"]);
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);

    // Capture original phase bytes before the P80-style omission.
    const phasePath = join(
      project.dir,
      "design",
      "phases",
      "P1-foundation.yaml",
    );
    const originalBytes = readFileSync(phasePath, "utf8");

    // Simulate P80-style omission: remove depends_on from P1-T2 in the phase YAML.
    const phase = parseYaml(originalBytes) as {
      tasks: { id: string; depends_on?: string[] }[];
    };
    const p1t2 = phase.tasks.find(t => t.id === "P1-T2");
    expect(p1t2).toBeDefined();
    expect(p1t2?.depends_on).toEqual(["P1-T1"]);
    p1t2!.depends_on = [];
    writeFileSync(phasePath, stringifyYaml(phase));

    const lockPath = join(
      project.dir,
      ".code-pact",
      "state",
      "locks",
      "P1-T2.yaml",
    );
    expect(existsSync(lockPath)).toBe(false);

    const res = project.run([
      "task",
      "lock",
      "P1-T2",
      "--spec-file",
      "p1-t2-spec.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = expectJsonErr(res, "TASK_REGISTRATION_SPEC_MISMATCH");
    expect(parsed.error.message).toContain("depends_on");

    // No lock file should have been written as a side effect.
    expect(existsSync(lockPath)).toBe(false);

    // Restore the correct phase and lock the downstream task.
    writeFileSync(phasePath, originalBytes);
    git(project.dir, ["add", "."]);
    git(project.dir, ["commit", "--quiet", "-m", "restore phase"]);

    const lockRes = expectJsonOk<{ task_id: string }>(
      project.run([
        "task",
        "lock",
        "P1-T2",
        "--spec-file",
        "p1-t2-spec.yaml",
        "--json",
      ]),
    );
    expect(lockRes.data.task_id).toBe("P1-T2");
    expect(existsSync(lockPath)).toBe(true);

    const lock = parseYaml(readFileSync(lockPath, "utf8")) as {
      contract?: { depends_on?: string[] };
    };
    expect(lock.contract?.depends_on).toEqual(["P1-T1"]);

    // Commit the lock so the start commands run against a clean worktree.
    git(project.dir, ["add", "."]);
    git(project.dir, ["commit", "--quiet", "-m", "lock P1-T2"]);

    // Capture authoritative state before the blocked start.
    const lockBefore = readFileSync(lockPath, "utf8");
    const phaseBefore = readFileSync(phasePath, "utf8");
    const eventsDir = join(project.dir, ".code-pact", "state", "events");
    const eventsBefore = existsSync(eventsDir)
      ? readdirSync(eventsDir).sort()
      : [];
    const statusBefore = git(project.dir, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(statusBefore.stdout).toBe("");

    // P82 start gate: P1-T2 cannot start while P1-T1 is incomplete.
    const blockedStart = project.run(["task", "start", "P1-T2", "--json"]);
    expect(blockedStart.code).toBe(2);
    const blockedParsed = expectJsonErr(
      blockedStart,
      "TASK_DEPENDENCY_INCOMPLETE",
    );
    expect(blockedParsed.error.message).toContain("P1-T1");

    // The failed start must have no side effects.
    const lockAfter = readFileSync(lockPath, "utf8");
    const phaseAfter = readFileSync(phasePath, "utf8");
    const eventsAfter = existsSync(eventsDir)
      ? readdirSync(eventsDir).sort()
      : [];
    const statusAfter = git(project.dir, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);

    expect(lockAfter).toBe(lockBefore);
    expect(phaseAfter).toBe(phaseBefore);
    expect(eventsAfter).toEqual(eventsBefore);
    expect(statusAfter.stdout).toBe("");

    // Complete P1-T1 through the normal lifecycle.
    expectJsonOk(project.run(["task", "start", "P1-T1", "--json"]));
    expectJsonOk(project.run(["task", "complete", "P1-T1", "--json"]));

    // Now P1-T2 can start.
    const startRes = expectJsonOk<{
      event: { task_id: string; status: string };
    }>(project.run(["task", "start", "P1-T2", "--json"]));
    expect(startRes.data.event.task_id).toBe("P1-T2");
    expect(startRes.data.event.status).toBe("started");
  });

  it("rejects start with TASK_CONTRACT_DRIFT when spec file drifts (P83-T6)", async () => {
    project = await createTempProject();
    await setupPhase(project);

    const baseSpec = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(baseSpec, specBody({ phaseId: "P1", taskId: "P1-T1" }));
    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );

    const depSpec = join(project.dir, "p1-t2-spec.yaml");
    writeFileSync(
      depSpec,
      specBody({ phaseId: "P1", taskId: "P1-T2", dependsOn: ["P1-T1"] }),
    );
    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t2-spec.yaml",
        "--json",
      ]),
    );

    git(project.dir, ["init", "--quiet"]);
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);

    expectJsonOk(
      project.run([
        "task",
        "lock",
        "P1-T2",
        "--spec-file",
        "p1-t2-spec.yaml",
        "--json",
      ]),
    );

    const lockPath = join(
      project.dir,
      ".code-pact",
      "state",
      "locks",
      "P1-T2.yaml",
    );
    const phasePath = join(
      project.dir,
      "design",
      "phases",
      "P1-foundation.yaml",
    );
    const eventsDir = join(project.dir, ".code-pact", "state", "events");

    git(project.dir, ["add", "."]);
    git(project.dir, ["commit", "--quiet", "-m", "lock P1-T2"]);

    // Complete P1-T1 so P1-T2 reaches the spec-drift gate rather than the
    // dependency gate.
    expectJsonOk(project.run(["task", "start", "P1-T1", "--json"]));
    expectJsonOk(project.run(["task", "complete", "P1-T1", "--json"]));
    git(project.dir, ["add", "."]);
    git(project.dir, ["commit", "--quiet", "-m", "complete P1-T1"]);

    const lockBefore = readFileSync(lockPath, "utf8");
    const phaseBefore = readFileSync(phasePath, "utf8");
    const eventsBefore = existsSync(eventsDir)
      ? readdirSync(eventsDir).sort()
      : [];
    const statusBefore = git(project.dir, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(statusBefore.stdout).toBe("");

    const drifted = specBody({
      phaseId: "P1",
      taskId: "P1-T2",
      dependsOn: ["P1-T1"],
    }).replace("reads: []", "reads:\n    - src/commands/task-progress.ts");
    writeFileSync(depSpec, drifted);

    const driftStart = project.run(["task", "start", "P1-T2", "--json"]);
    expect(driftStart.code).toBe(2);
    expect(driftStart.stderr).toBe("");
    expect(driftStart.stdout.trim().split("\n").length).toBe(1);
    const driftParsed = expectJsonErr(driftStart, "TASK_CONTRACT_DRIFT");
    expect(
      (driftParsed.data as { changed_fields?: string[] } | undefined)
        ?.changed_fields,
    ).toEqual(["registration_spec_file"]);

    const lockAfter = readFileSync(lockPath, "utf8");
    const phaseAfter = readFileSync(phasePath, "utf8");
    const eventsAfter = existsSync(eventsDir)
      ? readdirSync(eventsDir).sort()
      : [];

    expect(lockAfter).toBe(lockBefore);
    expect(phaseAfter).toBe(phaseBefore);
    expect(eventsAfter).toEqual(eventsBefore);

    // Restore the spec file. The failed start must not have produced any
    // code-pact-side side effects.
    writeFileSync(
      depSpec,
      specBody({ phaseId: "P1", taskId: "P1-T2", dependsOn: ["P1-T1"] }),
    );

    const statusAfter = git(project.dir, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    expect(statusAfter.stdout).toBe("");

    const startRes = expectJsonOk<{
      event: { task_id: string; status: string };
    }>(project.run(["task", "start", "P1-T2", "--json"]));
    expect(startRes.data.event.task_id).toBe("P1-T2");
    expect(startRes.data.event.status).toBe("started");
  });

  it("fails with TASK_REGISTRATION_SPEC_MISMATCH when status changed", async () => {
    project = await createTempProject();
    await setupPhase(project);

    const specPath = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(specPath, specBody({ phaseId: "P1", taskId: "P1-T1" }));

    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );

    git(project.dir, ["init", "--quiet"]);
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);

    // Simulate a lifecycle status mutation before lock.
    const phasePath = join(
      project.dir,
      "design",
      "phases",
      "P1-foundation.yaml",
    );
    const phase = parseYaml(readFileSync(phasePath, "utf8")) as {
      tasks: { id: string; status: string }[];
    };
    const task = phase.tasks.find(t => t.id === "P1-T1");
    expect(task).toBeDefined();
    task!.status = "in_progress";
    writeFileSync(phasePath, stringifyYaml(phase));

    const res = project.run([
      "task",
      "lock",
      "P1-T1",
      "--spec-file",
      "p1-t1-spec.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = expectJsonErr(res, "TASK_REGISTRATION_SPEC_MISMATCH");
    expect(parsed.error.message).toContain("status");
  });

  it("fails with TASK_REGISTRATION_SPEC_MISMATCH when requires_decision is removed", async () => {
    project = await createTempProject();
    await setupPhase(project);

    const specPath = join(project.dir, "p1-t1-spec.yaml");
    writeFileSync(specPath, specBody({ phaseId: "P1", taskId: "P1-T1" }));

    expectJsonOk(
      project.run([
        "task",
        "add",
        "P1",
        "--spec-file",
        "p1-t1-spec.yaml",
        "--json",
      ]),
    );

    git(project.dir, ["init", "--quiet"]);
    git(project.dir, ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git(project.dir, [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "init",
    ]);

    const phasePath = join(
      project.dir,
      "design",
      "phases",
      "P1-foundation.yaml",
    );
    const phase = parseYaml(readFileSync(phasePath, "utf8")) as {
      tasks: { id: string; requires_decision?: boolean }[];
    };
    const task = phase.tasks.find(t => t.id === "P1-T1");
    expect(task).toBeDefined();
    delete task!.requires_decision;
    writeFileSync(phasePath, stringifyYaml(phase));

    const res = project.run([
      "task",
      "lock",
      "P1-T1",
      "--spec-file",
      "p1-t1-spec.yaml",
      "--json",
    ]);
    expect(res.code).toBe(2);
    const parsed = expectJsonErr(res, "TASK_REGISTRATION_SPEC_MISMATCH");
    expect(parsed.error.message).toContain("requires_decision");
  });
});
