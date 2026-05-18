import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskStatus } from "../../../src/commands/task-status.ts";

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
  - id: P2
    path: design/phases/P2-other.yaml
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

function phaseYaml(id: string, taskId: string): string {
  return `id: ${id}
name: ${id}
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
  - id: ${taskId}
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
`;
}

async function setup(
  dir: string,
  progress: string = "events: []\n",
  opts: { ambiguous?: boolean } = {},
) {
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
    phaseYaml("P1", opts.ambiguous ? "DUP-T1" : "P1-T1"),
    "utf8",
  );
  await writeFile(
    join(dir, "design", "phases", "P2-other.yaml"),
    phaseYaml("P2", opts.ambiguous ? "DUP-T1" : "P2-T1"),
    "utf8",
  );
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-status-"));
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTaskStatus", () => {
  it("returns planned + empty history for a task with no events", async () => {
    await setup(dir);
    const s = await runTaskStatus({ cwd: dir, taskId: "P1-T1" });
    expect(s.current).toBe("planned");
    expect(s.history).toEqual([]);
    expect(s.phase_id).toBe("P1");
    expect(s.last_event).toBeUndefined();
  });

  it("returns the derived current + full history for a mixed-event task", async () => {
    const progress = `events:
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
    reason: waiting
  - task_id: P1-T1
    status: resumed
    at: "2026-05-18T11:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P2-T1
    status: done
    at: "2026-05-18T12:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setup(dir, progress);
    const s = await runTaskStatus({ cwd: dir, taskId: "P1-T1" });
    expect(s.current).toBe("resumed");
    expect(s.history).toHaveLength(3);
    expect(s.last_event?.status).toBe("resumed");
  });

  it("TASK_NOT_FOUND when no phase has the task", async () => {
    await setup(dir);
    await expect(
      runTaskStatus({ cwd: dir, taskId: "NOPE-T9" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("AMBIGUOUS_TASK_ID when the same id exists in two phases", async () => {
    await setup(dir, "events: []\n", { ambiguous: true });
    await expect(
      runTaskStatus({ cwd: dir, taskId: "DUP-T1" }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TASK_ID" });
  });

  it("does NOT validate agent configuration (agent-neutral)", async () => {
    // Project.yaml lists only claude-code, but task status takes no agent
    // option. The command must not call into agent validation logic at all.
    await setup(dir);
    const s = await runTaskStatus({ cwd: dir, taskId: "P1-T1" });
    expect(s.current).toBe("planned");
  });
});
