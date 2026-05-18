import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { runTaskBlock } from "../../../src/commands/task-block.ts";
import { ProgressLog } from "../../../src/core/schemas/progress-event.ts";

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
`;

const PROJECT_YAML = `name: project-test
version: 0.1.0
locale: en-US
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
    enabled: true
`;

const PHASE_YAML = `id: P1
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
`;

async function setup(dir: string, progress: string = "events: []\n") {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(join(dir, ".code-pact", "project.yaml"), PROJECT_YAML, "utf8");
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    progress,
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    PHASE_YAML,
    "utf8",
  );
}

const STARTED_YAML = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
`;

const BLOCKED_YAML = STARTED_YAML +
  `  - task_id: P1-T1
    status: blocked
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
    reason: waiting
`;

const RESUMED_YAML = BLOCKED_YAML +
  `  - task_id: P1-T1
    status: resumed
    at: "2026-05-18T11:00:00+00:00"
    actor: agent
    agent: claude-code
`;

const DONE_YAML = `events:
  - task_id: P1-T1
    status: done
    at: "2026-05-18T11:00:00+00:00"
    actor: agent
    agent: claude-code
`;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-block-"));
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTaskBlock — happy path", () => {
  it("appends a blocked event with reason from started state", async () => {
    await setup(dir, STARTED_YAML);
    const result = await runTaskBlock({
      cwd: dir,
      taskId: "P1-T1",
      reason: "waiting on schema review",
      agent: "claude-code",
    });
    expect(result.kind).toBe("blocked");
    expect(result.event.reason).toBe("waiting on schema review");
    expect(result.event.notes).toBeUndefined();

    const raw = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const log = ProgressLog.parse(parseYaml(raw) as unknown);
    expect(log.events).toHaveLength(2);
    expect(log.events[1]?.status).toBe("blocked");
    expect(log.events[1]?.reason).toBe("waiting on schema review");
  });

  it("appends a blocked event from resumed state", async () => {
    await setup(dir, RESUMED_YAML);
    await runTaskBlock({
      cwd: dir,
      taskId: "P1-T1",
      reason: "another blocker",
      agent: "claude-code",
    });
    const raw = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const log = ProgressLog.parse(parseYaml(raw) as unknown);
    expect(log.events.map((e) => e.status)).toEqual([
      "started",
      "blocked",
      "resumed",
      "blocked",
    ]);
  });

  it("survives reason with double-quotes and newlines through YAML round-trip", async () => {
    await setup(dir, STARTED_YAML);
    const reason = 'she said "no"\nand left the room';
    await runTaskBlock({
      cwd: dir,
      taskId: "P1-T1",
      reason,
      agent: "claude-code",
    });
    const raw = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    const log = ProgressLog.parse(parseYaml(raw) as unknown);
    expect(log.events[1]?.reason).toBe(reason);
  });
});

describe("runTaskBlock — invalid input", () => {
  it("rejects empty reason with CONFIG_ERROR", async () => {
    await setup(dir, STARTED_YAML);
    await expect(
      runTaskBlock({
        cwd: dir,
        taskId: "P1-T1",
        reason: "",
        agent: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("rejects whitespace-only reason with CONFIG_ERROR", async () => {
    await setup(dir, STARTED_YAML);
    await expect(
      runTaskBlock({
        cwd: dir,
        taskId: "P1-T1",
        reason: "   ",
        agent: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

describe("runTaskBlock — invalid transitions", () => {
  it("planned → blocked fails with INVALID_TASK_TRANSITION", async () => {
    await setup(dir);
    await expect(
      runTaskBlock({
        cwd: dir,
        taskId: "P1-T1",
        reason: "any",
        agent: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("blocked → blocked fails with INVALID_TASK_TRANSITION", async () => {
    await setup(dir, BLOCKED_YAML);
    await expect(
      runTaskBlock({
        cwd: dir,
        taskId: "P1-T1",
        reason: "any",
        agent: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("done → blocked fails with INVALID_TASK_TRANSITION", async () => {
    await setup(dir, DONE_YAML);
    await expect(
      runTaskBlock({
        cwd: dir,
        taskId: "P1-T1",
        reason: "any",
        agent: "claude-code",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });
});
