import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  expectJsonOk,
} from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let project: Project | null = null;

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await project?.cleanup();
  project = null;
});

async function setupFailingTask(): Promise<Project> {
  return setupTask({
    command:
      "node -e \"process.stdout.write('OUT'.repeat(4096)); process.stderr.write('ERR'.repeat(4096)); process.exit(1)\"",
    status: "planned",
  });
}

async function setupTask(opts: {
  command: string;
  status?: "planned" | "done";
  progressDone?: boolean;
  taskId?: string;
}): Promise<Project> {
  const taskId = opts.taskId ?? "P1-T1";
  project = await createTempProject({ prefix: "code-pact-evidence-cli-" });
  expectJsonOk(
    project.run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation phase for evidence integration",
      "--weight",
      "10",
      "--verify-command",
      "node --version",
      "--json",
    ]),
  );

  const phasePath = join(project.dir, "design", "phases", "P1-foundation.yaml");
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  doc.verification = {
    commands: [opts.command],
  };
  doc.tasks = [
    {
      id: taskId,
      type: "feature",
      ambiguity: "low",
      risk: "low",
      context_size: "small",
      write_surface: "low",
      verification_strength: "weak",
      expected_duration: "short",
      status: opts.status ?? "planned",
      description: "evidence integration task",
    },
  ];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
  if (opts.progressDone) {
    await writeFile(
      join(project.dir, ".code-pact", "state", "progress.yaml"),
      `events:\n  - task_id: ${JSON.stringify(taskId)}\n    status: done\n    at: "2026-07-10T00:00:00.000Z"\n    actor: agent\n`,
      "utf8",
    );
  }
  return project;
}

function expectNoTruncationKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoTruncationKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  expect(object).not.toHaveProperty("stdoutTruncated");
  expect(object).not.toHaveProperty("stderrTruncated");
  for (const child of Object.values(object)) expectNoTruncationKeys(child);
}

function worstCaseCommand(): string {
  return [
    "node -e \"const s='\\\\u0000'.repeat(1024 * 1024); process.stdout.write(s); process.stderr.write(s); process.exit(1)\"",
    "#",
    "x".repeat(40_000),
  ].join(" ");
}

function expectAgentErrorBounded(
  result: ReturnType<Project["run"]>,
  code: string,
): { data: { failure?: { kind?: string; check?: string }; omitted_fields?: string[] } } {
  expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(24 * 1024);
  const env = expectJsonErr(result, code) as {
    data: { failure?: { kind?: string; check?: string }; omitted_fields?: string[] };
  };
  expect(env.data.failure?.kind).toEqual(expect.any(String));
  return env;
}

describe("agent detail evidence envelope", () => {
  it("verify --detail agent emits a compact failure and retrievable evidence", async () => {
    const p = await setupFailingTask();
    const failed = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);
    expect(failed.code).toBe(1);
    const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
      data: {
        failure: {
          kind: string;
          evidence_ref: string;
          retrieve_command: string;
          stdout_excerpt: { head: string; tail: string };
          stderr_excerpt: { head: string; tail: string };
        };
        verify: { checks: Array<{ name: string; ok: boolean }> };
      };
    };

    expect(env.data.failure.kind).toBe("command_failed");
    expect(env.data.failure.evidence_ref).toMatch(/^evidence:sha256:[0-9a-f]{64}$/);
    expect(env.data.failure.retrieve_command).toContain("code-pact evidence show");
    expect(failed.stdout.length).toBeLessThan(24 * 1024);
    expect(failed.stdout).not.toContain('"stdout":');
    expect(failed.stdout).not.toContain('"stderr":');
    expect(env.data.verify.checks[0]).toEqual({
      name: "commands",
      ok: false,
      reason: expect.any(String),
    });

    const shown = p.run([
      "evidence",
      "show",
      env.data.failure.evidence_ref,
      "--stream",
      "stderr",
      "--json",
    ]);
    const shownEnv = expectJsonOk<{ artifact: { stderr: string } }>(shown);
    expect(shownEnv.data.artifact.stderr).toContain("ERRERRERR");
  });

  it("stores split UTF-8 process output exactly in retrievable evidence", async () => {
    const p = await setupTask({
      command: "node split-utf8.mjs",
      status: "planned",
    });
    await writeFile(
      join(p.dir, "split-utf8.mjs"),
      [
        "const stdoutChunks = [[0xc2], [0xa2], [0xe3], [0x81, 0x82], [0xf0, 0xa0], [0xae, 0xb7]];",
        "const stderrChunks = [[0xf0], [0xa0, 0xae, 0xb7], [0xe3, 0x81], [0x82], [0xc2, 0xa2]];",
        "for (const chunk of stdoutChunks) {",
        "  process.stdout.write(Buffer.from(chunk));",
        "  await new Promise(resolve => setImmediate(resolve));",
        "}",
        "for (const chunk of stderrChunks) {",
        "  process.stderr.write(Buffer.from(chunk));",
        "  await new Promise(resolve => setImmediate(resolve));",
        "}",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );
    const failed = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);
    const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
      data: { failure: { evidence_ref: string } };
    };
    const shown = p.run(["evidence", "show", env.data.failure.evidence_ref, "--json"]);
    const shownEnv = expectJsonOk<{ artifact: { stdout: string; stderr: string } }>(shown);

    expect(shownEnv.data.artifact.stdout).toBe("¢あ𠮷");
    expect(shownEnv.data.artifact.stderr).toBe("𠮷あ¢");
    expect(JSON.stringify(shownEnv)).not.toContain("\\uFFFD");
  });

  it("verify rejects unexpected positionals through the root command spec parser", async () => {
    const p = await setupFailingTask();
    const failed = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--json",
      "extra",
    ]);

    expect(failed.code).toBe(2);
    expectJsonErr(failed, "CONFIG_ERROR");
  });

  it("evidence show rejects extra positionals", async () => {
    const p = await setupFailingTask();
    const failed = p.run([
      "evidence",
      "show",
      `evidence:sha256:${"a".repeat(64)}`,
      `evidence:sha256:${"b".repeat(64)}`,
      "--json",
    ]);

    expect(failed.code).toBe(2);
    const env = expectJsonErr(failed, "CONFIG_ERROR");
    expect(env.error.message).toContain("exactly one evidence ref");
  });

  it("evidence show maps cache symlink authority errors to a stable public code", async () => {
    const p = await setupFailingTask();
    const failed = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);
    const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
      data: { failure: { evidence_ref: string } };
    };
    const outside = await mkdtemp(join(tmpdir(), "code-pact-evidence-read-"));
    await rm(join(p.dir, ".code-pact", "cache"), { recursive: true, force: true });
    await symlink(outside, join(p.dir, ".code-pact", "cache"));
    try {
      const shown = p.run(["evidence", "show", env.data.failure.evidence_ref, "--json"]);
      expect(shown.code).toBe(1);
      const shownEnv = expectJsonErr(shown, "EVIDENCE_PATH_UNSAFE") as {
        data?: { system_code?: string };
      };
      expect(shownEnv.data?.system_code).toBe("PATH_NOT_OWNED");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("bounds agent detail verify errors for long unknown phase and task ids", async () => {
    const p = await setupFailingTask();
    const longPhase = `P${"X".repeat(30_000)}`;
    const longTask = `P1-${"T".repeat(30_000)}`;

    const missingPhase = p.run([
      "verify",
      "--phase",
      longPhase,
      "--task",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);
    expect(missingPhase.code).toBe(2);
    const missingPhaseEnv = expectAgentErrorBounded(missingPhase, "PHASE_NOT_FOUND");
    expect(missingPhaseEnv.data.failure?.check).toBe("preflight");

    const missingTask = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      longTask,
      "--json",
      "--detail",
      "agent",
    ]);
    expect(missingTask.code).toBe(2);
    const missingTaskEnv = expectAgentErrorBounded(missingTask, "TASK_NOT_FOUND");
    expect(missingTaskEnv.data.omitted_fields).toContain("task_id");
  });

  it("bounds agent detail task complete errors for long task and agent inputs", async () => {
    const p = await setupFailingTask();
    const longTask = `P1-${"T".repeat(30_000)}`;
    const longAgent = `agent-${"a".repeat(30_000)}`;

    const missingTask = p.run([
      "task",
      "complete",
      longTask,
      "--json",
      "--detail",
      "agent",
    ]);
    expect(missingTask.code).toBe(2);
    const missingTaskEnv = expectAgentErrorBounded(missingTask, "TASK_NOT_FOUND");
    expect(missingTaskEnv.data.omitted_fields).toContain("task_id");

    const missingAgent = p.run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      longAgent,
      "--json",
      "--detail",
      "agent",
    ]);
    expect(missingAgent.code).toBe(2);
    const missingAgentEnv = expectAgentErrorBounded(missingAgent, "AGENT_NOT_FOUND");
    expect(missingAgentEnv.data.omitted_fields).toContain("agent");
  });

  it("bounds agent detail task complete invalid transition errors", async () => {
    const p = await setupTask({
      command: "node --version",
      status: "planned",
    });
    await writeFile(
      join(p.dir, ".code-pact", "state", "progress.yaml"),
      [
        "events:",
        "  - task_id: P1-T1",
        "    status: started",
        "    at: \"2026-07-10T00:00:00.000Z\"",
        "    actor: agent",
        "  - task_id: P1-T1",
        "    status: blocked",
        "    at: \"2026-07-10T00:01:00.000Z\"",
        "    actor: agent",
        "    reason: waiting",
        "",
      ].join("\n"),
      "utf8",
    );

    const invalid = p.run([
      "task",
      "complete",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);
    expect(invalid.code).toBe(2);
    const env = expectAgentErrorBounded(invalid, "INVALID_TASK_TRANSITION");
    expect(env.data.failure?.kind).toBe("invalid_state");
  });

  it("verify --detail agent keeps the final CLI JSON below 24 KiB for worst-case output", async () => {
    const p = await setupTask({ command: worstCaseCommand() });
    const failed = p.run([
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);

    expect(failed.code).toBe(1);
    const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
      error: { message: string };
      data: { failure: { projection_truncated?: boolean } };
    };
    expect(Buffer.byteLength(failed.stdout, "utf8")).toBeLessThan(24 * 1024);
    expect(env.error.message).toBe("Verification failed");
    expect(env.data.failure.projection_truncated).toBe(true);
    expect(failed.stdout).not.toContain("stdoutTruncated");
    expect(failed.stdout).not.toContain("stderrTruncated");
    expect(failed.stdout).not.toContain("x".repeat(1024));
  });

  it("task complete --detail agent keeps the final CLI JSON below 24 KiB for worst-case output", async () => {
    const p = await setupTask({ command: worstCaseCommand() });
    const failed = p.run([
      "task",
      "complete",
      "P1-T1",
      "--json",
      "--detail",
      "agent",
    ]);

    expect(failed.code).toBe(1);
    const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
      error: { cause_code?: string; message: string };
      data: { failure: { projection_truncated?: boolean } };
    };
    expect(Buffer.byteLength(failed.stdout, "utf8")).toBeLessThan(24 * 1024);
    expect(env.error).toMatchObject({
      cause_code: "COMMANDS_FAILED",
      message: "Verification failed",
    });
    expect(env.data.failure.projection_truncated).toBe(true);
    expect(failed.stdout).not.toContain("stdoutTruncated");
    expect(failed.stdout).not.toContain("stderrTruncated");
    expect(failed.stdout).not.toContain("x".repeat(1024));
  });

  it("task complete --detail agent bounds already_done and dry_run envelopes", async () => {
    const longTaskId = `P1-${"T".repeat(30_000)}`;
    const alreadyDone = await setupTask({
      command: "node --version",
      status: "done",
      progressDone: true,
      taskId: longTaskId,
    });
    const alreadyDoneResult = alreadyDone.run([
      "task",
      "complete",
      longTaskId,
      "--json",
      "--detail",
      "agent",
    ]);
    const alreadyDoneEnv = expectJsonOk<{
      already_done: true;
      projection_truncated?: boolean;
      omitted_fields?: string[];
    }>(alreadyDoneResult);
    expect(Buffer.byteLength(alreadyDoneResult.stdout, "utf8")).toBeLessThan(24 * 1024);
    expect(alreadyDoneEnv.data.projection_truncated).toBe(true);
    expect(alreadyDoneEnv.data.omitted_fields).toContain("task_id");
    await alreadyDone.cleanup();
    project = null;

    const dryRun = await setupTask({
      command: "node --version",
      status: "planned",
      taskId: longTaskId,
    });
    const dryRunResult = dryRun.run([
      "task",
      "complete",
      longTaskId,
      "--dry-run",
      "--json",
      "--detail",
      "agent",
    ]);
    const dryRunEnv = expectJsonOk<{
      dry_run: true;
      projection_truncated?: boolean;
      omitted_fields?: string[];
      suggested_next_command?: string;
    }>(dryRunResult);
    expect(Buffer.byteLength(dryRunResult.stdout, "utf8")).toBeLessThan(24 * 1024);
    expect(dryRunEnv.data.projection_truncated).toBe(true);
    expect(dryRunEnv.data.omitted_fields).toEqual(expect.arrayContaining(["would_append", "task_id"]));
    expect(dryRunEnv.data.suggested_next_command).toBeUndefined();
    await dryRun.cleanup();
    project = null;
  });

  it("default and full JSON keep legacy verify failure shape", async () => {
    const p = await setupFailingTask();
    for (const args of [
      ["verify", "--phase", "P1", "--task", "P1-T1", "--json"],
      ["verify", "--phase", "P1", "--task", "P1-T1", "--json", "--detail", "full"],
    ]) {
      const failed = p.run(args);
      expect(failed.code).toBe(1);
      const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
        data: { checks: Array<{ commands?: Array<Record<string, unknown>> }> };
      };
      expect(Object.keys(env.data.checks[0]!.commands![0]!).sort()).toEqual([
        "aborted",
        "command",
        "elapsedMs",
        "exitCode",
        "ok",
        "stderr",
        "stdout",
        "timedOut",
      ]);
      expectNoTruncationKeys(env);
    }
  });

  it("default and full JSON keep legacy task complete failure shape", async () => {
    for (const args of [
      ["task", "complete", "P1-T1", "--json"],
      ["task", "complete", "P1-T1", "--json", "--detail", "full"],
    ]) {
      const p = await setupFailingTask();
      const failed = p.run(args);
      expect(failed.code).toBe(1);
      const env = expectJsonErr(failed, "VERIFICATION_FAILED") as {
        data: { verify: { checks: Array<{ commands?: Array<Record<string, unknown>> }> } };
      };
      expect(Object.keys(env.data.verify.checks[0]!.commands![0]!).sort()).toEqual([
        "aborted",
        "command",
        "elapsedMs",
        "exitCode",
        "ok",
        "stderr",
        "stdout",
        "timedOut",
      ]);
      expectNoTruncationKeys(env);
      await p.cleanup();
      project = null;
    }
  });

  it("default and full JSON keep legacy success shapes", async () => {
    for (const args of [
      ["verify", "--phase", "P1", "--task", "P1-T1", "--json"],
      ["verify", "--phase", "P1", "--task", "P1-T1", "--json", "--detail", "full"],
    ]) {
      const p = await setupTask({
        command: "node --version",
        status: "done",
        progressDone: true,
      });
      const passed = p.run(args);
      const env = expectJsonOk<{ checks: Array<{ commands?: Array<Record<string, unknown>> }> }>(passed);
      expect(Object.keys(env.data.checks[0]!.commands![0]!).sort()).toEqual([
        "aborted",
        "command",
        "elapsedMs",
        "exitCode",
        "ok",
        "stderr",
        "stdout",
        "timedOut",
      ]);
      expectNoTruncationKeys(env);
      await p.cleanup();
      project = null;
    }

    for (const args of [
      ["task", "complete", "P1-T1", "--json"],
      ["task", "complete", "P1-T1", "--json", "--detail", "full"],
    ]) {
      const p = await setupTask({ command: "node --version" });
      const passed = p.run(args);
      const env = expectJsonOk<{
        verify: { checks: Array<{ commands?: Array<Record<string, unknown>> }> };
      }>(passed);
      expect(Object.keys(env.data.verify.checks[0]!.commands![0]!).sort()).toEqual([
        "aborted",
        "command",
        "elapsedMs",
        "exitCode",
        "ok",
        "stderr",
        "stdout",
        "timedOut",
      ]);
      expectNoTruncationKeys(env);
      await p.cleanup();
      project = null;
    }
  });
});
