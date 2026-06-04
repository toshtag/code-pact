import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskResume } from "../../../src/commands/task-resume.ts";
import { loadMergedProgress } from "../../../src/core/progress/io.ts";

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

const BLOCKED_YAML = `events:
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
`;

const STARTED_ONLY = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
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
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-resume-"));
});
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTaskResume", () => {
  it("blocked → resumed succeeds and appends a resumed event", async () => {
    await setup(dir, BLOCKED_YAML);
    const result = await runTaskResume({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.kind).toBe("resumed");
    const { log } = await loadMergedProgress(dir);
    expect(log.events.map((e) => e.status)).toEqual([
      "started",
      "blocked",
      "resumed",
    ]);
  });

  it("started → resumed fails with INVALID_TASK_TRANSITION", async () => {
    await setup(dir, STARTED_ONLY);
    await expect(
      runTaskResume({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("done → resumed fails with INVALID_TASK_TRANSITION", async () => {
    await setup(dir, DONE_YAML);
    await expect(
      runTaskResume({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });

  it("planned → resumed fails with INVALID_TASK_TRANSITION", async () => {
    await setup(dir);
    await expect(
      runTaskResume({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
  });
});
