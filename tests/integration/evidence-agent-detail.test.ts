import { beforeAll, afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
}): Promise<Project> {
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
      id: "P1-T1",
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
      `events:\n  - task_id: P1-T1\n    status: done\n    at: "2026-07-10T00:00:00.000Z"\n    actor: agent\n`,
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
