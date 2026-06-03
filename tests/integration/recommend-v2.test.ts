import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecommend, formatRecommend, type RecommendResult } from "../../src/commands/recommend.ts";
import { RecommendResultV2 } from "../../src/core/schemas/recommend-result.ts";
import { resolveRecommendation } from "../../src/core/recommend/index.ts";
import { AgentProfile } from "../../src/core/schemas/agent-profile.ts";
import { Task } from "../../src/core/schemas/task.ts";
import { cliPath, ensureCliBuilt, repoRoot } from "../helpers/cli.ts";

const fixtureDir = join(repoRoot, "tests", "fixtures", "project-a");

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

describe("recommend v0.8 — back-compat regression guard", () => {
  it("v0.7 fields are byte-identical for P2-E1-T1 fixture", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });

    expect(result.phaseId).toBe("P2");
    expect(result.taskId).toBe("P2-E1-T1");
    expect(result.agentName).toBe("claude-code");
    expect(result.tier).toBe("balanced_coding");
    expect(result.effort).toBe("medium");
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.reasons).toEqual(["default tier for standard feature/refactor/bugfix work"]);
  });
});

describe("recommend v0.8 — new field coverage", () => {
  it("returned shape passes RecommendResultV2 zod validation", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(() => RecommendResultV2.parse(result)).not.toThrow();
  });

  it("balanced_coding task has the full balanced_coding escalation order", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.allowedEscalation).toEqual([
      "increase_context",
      "increase_effort",
      "escalate_tier",
      "ask_human",
    ]);
  });

  it("medium ambiguity task triggers plan_lint + plan_analyze preflight", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.planningRequired).toBe(true);
    expect(result.preflight.map((p) => p.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("contextProfile reflects medium context_size with medium ambiguity", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.contextProfile).toBe("medium");
  });

  it("verificationProfile is a passthrough of verification_strength", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.verificationProfile).toBe("strong");
  });

  it("budgetProfile reflects medium context_size + medium write_surface", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.budgetProfile).toEqual({
      toolCalls: "medium",
      contextFiles: "several",
      verificationCommands: "full",
    });
  });

  it("structuredReasons is non-empty and zod-valid", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(result.structuredReasons.length).toBeGreaterThanOrEqual(1);
    for (const r of result.structuredReasons) {
      expect(typeof r.factor).toBe("string");
      expect(typeof r.value).toBe("string");
      expect(typeof r.effect).toBe("string");
    }
  });
});

describe("recommend v0.8 — different tiers produce different envelopes", () => {
  it("architecture task (P1-T1) → highest_reasoning + preflight fires", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
    });
    expect(result.tier).toBe("highest_reasoning");
    expect(result.planningRequired).toBe(true);
    expect(result.allowedEscalation).toEqual(["increase_context", "ask_human"]);
    expect(result.preflight.map((p) => p.id)).toEqual(["plan_lint", "plan_analyze"]);
  });

  it("in_progress task (P1-T2) triggers task_status preflight in addition to planning", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T2",
      agentName: "claude-code",
    });
    expect(result.preflight.map((p) => p.id)).toEqual([
      "plan_lint",
      "plan_analyze",
      "task_status",
    ]);
    const taskStatus = result.preflight.find((p) => p.id === "task_status");
    expect(taskStatus?.argv).toEqual(["task", "status", "P1-T2", "--json"]);
    expect(taskStatus?.displayCommand).toBe("code-pact task status P1-T2 --json");
  });
});

describe("recommend v0.8 — human formatter", () => {
  it("renders the 5-line v0.7 summary at the top", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Task:    P2 / P2-E1-T1");
    expect(out).toContain("Agent:   claude-code");
    expect(out).toContain("Tier:    balanced_coding");
    expect(out).toContain("Model:   claude-sonnet-4-6");
    expect(out).toContain("Effort:  medium");
  });

  it("includes Reasons section with bullets", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Reasons:");
    expect(out).toContain("  - default tier for standard feature/refactor/bugfix work");
  });

  it("includes Planning section with all four fields", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Planning:");
    expect(out).toContain("Required:");
    expect(out).toContain("Ambiguity action:");
    expect(out).toContain("Context profile:");
    expect(out).toContain("Verification:");
  });

  it("includes lifecycleMode on the result and a Lifecycle line in human output", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(["full_loop", "record_only", "decision_loop"]).toContain(
      result.lifecycleMode,
    );
    expect(formatRecommend(result)).toContain("Lifecycle:");
  });

  it("includes numbered Escalation section", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Escalation:");
    expect(out).toContain("  1. increase_context");
    expect(out).toContain("  2. increase_effort");
  });

  it("renders Preflight: (none) when preflight array is empty", () => {
    // Pure formatter test — feed a stub result so we do not depend on any
    // fixture having a totally calm task (and so we do not depend on the
    // local repo's gitignored agent profile, which CI does not have).
    const stub: RecommendResult = {
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
      tier: "balanced_coding",
      effort: "medium",
      modelId: "claude-sonnet-4-6",
      reasons: ["stub reason"],
      contextProfile: "small",
      verificationProfile: "strong",
      planningRequired: false,
      ambiguityAction: "proceed",
      allowedEscalation: ["increase_context", "ask_human"],
      preflight: [],
      budgetProfile: { toolCalls: "low", contextFiles: "few", verificationCommands: "full" },
      structuredReasons: [{ factor: "stub", value: "stub", effect: "stub" }],
      lifecycleMode: "full_loop",
    };
    const out = formatRecommend(stub);
    expect(out).toContain("Preflight: (none)");
  });

  it("renders Preflight entries with displayCommand + reason when triggers fire", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Preflight:");
    expect(out).toContain("- code-pact plan lint --json");
    expect(out).toContain("(reason: planning_required)");
  });

  it("includes Budget section with all three categorical fields", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Budget:");
    expect(out).toContain("Tool calls:");
    expect(out).toContain("Context files:");
    expect(out).toContain("Verification commands:");
  });
});

describe("recommend — P48 contextFit (additive)", () => {
  it("runRecommend surfaces a contextFit for the P2-E1-T1 fixture (medium -> balanced, built-in fallback)", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    // context_size=medium, ambiguity=medium, write_surface=medium -> balanced.
    expect(result.contextFit).toBeDefined();
    expect(result.contextFit?.recommendedProfile).toBe("balanced");
    expect(result.contextFit?.recommendedBudgetBytes).toBe(60000);
    expect(result.contextFit?.reason).toContain("built-in fallback");
  });

  it("contextFit is distinct from the categorical budgetProfile (no overload)", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    // budgetProfile stays categorical and unchanged; contextFit is a separate,
    // byte-valued recommendation.
    expect(result.budgetProfile).toEqual({
      toolCalls: "medium",
      contextFiles: "several",
      verificationCommands: "full",
    });
    expect(result.contextFit?.recommendedBudgetBytes).toBe(60000);
  });

  it("the human formatter includes one clear, suggestion-worded context fit line", async () => {
    const result = await runRecommend({
      cwd: fixtureDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const out = formatRecommend(result);
    expect(out).toContain("Context fit:");
    expect(out).toContain("recommended context budget balanced");
    expect(out).toContain("(60000 bytes)");
    // Must NOT imply automatic application.
    expect(out).not.toContain("Using context budget");
    expect(out).not.toContain("Applying");
  });

  it("--json carries contextFit through the CLI envelope (subprocess)", () => {
    const res = spawnSync(
      process.execPath,
      [cliPath, "recommend", "--phase", "P2", "--task", "P2-E1-T1", "--json"],
      { cwd: fixtureDir, encoding: "utf8", env: process.env },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.data.contextFit).toBeDefined();
    expect(parsed.data.contextFit.recommendedProfile).toBe("balanced");
    expect(parsed.data.contextFit.recommendedBudgetBytes).toBe(60000);
  });

  it("a selected agent profile same-name override changes recommendedBudgetBytes", () => {
    // Exercise the real resolver with an agent profile that overrides the
    // 'balanced' bytes; no shared fixture is mutated.
    const agentProfile = AgentProfile.parse({
      name: "claude-code",
      instruction_filename: "CLAUDE.md",
      context_dir: ".context/claude",
      skill_dir: ".claude/skills",
      hook_dir: ".claude/hooks",
      model_map: {
        highest_reasoning: "claude-opus-4-7",
        balanced_coding: "claude-sonnet-4-6",
        cheap_mechanical: "claude-haiku-4-5",
      },
      context_budget: { profiles: { balanced: { max_bytes: 65536 } } },
    });
    const task = Task.parse({
      id: "P9-T1",
      type: "feature",
      ambiguity: "medium",
      risk: "medium",
      context_size: "medium",
      write_surface: "medium",
      verification_strength: "medium",
      expected_duration: "short",
      status: "planned",
    });
    const overridden = resolveRecommendation({
      phaseId: "P9",
      taskId: "P9-T1",
      task,
      agentName: "claude-code",
      agentProfile,
    });
    expect(overridden.contextFit?.recommendedProfile).toBe("balanced");
    expect(overridden.contextFit?.recommendedBudgetBytes).toBe(65536);
    expect(overridden.contextFit?.reason).toContain("agent profile override");

    // Same task with NO override -> built-in fallback bytes.
    const noOverride = resolveRecommendation({
      phaseId: "P9",
      taskId: "P9-T1",
      task,
      agentName: "claude-code",
      agentProfile: AgentProfile.parse({
        name: "claude-code",
        instruction_filename: "CLAUDE.md",
        context_dir: ".context/claude",
        skill_dir: ".claude/skills",
        hook_dir: ".claude/hooks",
        model_map: {
          highest_reasoning: "claude-opus-4-7",
          balanced_coding: "claude-sonnet-4-6",
          cheap_mechanical: "claude-haiku-4-5",
        },
      }),
    });
    expect(noOverride.contextFit?.recommendedBudgetBytes).toBe(60000);
  });
});

describe("recommend v0.8 — CLI envelope (subprocess)", () => {
  it("--json wraps the v0.8 result in {ok:true, data:...} envelope", () => {
    const res = spawnSync(
      process.execPath,
      [cliPath, "recommend", "--phase", "P2", "--task", "P2-E1-T1", "--json"],
      { cwd: fixtureDir, encoding: "utf8", env: process.env },
    );
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(parsed.data.phaseId).toBe("P2");
    expect(parsed.data.taskId).toBe("P2-E1-T1");
    // v0.8 fields propagate through the envelope verbatim
    expect(parsed.data.planningRequired).toBe(true);
    expect(parsed.data.contextProfile).toBe("medium");
    expect(parsed.data.budgetProfile).toBeDefined();
    expect(Array.isArray(parsed.data.preflight)).toBe(true);
    // schema-validate the envelope payload
    expect(() => RecommendResultV2.parse(parsed.data)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// P48 — a malformed agent profile (especially an invalid P47 `context_budget`
// block, which `recommend` now reads to resolve the contextFit byte override)
// must surface as a clean CONFIG_ERROR envelope with exit 2, NOT a raw Zod/YAML
// throw printed as "internal error" with exit 0. This matches task prepare.
// ---------------------------------------------------------------------------

describe("recommend — malformed agent profile is CONFIG_ERROR (P48)", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function tmpProjectWithProfile(profileYaml: string): string {
    tmp = mkdtempSync(join(tmpdir(), "code-pact-recommend-cfgerr-"));
    cpSync(fixtureDir, tmp, { recursive: true });
    writeFileSync(
      join(tmp, ".code-pact", "agent-profiles", "claude-code.yaml"),
      profileYaml,
      "utf8",
    );
    return tmp;
  }

  const VALID_HEAD = `name: claude-code
instruction_filename: CLAUDE.md
context_dir: .context/claude
skill_dir: .claude/skills
hook_dir: .claude/hooks
model_map:
  highest_reasoning: claude-opus-4-7
  balanced_coding: claude-sonnet-4-6
  cheap_mechanical: claude-haiku-4-5
`;

  it("invalid context_budget (max_bytes: 0) → CONFIG_ERROR, exit 2", () => {
    const dir = tmpProjectWithProfile(
      `${VALID_HEAD}context_budget:\n  profiles:\n    balanced:\n      max_bytes: 0\n`,
    );
    const res = spawnSync(
      process.execPath,
      [cliPath, "recommend", "--phase", "P2", "--task", "P2-E1-T1", "--json"],
      { cwd: dir, encoding: "utf8", env: process.env },
    );
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
    // The raw Zod error must NOT leak as an "internal error" string.
    expect(res.stdout).not.toContain("internal error");
  });

  it("malformed YAML profile → CONFIG_ERROR, exit 2", () => {
    const dir = tmpProjectWithProfile("name: claude-code\n  bad: : indent\n:::\n");
    const res = spawnSync(
      process.execPath,
      [cliPath, "recommend", "--phase", "P2", "--task", "P2-E1-T1", "--json"],
      { cwd: dir, encoding: "utf8", env: process.env },
    );
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("CONFIG_ERROR");
  });

  it("missing agent profile → AGENT_NOT_FOUND, exit 2 (unchanged)", () => {
    const res = spawnSync(
      process.execPath,
      [cliPath, "recommend", "--phase", "P2", "--task", "P2-E1-T1", "--agent", "nonexistent", "--json"],
      { cwd: fixtureDir, encoding: "utf8", env: process.env },
    );
    expect(res.status).toBe(2);
    const parsed = JSON.parse(res.stdout.trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("AGENT_NOT_FOUND");
  });
});
