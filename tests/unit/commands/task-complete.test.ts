import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskComplete } from "../../../src/commands/task-complete.ts";
import { loadMergedProgress } from "../../../src/core/progress/io.ts";

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
    ...agents.flatMap((a) => [
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

const PHASE_YAML = (opts: { failingCommand?: boolean; status?: string } = {}) =>
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
     opts.failingCommand ? '    - "false"' : "    - echo ok",
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
    PHASE_YAML({
      failingCommand: opts.failingCommand,
      status: opts.taskStatus,
    }),
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
      const result = await runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });
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
  });

  it("attaches verify checks to the thrown error", async () => {
    await setupProject(dir, { failingCommand: true });
    try {
      await runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { code?: string; checks?: { name: string; ok: boolean }[] };
      expect(e.code).toBe("VERIFICATION_FAILED");
      expect(Array.isArray(e.checks)).toBe(true);
      const commands = e.checks!.find((c) => c.name === "commands");
      expect(commands?.ok).toBe(false);
    }
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
    expect(log.events.map((e) => e.status)).toEqual(["started", "done"]);
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
