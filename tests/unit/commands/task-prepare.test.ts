import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { buildContextPack } from "../../../src/core/pack/index.ts";
import { cmdTask } from "../../../src/cli/commands/task.ts";
import {
  __setAtomicTempTokenForTests,
  __setAtomicWriteFailAfterOpenForTests,
} from "../../../src/io/atomic-text.ts";

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

const PHASE_YAML_DEFERRABLE = PHASE_YAML.replace(
  "context_size: small",
  "context_size: large",
);

const BOUNDED_POLICY = {
  mode: "bounded",
  maxRepairAttempts: 1,
  retryableFailureKinds: ["command_failed"],
  nonRetryableFailureKinds: [
    "timed_out",
    "aborted",
    "decision_required",
    "unsafe_write",
    "invalid_state",
    "unknown",
  ],
  retryContext: "failure_delta",
  firstRetry: "same_model_same_effort_same_context",
  stopOnRepeatedFingerprint: true,
  afterExhaustion: "use_allowed_escalation",
} as const;

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
  return readFile(join(dir, ".code-pact", "state", "progress.yaml"), "utf8");
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-prepare-"));
});

afterEach(async () => {
  __setAtomicTempTokenForTests(null);
  __setAtomicWriteFailAfterOpenForTests(null);
  vi.restoreAllMocks();
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
    expect(result.recommendation!.repairPolicy).toEqual(BOUNDED_POLICY);
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
      verify: "code-pact verify --phase P1 --task P1-T1 --json --detail agent",
      complete:
        "code-pact task complete P1-T1 --agent claude-code --json --detail agent",
      finalize: "code-pact task finalize P1-T1 --write --json",
      // P40 — additive, always present; the one non-runnable template.
      "record-done":
        'code-pact task record-done P1-T1 --agent claude-code --evidence "<verification you ran>"',
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
    expect(rec.repairPolicy).toEqual({
      mode: "disabled",
      reasonCode: "weak_verification",
    });
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

// ---------------------------------------------------------------------------
// P48 — Context Fit recommendation (layer b). `task prepare` surfaces
// recommendation.contextFit through the shared resolveRecommendation path. It
// is a SUGGESTION only: no auto-apply, no extra reads, the commands dictionary
// is unchanged, and the context pack bytes are unchanged without an explicit
// --context-budget.
// ---------------------------------------------------------------------------

describe("runTaskPrepare — P48 contextFit", () => {
  it("surfaces recommendation.contextFit on a planned task (small -> tight, built-in fallback)", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.recommendation).not.toBeNull();
    const cf = result.recommendation!.contextFit;
    expect(result.recommendation!.repairPolicy).toEqual(BOUNDED_POLICY);
    expect(cf).toBeDefined();
    // P1-T1: context_size=small, ambiguity=low, write_surface=low -> tight.
    expect(cf?.recommendedProfile).toBe("tight");
    expect(cf?.recommendedBudgetBytes).toBe(30000);
    expect(cf?.reason).toContain("built-in fallback");
  });

  it("does NOT auto-apply the recommended budget — pack bytes match a no-flag prepare", async () => {
    await setupProject(dir);
    const a = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    const b = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    // contextFit recommends 'tight' (30000), but no budget is applied: the pack
    // is built with no budgetBytes, so its size is stable and unreduced.
    expect(a.context_pack_bytes).toBeGreaterThan(0);
    expect(b.context_pack_bytes).toBe(a.context_pack_bytes);
    expect(a.recommendation!.contextFit?.recommendedProfile).toBe("tight");
  });

  it("the commands dictionary does NOT echo --context-budget", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    for (const cmd of Object.values(result.commands)) {
      expect(cmd).not.toContain("--context-budget");
    }
    expect(result.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
  });

  it("reports source none on the no-budget build path", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.applied_context_budget).toEqual({ source: "none" });
    expect(result.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
  });

  it("applies the same recommended contextFit when recommended_cli is selected", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      budgetSelection: { kind: "recommended_cli" },
    });
    expect(result.recommendation).not.toBeNull();
    expect(result.applied_context_budget).toEqual({
      source: "recommended_cli",
      profile: result.recommendation!.contextFit!.recommendedProfile,
      budget_bytes: result.recommendation!.contextFit!.recommendedBudgetBytes,
    });
    expect(result.commands.context).toBe(
      `code-pact task context P1-T1 --agent claude-code --budget-bytes ${result.recommendation!.contextFit!.recommendedBudgetBytes}`,
    );
  });

  it("keeps --context-budget auto as an explicit custom profile, not recommended mode", async () => {
    await setupProject(dir);
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      `${AGENT_PROFILE_YAML}context_budget:\n  profiles:\n    auto:\n      max_bytes: 45000\n`,
      "utf8",
    );
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      budgetSelection: { kind: "explicit_profile", profileName: "auto" },
      dryRun: true,
    });
    expect(result.applied_context_budget).toEqual({
      source: "explicit_profile",
      profile: "auto",
      budget_bytes: 45000,
    });
    expect(result.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code --budget-bytes 45000",
    );
  });

  it("applies recommended_agent_profile when the agent profile opts in", async () => {
    await setupProject(dir);
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      `${AGENT_PROFILE_YAML}context_budget:\n  application_mode: recommended\n`,
      "utf8",
    );
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });
    expect(result.recommendation).not.toBeNull();
    expect(result.applied_context_budget).toEqual({
      source: "recommended_agent_profile",
      profile: result.recommendation!.contextFit!.recommendedProfile,
      budget_bytes: result.recommendation!.contextFit!.recommendedBudgetBytes,
    });
  });

  it("explicit CLI bytes override agent profile recommended mode", async () => {
    await setupProject(dir);
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      `${AGENT_PROFILE_YAML}context_budget:\n  application_mode: recommended\n`,
      "utf8",
    );
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
      budgetSelection: { kind: "explicit_bytes", budgetBytes: 45000 },
    });
    expect(result.applied_context_budget).toEqual({
      source: "explicit_bytes",
      budget_bytes: 45000,
    });
  });

  it("recommended mode uses same-name standard overrides but not custom defaults", async () => {
    await setupProject(dir);
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      `${AGENT_PROFILE_YAML}context_budget:\n  application_mode: recommended\n  default_profile: custom\n  profiles:\n    tight:\n      max_bytes: 28000\n    custom:\n      max_bytes: 90000\n`,
      "utf8",
    );
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
    });
    expect(result.recommendation!.contextFit?.recommendedProfile).toBe("tight");
    expect(result.recommendation!.contextFit?.recommendedBudgetBytes).toBe(
      28000,
    );
    expect(result.applied_context_budget).toEqual({
      source: "recommended_agent_profile",
      profile: "tight",
      budget_bytes: 28000,
    });
  });

  it("early-return done state stays unchanged — null recommendation, no contextFit", async () => {
    const progressWithDone = `events:
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
    expect(result.recommendation).toBeNull();
    expect(result.context_pack_bytes).toBe(0);
    expect(result.applied_context_budget).toBeUndefined();
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

    expect(await fileExists(result.would_write_context_pack_path!)).toBe(false);
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
    expect(result.applied_context_budget).toBeUndefined();
    expect(result.commands.context).toBe(
      "code-pact task context P1-T1 --agent claude-code",
    );
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
    expect(result.applied_context_budget).toBeUndefined();
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
    expect(result.applied_context_budget).toBeUndefined();
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
    expect(result.recommendation!.repairPolicy).toEqual(BOUNDED_POLICY);
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
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation!.repairPolicy).toEqual(BOUNDED_POLICY);
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
  it("normal prepare writes to the validated custom profile context_dir", async () => {
    await setupProject(dir);
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      AGENT_PROFILE_YAML.replace(
        "context_dir: .context/claude-code",
        "context_dir: .context/custom-prepare",
      ),
      "utf8",
    );

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.context_pack_path).toBe(
      join(dir, ".context", "custom-prepare", "P1-T1.md"),
    );
    expect(await fileExists(result.context_pack_path!)).toBe(true);
    expect(
      await fileExists(join(dir, ".context", "claude-code", "P1-T1.md")),
    ).toBe(false);
  });

  it("normal recommended prepare writes to the same custom profile context_dir", async () => {
    await setupProject(dir);
    await writeFile(
      join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
      `${AGENT_PROFILE_YAML.replace(
        "context_dir: .context/claude-code",
        "context_dir: .context/custom-recommended",
      )}context_budget:\n  application_mode: recommended\n`,
      "utf8",
    );

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });

    expect(result.applied_context_budget).toMatchObject({
      source: "recommended_agent_profile",
    });
    expect(result.context_pack_path).toBe(
      join(dir, ".context", "custom-recommended", "P1-T1.md"),
    );
    expect(await fileExists(result.context_pack_path!)).toBe(true);
    expect(
      await fileExists(join(dir, ".context", "claude-code", "P1-T1.md")),
    ).toBe(false);
  });

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
      budgetSelection: {
        kind: "explicit_bytes",
        budgetBytes: baseline.context_pack_bytes + 10000,
      },
    });
    expect(result.context_pack_bytes).toBe(baseline.context_pack_bytes);
    expect(result.applied_context_budget).toEqual({
      source: "explicit_bytes",
      budget_bytes: baseline.context_pack_bytes + 10000,
    });
    expect(result.commands.context).toBe(
      `code-pact task context P1-T1 --agent claude-code --budget-bytes ${baseline.context_pack_bytes + 10000}`,
    );
  });

  it("throws CONTEXT_OVER_BUDGET when budget is unachievable", async () => {
    await setupProject(dir);
    await expect(
      runTaskPrepare({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        budgetSelection: { kind: "explicit_bytes", budgetBytes: 1 },
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
        budgetSelection: { kind: "explicit_bytes", budgetBytes: 1 },
      });
    } catch (err) {
      threw = true;
      expect((err as { code?: string }).code).toBe("CONTEXT_OVER_BUDGET");
    }
    expect(threw).toBe(true);

    const after = await readProgress(dir);
    expect(after).toBe(before);
  });

  it("normal prepare persists deferred context before writing the context pack", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_DEFERRABLE });
    await writeFile(
      join(dir, "design", "constitution.md"),
      `# Constitution\n${"contract text\n".repeat(400)}`,
      "utf8",
    );
    const baseline = await buildContextPack({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      budgetSelection: {
        kind: "explicit_bytes",
        budgetBytes: baseline.totalBytes - 1000,
      },
    });

    expect(result.deferred_context).toMatchObject({
      persisted: true,
      retrieve_command: expect.stringContaining("code-pact context show"),
    });
    const ref = result.deferred_context!.manifest_ref;
    const digest = ref.replace("context:sha256:", "");
    const artifactPath = join(
      dir,
      ".code-pact",
      "cache",
      "context",
      `${digest}.json`,
    );
    expect(await fileExists(artifactPath)).toBe(true);
    expect(await fileExists(result.context_pack_path!)).toBe(true);
    const packContent = await readFile(result.context_pack_path!, "utf8");
    expect(packContent).toContain("## Deferred Context");
    expect(packContent).toContain(ref);
  });

  it("dry-run prepare computes deferred metadata without writing cache or pack", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_DEFERRABLE });
    await writeFile(
      join(dir, "design", "constitution.md"),
      `# Constitution\n${"contract text\n".repeat(400)}`,
      "utf8",
    );
    const baseline = await buildContextPack({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });

    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      dryRun: true,
      budgetSelection: {
        kind: "explicit_bytes",
        budgetBytes: baseline.totalBytes - 1000,
      },
    });

    expect(result.deferred_context).toMatchObject({
      persisted: false,
      retrieve_command: null,
    });
    expect(result.context_pack_path).toBeNull();
    expect(await fileExists(result.would_write_context_pack_path!)).toBe(false);
    expect(await fileExists(join(dir, ".code-pact", "cache", "context"))).toBe(
      false,
    );
  });

  it("maps deferred artifact write failure to a public context error", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_DEFERRABLE });
    await writeFile(
      join(dir, "design", "constitution.md"),
      `# Constitution\n${"contract text\n".repeat(400)}`,
      "utf8",
    );
    const baseline = await buildContextPack({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });
    const writeError = new Error("disk full");
    (writeError as NodeJS.ErrnoException).code = "ENOSPC";
    __setAtomicWriteFailAfterOpenForTests(() => writeError);

    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      },
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      },
    );
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const exit = await cmdTask(
        [
          "prepare",
          "P1-T1",
          "--agent",
          "claude-code",
          "--budget-bytes",
          String(baseline.totalBytes - 1000),
          "--json",
        ],
        "en-US",
        false,
      );
      expect(exit).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout) as {
      ok: false;
      error: { code: string };
      data: { system_code: string };
    };
    expect(stderr).toBe("");
    expect(parsed.error.code).toBe("CONTEXT_WRITE_FAILED");
    expect(parsed.data.system_code).toBe("ENOSPC");
    expect(
      await fileExists(join(dir, ".context", "claude-code", "P1-T1.md")),
    ).toBe(false);
  });

  it("maps deferred artifact readback disappearance to CONTEXT_NOT_FOUND", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_DEFERRABLE });
    await writeFile(
      join(dir, "design", "constitution.md"),
      `# Constitution\n${"contract text\n".repeat(400)}`,
      "utf8",
    );
    const baseline = await buildContextPack({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });
    const budgetBytes = baseline.totalBytes - 1000;
    const budgeted = await buildContextPack({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
      budgetBytes,
    });
    const digest = budgeted.pendingContextManifest!.digest;
    const contextDir = join(dir, ".code-pact", "cache", "context");
    const token = "context-readback-missing";
    await mkdir(contextDir, { recursive: true });
    const tempPath = join(contextDir, `${digest}.json.tmp-${token}`);
    await writeFile(tempPath, "pre-existing temp", "utf8");
    __setAtomicTempTokenForTests(() => token);
    const beforeProgress = await readProgress(dir);

    let stdout = "";
    let stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      },
    );
    vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      },
    );
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const exit = await cmdTask(
        [
          "prepare",
          "P1-T1",
          "--agent",
          "claude-code",
          "--budget-bytes",
          String(budgetBytes),
          "--json",
        ],
        "en-US",
        false,
      );
      expect(exit).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = JSON.parse(stdout) as {
      ok: false;
      error: { code: string };
      data?: { system_code?: string };
    };
    expect(stderr).toBe("");
    expect(parsed.error.code).toBe("CONTEXT_NOT_FOUND");
    expect(parsed.error.code).not.toBe("INTERNAL_ERROR");
    expect(parsed.data?.system_code).toBe("ENOENT");
    expect(await readProgress(dir)).toBe(beforeProgress);
    expect(
      await fileExists(join(dir, ".context", "claude-code", "P1-T1.md")),
    ).toBe(false);
    expect(await fileExists(join(contextDir, `${digest}.json`))).toBe(false);
    expect(await fileExists(tempPath)).toBe(true);
  });
});

describe("runTaskPrepare — lifecycle-aware next_action + record-done (P40)", () => {
  // A single-task phase whose one task drives a given lifecycleMode.
  // full_loop: type feature; record_only: type docs + low/low/strong;
  // decision_loop: requires_decision (extra task line).
  function phaseYaml(
    opts: { type?: string; extraTaskLines?: string[] } = {},
  ): string {
    const type = opts.type ?? "feature";
    const extra = (opts.extraTaskLines ?? []).map(l => `    ${l}`).join("\n");
    return `id: P1
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
    type: ${type}
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: strong
    expected_duration: short
    status: planned
${extra}
`;
  }

  it("full_loop: message keeps the complete wording; record-done present", async () => {
    await setupProject(dir, { phaseYaml: phaseYaml() });
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.recommendation?.lifecycleMode).toBe("full_loop");
    expect(result.recommendation?.repairPolicy).toEqual(BOUNDED_POLICY);
    expect(result.next_action.message).toContain("complete");
    expect(result.commands["record-done"]).toContain("task record-done");
    expect(result.commands["record-done"]).toContain("--evidence");
  });

  it("record_only: message points at task record-done, not task complete", async () => {
    // type: docs + low/low/strong → record_only per the deterministic switch.
    await setupProject(dir, { phaseYaml: phaseYaml({ type: "docs" }) });
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.recommendation?.lifecycleMode).toBe("record_only");
    expect(result.recommendation?.repairPolicy).toEqual({
      mode: "disabled",
      reasonCode: "record_only",
    });
    expect(result.next_action.message).toContain("task record-done --evidence");
    expect(result.next_action.message).toContain("not lighter verification");
    expect(result.next_action.message).not.toContain("complete the task");
    expect(result.commands["record-done"]).toContain("task record-done");
  });

  it("decision_loop: message says resolve the ADR first; does not decide complete-vs-record-done", async () => {
    await setupProject(dir, {
      phaseYaml: phaseYaml({ extraTaskLines: ["requires_decision: true"] }),
    });
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(result.recommendation?.lifecycleMode).toBe("decision_loop");
    expect(result.recommendation?.repairPolicy).toEqual({
      mode: "disabled",
      reasonCode: "decision_loop",
    });
    expect(result.next_action.message).toContain(
      "Resolve/accept the gating ADR first",
    );
    expect(result.next_action.message).not.toContain("task record-done");
    expect(result.next_action.message).not.toContain("complete the task");
    expect(result.commands["record-done"]).toContain("task record-done");
  });

  it("record-done is present in every mode (the lookup table stays complete)", async () => {
    const cases = [
      phaseYaml(),
      phaseYaml({ extraTaskLines: ["requires_decision: true"] }),
    ];
    for (const py of cases) {
      await setupProject(dir, { phaseYaml: py });
      const result = await runTaskPrepare({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
      });
      expect(result.commands["record-done"]).toContain("task record-done");
      expect(result.commands.complete).toContain("task complete");
      expect(result.commands.finalize).toContain("task finalize");
    }
  });
});

describe("runTaskPrepare — minimal detail contract", () => {
  it("minimal envelope omits recommendation and supplies actionable state/scope/retrieval", async () => {
    await setupProject(dir);
    const result = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      detail: "minimal",
    });
    expect(result.minimal).toBeDefined();
    const m = result.minimal!;
    expect(m.detail).toBe("minimal");
    expect(m.task_id).toBe("P1-T1");
    expect(m.phase_id).toBe("P1");
    expect(m.current_state).toBe("planned");
    expect(m.next_action.type).toBe("start_task");
    expect(m.commands.start).toContain("task start P1-T1");
    expect(m.state.requires_decision).toBe(false);
    expect(m.retrieval.context.command).toContain("task context P1-T1");
    expect(m.retrieval.runbook.command).toContain("task runbook P1-T1");
    expect(m.retrieval.memory.command).toContain("memory status");
    expect(m.retrieval.full_detail.command).toContain("--detail full");
  });

  it("minimal context pack drops heavy sections and adds a retrieval section", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_DEFERRABLE });
    await writeFile(
      join(dir, "design", "constitution.md"),
      "project constitution text\n".repeat(100),
      "utf8",
    );

    const full = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      detail: "full",
    });
    const minimal = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      detail: "minimal",
    });

    expect(minimal.context_pack_bytes).toBeGreaterThan(0);
    expect(minimal.context_pack_bytes).toBeLessThan(full.context_pack_bytes);

    const minimalPack = await readFile(minimal.context_pack_path!, "utf8");
    expect(minimalPack).toContain("## Retrieval");
    expect(minimalPack).not.toContain("## Project Constitution");
    expect(minimalPack).not.toContain("## Rules");
  });

  it("deterministic: repeated minimal runs produce the same context pack bytes", async () => {
    await setupProject(dir);
    const a = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      detail: "minimal",
    });
    const b = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      detail: "minimal",
    });
    expect(a.context_pack_bytes).toBe(b.context_pack_bytes);
    expect(a.minimal?.context_pack_bytes).toBe(b.minimal?.context_pack_bytes);
  });
});

describe("cmdTask prepare — default minimal vs full", () => {
  it("cmd task prepare --json emits the minimal envelope by default", async () => {
    await setupProject(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    let stdout = "";
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      });
    try {
      const exit = await cmdTask(
        ["prepare", "P1-T1", "--json"],
        "en-US",
        false,
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(stdout) as {
        ok: boolean;
        data: { detail: string };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.detail).toBe("minimal");
    } finally {
      spy.mockRestore();
      process.chdir(originalCwd);
    }
  });

  it("cmd task prepare --detail full --json returns the full recommendation", async () => {
    await setupProject(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    let stdout = "";
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      });
    try {
      const exit = await cmdTask(
        ["prepare", "P1-T1", "--detail", "full", "--json"],
        "en-US",
        false,
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(stdout) as {
        ok: boolean;
        data: { detail?: string; recommendation: unknown };
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.data.detail).toBeUndefined();
      expect(parsed.data.recommendation).toBeDefined();
    } finally {
      spy.mockRestore();
      process.chdir(originalCwd);
    }
  });
});
