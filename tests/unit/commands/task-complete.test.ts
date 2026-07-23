import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskComplete } from "../../../src/commands/task-complete.ts";
import { loadMergedProgress } from "../../../src/core/progress/io.ts";
import { createTaskContractLock } from "../../../src/core/contract-lock.ts";
import { scanLoopMemoryEpisodes } from "../../../src/core/loop-memory/episode-store.ts";
import {
  __setLoopMemoryPruneFailureForTests,
  __setLoopMemoryRecordFailureForTests,
} from "../../../src/core/loop-memory/task-complete-recorder.ts";

// ---------------------------------------------------------------------------
// Minimal project fixture — uses `echo ok` so verify's `commands` check
// passes deterministically without needing pnpm in the temp dir.
// ---------------------------------------------------------------------------

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
`;

const PROJECT_YAML = (defaultAgent = "claude-code", agents = ["claude-code"]) =>
  [
    "name: project-test",
    "version: 0.1.0",
    "locale: en-US",
    `default_agent: ${defaultAgent}`,
    "agents:",
    ...agents.flatMap(a => [
      `  - name: ${a}`,
      `    profile: agent-profiles/${a}.yaml`,
      `    enabled: true`,
    ]),
  ].join("\n") + "\n";

const PROJECT_YAML_WITH_DISABLED = `name: project-test
version: 0.1.0
locale: en-US
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
    enabled: true
  - name: codex
    profile: agent-profiles/codex.yaml
    enabled: false
`;

const PHASE_YAML = (
  opts: { failingCommand?: boolean; status?: string; command?: string } = {},
) =>
  [
    "id: P1",
    "name: Foundation",
    "weight: 12",
    "confidence: high",
    "risk: low",
    "status: planned",
    "objective: test phase",
    "definition_of_done:",
    "  - tests pass",
    "verification:",
    "  commands:",
    // Quote "false" so YAML keeps it as a string (otherwise it parses
    // as boolean and Phase schema rejects). When spawned, the literal
    // bin name "false" exits 1 on macOS/Linux.
    opts.command
      ? `    - ${opts.command}`
      : opts.failingCommand
        ? '    - "false"'
        : "    - echo ok",
    "tasks:",
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: weak",
    "    expected_duration: short",
    `    status: ${opts.status ?? "planned"}`,
  ].join("\n") + "\n";

const EMPTY_PROGRESS = `events: []\n`;

async function setupProject(
  dir: string,
  opts: {
    failingCommand?: boolean;
    taskStatus?: string;
    projectYaml?: string;
    progressYaml?: string;
    command?: string;
    phaseYaml?: string;
  } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    opts.projectYaml ?? PROJECT_YAML(),
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? EMPTY_PROGRESS,
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    opts.phaseYaml ??
      PHASE_YAML({
        failingCommand: opts.failingCommand,
        status: opts.taskStatus,
        command: opts.command,
      }),
    "utf8",
  );

  // Lock the contract before writing progress.yaml so createTaskContractLock
  // sees the task as not yet done. Progress events (including any pre-supplied
  // done event) are written afterwards.
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "--quiet"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd: dir,
  });
  spawnSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ],
    { cwd: dir },
  );

  if (opts.taskStatus !== "cancelled") {
    await createTaskContractLock({
      cwd: dir,
      taskId: "P1-T1",
      actor: "agent",
      agent: "claude-code",
    });
  }

  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? EMPTY_PROGRESS,
    "utf8",
  );
}

async function readProgress(dir: string) {
  // Merged view (legacy progress.yaml + per-event files).
  const { raw, log } = await loadMergedProgress(dir);
  return { raw, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-complete-"));
});

afterEach(async () => {
  __setLoopMemoryRecordFailureForTests(null);
  __setLoopMemoryPruneFailureForTests(null);
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTaskComplete — happy path", () => {
  it("appends a done event and returns kind=done on verify pass", async () => {
    await setupProject(dir);
    const fakeNow = () => new Date("2026-05-17T00:00:00+09:00");

    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      now: fakeNow,
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.agent).toBe("claude-code");
    expect(result.event.status).toBe("done");
    expect(result.event.actor).toBe("agent");
    expect(result.event.agent).toBe("claude-code");
    expect(result.event.at).toBe("2026-05-16T15:00:00.000Z");
    expect(result.event.source).toBe("loop");
    expect(result.verify.ok).toBe(true);

    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]!.task_id).toBe("P1-T1");
    expect(log.events[0]!.status).toBe("done");
    expect(log.events[0]!.agent).toBe("claude-code");
    expect(log.events[0]!.source).toBe("loop");

    const memory = await scanLoopMemoryEpisodes(dir);
    expect(memory.episodes).toHaveLength(1);
    expect(memory.episodes[0]!.episode.kind).toBe("verification_passed");
    expect(memory.episodes[0]!.episode.verification.ok).toBe(true);
  });

  it("uses default_agent when --agent is omitted", async () => {
    await setupProject(dir);
    const result = await runTaskComplete({ cwd: dir, taskId: "P1-T1" });
    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.agent).toBe("claude-code");
    expect(result.event.agent).toBe("claude-code");
  });

  it("preserves existing events when appending", async () => {
    const existing = `events:
  - task_id: P0-T9
    status: done
    at: "2026-05-15T10:00:00+09:00"
    actor: human
    evidence:
      - manual review
`;
    await setupProject(dir, { progressYaml: existing });

    await runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });

    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(2);
    expect(log.events[0]!.task_id).toBe("P0-T9");
    expect(log.events[1]!.task_id).toBe("P1-T1");
  });

  it("persists author on the real (non-dry-run) done event (D1)", async () => {
    await setupProject(dir);
    const saved = process.env.CODE_PACT_AUTHOR;
    process.env.CODE_PACT_AUTHOR = "Ada Lovelace";
    try {
      const result = await runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
      });
      if (result.kind !== "done") throw new Error("type narrow");
      expect(result.event.author).toBe("Ada Lovelace");
      const { log } = await readProgress(dir);
      expect(log.events.at(-1)?.author).toBe("Ada Lovelace");
    } finally {
      if (saved === undefined) delete process.env.CODE_PACT_AUTHOR;
      else process.env.CODE_PACT_AUTHOR = saved;
    }
  });
});

describe("runTaskComplete — idempotency", () => {
  it("returns kind=already_done on second call without re-running verify", async () => {
    await setupProject(dir);
    await runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });
    const before = await readProgress(dir);
    expect(before.log.events).toHaveLength(1);

    const second = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(second.kind).toBe("already_done");
    if (second.kind !== "already_done") throw new Error("type narrow");
    expect(second.task_id).toBe("P1-T1");
    expect(second.phase_id).toBe("P1");

    const after = await readProgress(dir);
    expect(after.log.events).toHaveLength(1);
  });

  it("idempotent path is not affected by command being broken", async () => {
    // First run: succeeds (echo ok)
    await setupProject(dir);
    await runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });

    // Replace phase with failing command. The second call should still
    // return already_done because the idempotency check runs before verify.
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML({ failingCommand: true }),
      "utf8",
    );
    const second = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(second.kind).toBe("already_done");
  });
});

describe("runTaskComplete — verify failure", () => {
  it("throws VERIFICATION_FAILED and leaves progress.yaml byte-identical", async () => {
    await setupProject(dir, { failingCommand: true });
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });

    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);

    const memory = await scanLoopMemoryEpisodes(dir);
    expect(memory.episodes).toHaveLength(1);
    expect(memory.episodes[0]!.episode.kind).toBe("verification_failed");
    expect(memory.episodes[0]!.episode.verification).toMatchObject({
      ok: false,
      failure_kind: "command_failed",
      failed_check: "commands",
      failed_command: "false",
    });
    expect(
      memory.episodes[0]!.episode.verification.failure_fingerprint,
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("omits unsafe absolute-path commands from local memory episodes", async () => {
    await setupProject(dir, {
      command: 'node -e "process.exit(1)" --path=[/tmp/code-pact-memory]',
    });

    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });

    const memory = await scanLoopMemoryEpisodes(dir);
    expect(memory.episodes).toHaveLength(1);
    expect(
      memory.episodes[0]!.episode.verification.failed_command,
    ).toBeUndefined();
    expect(
      memory.episodes[0]!.episode.verification.failure_fingerprint,
    ).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("attaches verify checks to the thrown error", async () => {
    await setupProject(dir, { failingCommand: true });
    try {
      await runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
      });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & {
        code?: string;
        checks?: { name: string; ok: boolean }[];
      };
      expect(e.code).toBe("VERIFICATION_FAILED");
      expect(Array.isArray(e.checks)).toBe(true);
      const commands = e.checks!.find(c => c.name === "commands");
      expect(commands?.ok).toBe(false);
    }
  });

  it("attaches prior-local signal only after an exact prior failure exists", async () => {
    await setupProject(dir, { failingCommand: true });

    try {
      await runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        now: () => new Date("2026-07-16T00:00:00.000Z"),
      });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { code?: string; priorLocalSignal?: unknown };
      expect(e.code).toBe("VERIFICATION_FAILED");
      expect(e.priorLocalSignal).toBeUndefined();
    }

    try {
      await runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        now: () => new Date("2026-07-16T00:00:01.000Z"),
      });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & {
        code?: string;
        priorLocalSignal?: {
          schema_version: number;
          exact_match_count: number;
          last_observed_at: string;
        };
      };
      expect(e.code).toBe("VERIFICATION_FAILED");
      expect(e.priorLocalSignal).toEqual({
        schema_version: 1,
        exact_match_count: 1,
        last_observed_at: "2026-07-16T00:00:00.000Z",
      });
    }

    const memory = await scanLoopMemoryEpisodes(dir);
    expect(memory.episodes).toHaveLength(2);
  });

  it("does not change verification failure when local memory recording fails", async () => {
    await setupProject(dir, { failingCommand: true });
    __setLoopMemoryRecordFailureForTests(() => new Error("disk full"));

    try {
      await runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
      });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & {
        code?: string;
        warnings?: Array<{ code: string; affects_exit: boolean }>;
      };
      expect(e.code).toBe("VERIFICATION_FAILED");
      expect(e.warnings).toEqual([
        {
          code: "LOCAL_MEMORY_WRITE_SKIPPED",
          message: "The local loop-memory episode was not recorded.",
          affects_exit: false,
        },
      ]);
    }
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(0);
  });
});

describe("runTaskComplete — dry run", () => {
  it("returns kind=dry_run, leaves progress.yaml byte-identical, returns would_append", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });
    expect(result.kind).toBe("dry_run");
    if (result.kind !== "dry_run") throw new Error("type narrow");
    expect(result.would_append.task_id).toBe("P1-T1");
    expect(result.would_append.status).toBe("done");
    expect(result.would_append.agent).toBe("claude-code");

    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(0);
  });

  it("SECURITY: --dry-run does NOT execute verification commands (no side effects)", async () => {
    // The verification command would create a marker file IF executed. A
    // dry-run completion must only PREVIEW verification, never run the
    // project-controlled (shell: true) commands.
    const marker = join(dir, "dryrun-marker");
    await setupProject(dir, { command: `touch ${JSON.stringify(marker)}` });
    const progressBefore = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });

    expect(result.kind).toBe("dry_run");
    // The command never ran → no marker, and the commands check is a preview.
    expect(existsSync(marker)).toBe(false);
    if (result.kind === "dry_run") {
      const commands = result.verify.checks.find(c => c.name === "commands");
      expect(commands?.ok).toBe(true);
      expect(commands?.reason ?? "").toContain("dry-run");
    }
    // Ledger untouched.
    const progressAfter = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(progressAfter).toBe(progressBefore);
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(0);
  });

  it("contrast: a real (non-dry-run) completion DOES execute verification commands", async () => {
    const marker = join(dir, "real-marker");
    await setupProject(dir, { command: `touch ${JSON.stringify(marker)}` });

    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.kind).toBe("done");
    // The command ran → marker exists.
    expect(existsSync(marker)).toBe(true);
  });

  it("does not change successful completion when local memory recording fails", async () => {
    await setupProject(dir);
    __setLoopMemoryRecordFailureForTests(() => new Error("disk full"));

    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.warnings).toEqual([
      {
        code: "LOCAL_MEMORY_WRITE_SKIPPED",
        message: "The local loop-memory episode was not recorded.",
        affects_exit: false,
      },
    ]);
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(1);
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(0);
  });

  it("reports retention maintenance failure separately after recording the episode", async () => {
    await setupProject(dir);
    __setLoopMemoryPruneFailureForTests(() => new Error("maintenance failed"));

    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.warnings).toEqual([
      {
        code: "LOCAL_MEMORY_PRUNE_SKIPPED",
        message:
          "The local loop-memory episode was recorded, but retention maintenance was skipped.",
        affects_exit: false,
      },
    ]);
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(1);
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(1);
  });

  it("would_append carries author (dry-run preview matches what would be written)", async () => {
    await setupProject(dir);
    const saved = process.env.CODE_PACT_AUTHOR;
    process.env.CODE_PACT_AUTHOR = "Ada Lovelace";
    try {
      const result = await runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        dryRun: true,
      });
      if (result.kind !== "dry_run") throw new Error("type narrow");
      expect(result.would_append.author).toBe("Ada Lovelace");
    } finally {
      if (saved === undefined) delete process.env.CODE_PACT_AUTHOR;
      else process.env.CODE_PACT_AUTHOR = saved;
    }
  });
});

describe("runTaskComplete — error codes", () => {
  it("TASK_NOT_FOUND when no phase has the task", async () => {
    await setupProject(dir);
    await expect(
      runTaskComplete({ cwd: dir, taskId: "NOPE-T9", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("AGENT_NOT_FOUND for an agent not in project.yaml", async () => {
    await setupProject(dir);
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "missing-agent" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("AGENT_NOT_ENABLED for an agent with enabled: false", async () => {
    await setupProject(dir, { projectYaml: PROJECT_YAML_WITH_DISABLED });
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "codex" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ENABLED" });
  });

  it("agent validation runs before progress.yaml is touched", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "missing-agent" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("TASK_CANCELLED when the task design status is cancelled", async () => {
    await setupProject(dir, { taskStatus: "cancelled" });
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_CANCELLED" });
  });
});

describe("runTaskComplete — dependencies", () => {
  const PHASE_WITH_DEPENDENCY = `id: P1
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
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
    depends_on:
      - P1-T2
  - id: P1-T2
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
`;

  it("throws TASK_DEPENDENCY_INCOMPLETE when depends_on is not done", async () => {
    await setupProject(dir, { phaseYaml: PHASE_WITH_DEPENDENCY });
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({
      code: "TASK_DEPENDENCY_INCOMPLETE",
      deps: ["P1-T2"],
    });
    expect((await readProgress(dir)).log.events).toHaveLength(0);
  });

  it("completes when depends_on task is already done", async () => {
    const progress = `events:
  - task_id: P1-T2
    status: done
    at: "2026-05-15T10:00:00+09:00"
    actor: human
    evidence:
      - manual review
`;
    await setupProject(dir, {
      phaseYaml: PHASE_WITH_DEPENDENCY,
      progressYaml: progress,
    });
    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.kind).toBe("done");
    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(2);
    expect(log.events[1]!.task_id).toBe("P1-T1");
    expect(log.events[1]!.status).toBe("done");
  });
});

describe("runTaskComplete — state transitions (v0.6)", () => {
  it("started → done succeeds and appends a done event", async () => {
    const started = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: started });
    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.kind).toBe("done");
    const { log } = await readProgress(dir);
    expect(log.events.map(e => e.status)).toEqual(["started", "done"]);
  });

  it("resumed → done succeeds and appends a done event", async () => {
    const resumed = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: blocked
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
    reason: waiting on review
  - task_id: P1-T1
    status: resumed
    at: "2026-05-18T11:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: resumed });
    const result = await runTaskComplete({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.kind).toBe("done");
    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(4);
    expect(log.events[3]!.status).toBe("done");
  });

  it("blocked → done is rejected with INVALID_TASK_TRANSITION and progress.yaml stays byte-identical", async () => {
    const blocked = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: blocked
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
    reason: waiting on review
`;
    await setupProject(dir, { progressYaml: blocked });
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});

describe("runTaskComplete — bounded verification and cancellation", () => {
  it("times out without recording a done event", async () => {
    await setupProject(dir, { command: "node hang.mjs" });
    await writeFile(join(dir, "hang.mjs"), "setInterval(() => {}, 10000);\n");

    await expect(
      runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(0);
    const memory = await scanLoopMemoryEpisodes(dir);
    expect(memory.episodes).toHaveLength(1);
    expect(memory.episodes[0]!.episode.verification.failure_kind).toBe(
      "timed_out",
    );
  }, 10_000);

  it("rejects an already-aborted operation without recording an event", async () => {
    await setupProject(dir);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(0);
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(0);
  });

  it("honours cancellation immediately before the event-write commit point", async () => {
    await setupProject(dir);
    const controller = new AbortController();

    await expect(
      runTaskComplete({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        signal: controller.signal,
        now: () => {
          controller.abort();
          return new Date("2026-07-05T00:00:00Z");
        },
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(0);
  });
});
