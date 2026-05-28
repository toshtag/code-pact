import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskPrepare } from "../../../src/commands/task-prepare.ts";

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
  - name: codex
    profile: agent-profiles/codex.yaml
    enabled: false
`;

const AGENT_PROFILE_YAML = `name: claude-code
instruction_filename: CLAUDE.md
context_dir: .context/claude-code
model_map:
  highest_reasoning: claude-opus-4-7
  balanced_coding: claude-sonnet-4-6
  cheap_mechanical: claude-haiku-4-5
`;

const PHASE_YAML = `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
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
    verification_strength: strong
    expected_duration: short
    status: planned
  - id: P1-T2
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: strong
    expected_duration: short
    status: planned
    depends_on:
      - P1-T1
`;

async function setupProject(
  dir: string,
  opts: { progressYaml?: string; phaseYaml?: string } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, ".code-pact", "agent-profiles"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    PROJECT_YAML,
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
    AGENT_PROFILE_YAML,
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? "events: []\n",
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    opts.phaseYaml ?? PHASE_YAML,
    "utf8",
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readProgress(dir: string): Promise<string> {
  return readFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    "utf8",
  );
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-prepare-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("runTaskPrepare — planned state", () => {
  it("returns start_task next_action and writes the context pack", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("planned");
    expect(result.next_action.type).toBe("start_task");
    expect(result.recommendation).not.toBeNull();
    expect(result.context_pack_path).not.toBeNull();
    expect(result.context_pack_bytes).toBeGreaterThan(0);
    expect(result.dry_run).toBe(false);
    expect(result.blocked_by).toEqual([]);
    expect(result.would_write_context_pack_path).toBeUndefined();

    // Context pack actually written.
    expect(await fileExists(result.context_pack_path!)).toBe(true);
  });

  it("emits a fully-populated commands dictionary", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.commands).toEqual({
      context: "code-pact task context P1-T1 --agent claude-code",
      start: "code-pact task start P1-T1 --agent claude-code",
      verify: "code-pact verify --phase P1 --task P1-T1",
      complete: "code-pact task complete P1-T1 --agent claude-code",
      finalize: "code-pact task finalize P1-T1 --write --json",
    });
  });
});

// ---------------------------------------------------------------------------
// Recommendation observability (regression) — locks the v1.20 cost fixes so
// `task prepare` callers can trust tier selection without a second
// `recommend` call. The recommend unit tests cover the tier logic itself;
// these assert it survives the prepare round-trip.
// ---------------------------------------------------------------------------

const PHASE_YAML_RECO = `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
objective: test phase
definition_of_done:
  - tests pass
verification:
  commands:
    - echo ok
tasks:
  - id: P1-DOCS
    type: docs
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: planned
  - id: P1-WEAK
    type: feature
    ambiguity: low
    risk: low
    context_size: medium
    write_surface: medium
    verification_strength: weak
    expected_duration: medium
    status: planned
`;

describe("runTaskPrepare — recommendation observability (regression)", () => {
  it("planned task carries a non-null recommendation with tier/effort/modelId present", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_RECO });
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-DOCS",
      agent: "claude-code",
    });
    expect(result.recommendation).not.toBeNull();
    const rec = result.recommendation!;
    expect(typeof rec.tier).toBe("string");
    expect(typeof rec.effort).toBe("string");
    expect(typeof rec.modelId).toBe("string");
    expect(rec.modelId.length).toBeGreaterThan(0);
  });

  it("a small/low-risk docs task resolves to cheap_mechanical (haiku) even with weak verification", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_RECO });
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-DOCS",
      agent: "claude-code",
    });
    const rec = result.recommendation!;
    expect(rec.tier).toBe("cheap_mechanical");
    expect(rec.modelId).toBe("claude-haiku-4-5");
  });

  it("weak verification alone does NOT escalate a balanced task to highest_reasoning", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_RECO });
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-WEAK",
      agent: "claude-code",
    });
    const rec = result.recommendation!;
    expect(rec.tier).not.toBe("highest_reasoning");
    expect(rec.tier).toBe("balanced_coding");
  });
});

describe("runTaskPrepare — progress-read-only invariant", () => {
  it("does not mutate progress.yaml on any path", async () => {
    await setupProject(dir);
    const before = await readProgress(dir);

    await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" });

    const after = await readProgress(dir);
    expect(after).toBe(before);
  });

  it("does not mutate progress.yaml even in dry-run mode", async () => {
    await setupProject(dir);
    const before = await readProgress(dir);

    await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });

    const after = await readProgress(dir);
    expect(after).toBe(before);
  });
});

describe("runTaskPrepare — dry-run", () => {
  it("does not write the context pack and returns would_write_context_pack_path", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.context_pack_path).toBeNull();
    expect(result.would_write_context_pack_path).toBeDefined();
    expect(result.context_pack_bytes).toBeGreaterThan(0);

    expect(
      await fileExists(result.would_write_context_pack_path!),
    ).toBe(false);
  });
});

describe("runTaskPrepare — done state early return", () => {
  it("returns noop_already_done without writing the context pack", async () => {
    const progressWithDone = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: done
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: progressWithDone });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("done");
    expect(result.next_action.type).toBe("noop_already_done");
    expect(result.already_done).toBe(true);
    expect(result.recommendation).toBeNull();
    expect(result.context_pack_path).toBeNull();
    expect(result.context_pack_bytes).toBe(0);
    expect(result.blocked_by).toEqual([]);
  });
});

describe("runTaskPrepare — blocked state early return", () => {
  it("returns wait_for_dependencies on blocked task without writing the pack", async () => {
    const progressWithBlocked = `events:
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
    reason: waiting on external dependency
`;
    await setupProject(dir, { progressYaml: progressWithBlocked });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("blocked");
    expect(result.next_action.type).toBe("wait_for_dependencies");
    expect(result.recommendation).toBeNull();
    expect(result.context_pack_path).toBeNull();
    expect(result.context_pack_bytes).toBe(0);
  });
});

describe("runTaskPrepare — unmet dependencies", () => {
  it("returns wait_for_dependencies with blocked_by populated when a dep is not done", async () => {
    await setupProject(dir);

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T2",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("planned");
    expect(result.next_action.type).toBe("wait_for_dependencies");
    expect(result.blocked_by).toEqual(["P1-T1"]);
    expect(result.recommendation).toBeNull();
    expect(result.context_pack_path).toBeNull();
    expect(result.context_pack_bytes).toBe(0);
  });

  it("proceeds to start_task when all deps are done", async () => {
    const progressWithDoneDep = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: done
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: progressWithDoneDep });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T2",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("planned");
    expect(result.next_action.type).toBe("start_task");
    expect(result.blocked_by).toEqual([]);
    expect(result.context_pack_path).not.toBeNull();
  });
});

describe("runTaskPrepare — started / resumed states", () => {
  it("returns continue_implementation from started state", async () => {
    const progressWithStarted = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: progressWithStarted });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("started");
    expect(result.next_action.type).toBe("continue_implementation");
    expect(result.recommendation).not.toBeNull();
    expect(result.context_pack_path).not.toBeNull();
  });
});

describe("runTaskPrepare — failed state", () => {
  it("returns investigate_failure from failed state", async () => {
    const progressWithFailed = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: failed
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
    reason: verify failed
`;
    await setupProject(dir, { progressYaml: progressWithFailed });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.current_state).toBe("failed");
    expect(result.next_action.type).toBe("investigate_failure");
  });
});

describe("runTaskPrepare — agent validation", () => {
  it("throws AGENT_NOT_FOUND for an unknown agent", async () => {
    await setupProject(dir);
    await expect(
      runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "nonexistent" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("throws AGENT_NOT_ENABLED for a disabled agent", async () => {
    await setupProject(dir);
    await expect(
      runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "codex" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ENABLED" });
  });

  it("uses default_agent when --agent is omitted", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({ cwd: dir, taskId: "P1-T1" });
    expect(result.agent).toBe("claude-code");
  });
});

describe("runTaskPrepare — task resolution errors", () => {
  it("throws TASK_NOT_FOUND for an unknown task", async () => {
    await setupProject(dir);
    await expect(
      runTaskPrepare({ cwd: dir, taskId: "P9-T99", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("runTaskPrepare — budget enforcement (P24)", () => {
  it("respects --budget-bytes and returns post-elision context_pack_bytes", async () => {
    await setupProject(dir);
    const baseline = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });
    // P1-T1 in this fixture has small context_size with no elidable
    // sections (no rules loaded because of small). So the only path is
    // either generous budget (unchanged) or CONTEXT_OVER_BUDGET.
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
      budgetBytes: baseline.context_pack_bytes + 10000,
    });
    expect(result.context_pack_bytes).toBe(baseline.context_pack_bytes);
  });

  it("throws CONTEXT_OVER_BUDGET when budget is unachievable", async () => {
    await setupProject(dir);
    await expect(
      runTaskPrepare({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        budgetBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_OVER_BUDGET" });
  });

  it("preserves progress-read-only invariant on the CONTEXT_OVER_BUDGET failure path", async () => {
    await setupProject(dir);
    const before = await readProgress(dir);

    let threw = false;
    try {
      await runTaskPrepare({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        budgetBytes: 1,
      });
    } catch (err) {
      threw = true;
      expect((err as { code?: string }).code).toBe("CONTEXT_OVER_BUDGET");
    }
    expect(threw).toBe(true);

    const after = await readProgress(dir);
    expect(after).toBe(before);
  });
});
