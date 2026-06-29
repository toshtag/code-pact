import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CONTEXT_FIT_ADVISORY_THRESHOLDS,
  detectContextFitAdvisories,
} from "../../../../src/core/context-fit/advisories.ts";
import { buildContextPack } from "../../../../src/core/pack/index.ts";
import { collectPlanArtifacts } from "../../../../src/core/plan/state.ts";
import type { PlanIssue } from "../../../../src/core/plan/shared.ts";

let cwd: string;
const execFileAsync = promisify(execFile);

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-ctxfit-adv-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/** A single-task phase with overridable readiness fields and optional refs. */
type TaskFields = {
  contextSize?: "small" | "medium" | "large";
  ambiguity?: "low" | "medium" | "high";
  writeSurface?: "low" | "medium" | "high";
  decisionRefs?: string[];
  reads?: string[];
};

async function writePlan(taskId: string, fields: TaskFields): Promise<void> {
  const phaseId = taskId.split("-")[0]!;
  const file = `${phaseId}.yaml`;
  const refs = fields.decisionRefs ?? [];
  const reads = fields.reads ?? [];
  const phaseYaml = `id: ${phaseId}
name: ${phaseId}
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough to read
definition_of_done:
  - A definition of done that is clearly long enough
verification:
  commands:
    - pnpm test
tasks:
  - id: ${taskId}
    type: feature
    ambiguity: ${fields.ambiguity ?? "low"}
    risk: low
    context_size: ${fields.contextSize ?? "small"}
    write_surface: ${fields.writeSurface ?? "low"}
    verification_strength: medium
    expected_duration: short
    status: planned
${refs.length > 0 ? `    decision_refs:\n${refs.map((r) => `      - ${r}`).join("\n")}\n` : ""}${reads.length > 0 ? `    reads:\n${reads.map((r) => `      - ${r}`).join("\n")}\n` : ""}`;
  await writeFile(join(cwd, "design", "phases", file), phaseYaml, "utf8");
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: ${phaseId}\n    path: design/phases/${file}\n    weight: 10\n`,
    "utf8",
  );
}

/** Write a decision ADR file of approximately `bytes` UTF-8 bytes. */
async function writeDecision(name: string, bytes: number): Promise<void> {
  const header = `# ${name}\n\n**Status:** accepted\n\n`;
  const body = "x".repeat(Math.max(0, bytes - Buffer.byteLength(header, "utf8")));
  await writeFile(join(cwd, "design", "decisions", name), header + body, "utf8");
}

async function runAdvisories(
  agentName: string | undefined,
): Promise<PlanIssue[]> {
  const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
  const phases = state?.phases ?? fallbackPhases;
  return detectContextFitAdvisories({ cwd, phases, agentName });
}

async function trackFiles(paths: string[]): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  if (paths.length > 0) await execFileAsync("git", ["add", ...paths], { cwd });
}

function byCode(issues: PlanIssue[], code: string): PlanIssue[] {
  return issues.filter((i) => i.code === code);
}

describe("CONTEXT_FIT_ADVISORY_THRESHOLDS", () => {
  it("pins the documented byte/count contract", () => {
    expect(CONTEXT_FIT_ADVISORY_THRESHOLDS.largeContextBalancedBytes).toBe(60000);
    expect(CONTEXT_FIT_ADVISORY_THRESHOLDS.largeDecisionBytes).toBe(30000);
    expect(CONTEXT_FIT_ADVISORY_THRESHOLDS.readsMatchCount).toBe(100);
  });
});

describe("TASK_DECLARED_DECISION_LARGE", () => {
  // agentName undefined skips the pack-size advisories, isolating this one.
  it("does not fire when the decision body is at or below the threshold", async () => {
    await writeDecision("small.md", 20000);
    await writePlan("P1-T1", { decisionRefs: ["design/decisions/small.md"] });
    const issues = await runAdvisories(undefined);
    expect(byCode(issues, "TASK_DECLARED_DECISION_LARGE")).toHaveLength(0);
  });

  it("fires with a byte payload when the decision body exceeds the threshold", async () => {
    await writeDecision("big.md", 42150);
    await writePlan("P1-T1", { decisionRefs: ["design/decisions/big.md"] });
    const issues = await runAdvisories(undefined);
    const fired = byCode(issues, "TASK_DECLARED_DECISION_LARGE");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.affects_exit).toBe(false);
    expect(fired[0]!.severity).toBe("warning");
    expect(fired[0]!.details).toMatchObject({
      path: "design/decisions/big.md",
      bytes: 42150,
      threshold_bytes: 30000,
    });
  });

  it("does not produce a misleading advisory for a missing or unsafe decision ref", async () => {
    await writePlan("P1-T1", {
      decisionRefs: ["design/decisions/does-not-exist.md"],
    });
    const issues = await runAdvisories(undefined);
    expect(byCode(issues, "TASK_DECLARED_DECISION_LARGE")).toHaveLength(0);
  });
});

describe("TASK_READS_MATCH_TOO_MANY", () => {
  async function writeManyFiles(dir: string, count: number): Promise<void> {
    await mkdir(join(cwd, dir), { recursive: true });
    await Promise.all(
      Array.from({ length: count }, (_unused, i) =>
        writeFile(join(cwd, dir, `f${i}.ts`), "export const x = 1;\n", "utf8"),
      ),
    );
  }

  it("does not fire when the match count is at or below the threshold", async () => {
    await writeManyFiles("src", 100);
    await trackFiles(Array.from({ length: 100 }, (_unused, i) => `src/f${i}.ts`));
    await writePlan("P1-T1", { reads: ["src/**/*.ts"] });
    const issues = await runAdvisories(undefined);
    expect(byCode(issues, "TASK_READS_MATCH_TOO_MANY")).toHaveLength(0);
  });

  it("fires with a count payload when the match count exceeds the threshold", async () => {
    await writeManyFiles("src", 130);
    await trackFiles(Array.from({ length: 130 }, (_unused, i) => `src/f${i}.ts`));
    await writePlan("P1-T1", { reads: ["src/**/*.ts"] });
    const issues = await runAdvisories(undefined);
    const fired = byCode(issues, "TASK_READS_MATCH_TOO_MANY");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.affects_exit).toBe(false);
    expect(fired[0]!.details).toMatchObject({
      glob: "src/**/*.ts",
      match_count: 130,
      threshold_count: 100,
    });
  });
});

describe("TASK_CONTEXT_PACK_LARGE", () => {
  const AGENT = "claude-code";

  it("does not fire when natural bytes are at or below the balanced threshold", async () => {
    await writePlan("P1-T1", {});
    const issues = await runAdvisories(AGENT);
    expect(byCode(issues, "TASK_CONTEXT_PACK_LARGE")).toHaveLength(0);
  });

  it("fires with recommended_profile=wide when natural bytes exceed the balanced threshold", async () => {
    // A ~70KB unelidable declared decision pushes the natural pack over 60000.
    await writeDecision("huge.md", 70000);
    await writePlan("P1-T1", { decisionRefs: ["design/decisions/huge.md"] });
    const issues = await runAdvisories(AGENT);
    const fired = byCode(issues, "TASK_CONTEXT_PACK_LARGE");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.affects_exit).toBe(false);
    expect(fired[0]!.details!.threshold_bytes).toBe(60000);
    expect(fired[0]!.details!.recommended_profile).toBe("wide");
    expect(fired[0]!.details!.natural_bytes as number).toBeGreaterThan(60000);
  });
});

describe("TASK_CONTEXT_BUDGET_UNACHIEVABLE", () => {
  const AGENT = "claude-code";

  it("does not fire when the recommended budget is achievable", async () => {
    await writePlan("P1-T1", {});
    const issues = await runAdvisories(AGENT);
    expect(byCode(issues, "TASK_CONTEXT_BUDGET_UNACHIEVABLE")).toHaveLength(0);
  });

  it("fires when the minimum achievable floor exceeds the recommended budget", async () => {
    // context_size small → recommended profile tight (30000). A ~70KB
    // unelidable declared decision drives the floor above it.
    await writeDecision("huge.md", 70000);
    await writePlan("P1-T1", {
      contextSize: "small",
      decisionRefs: ["design/decisions/huge.md"],
    });
    const issues = await runAdvisories(AGENT);
    const fired = byCode(issues, "TASK_CONTEXT_BUDGET_UNACHIEVABLE");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.affects_exit).toBe(false);
    expect(fired[0]!.details).toMatchObject({
      profile: "tight",
      budget_bytes: 30000,
    });
    expect(fired[0]!.details!.minimum_achievable_bytes as number).toBeGreaterThan(30000);
  });

  it("honors a P48 same-name agent override so it judges against the recommended byte value", async () => {
    // A ~50KB unelidable declared decision: floor sits between the built-in
    // tight fallback (30000) and an 80000 override. With the built-in fallback
    // the advisory fires; with the override it must NOT, matching how
    // `recommend` / `task prepare` would resolve the recommended bytes.
    await writeDecision("mid.md", 50000);
    await writePlan("P1-T1", {
      contextSize: "small",
      decisionRefs: ["design/decisions/mid.md"],
    });

    const { state, fallbackPhases } = await collectPlanArtifacts(cwd);
    const phases = state?.phases ?? fallbackPhases;

    const withFallback = await detectContextFitAdvisories({
      cwd,
      phases,
      agentName: AGENT,
    });
    expect(byCode(withFallback, "TASK_CONTEXT_BUDGET_UNACHIEVABLE")).toHaveLength(1);

    const withOverride = await detectContextFitAdvisories({
      cwd,
      phases,
      agentName: AGENT,
      agentContextBudgetProfiles: { tight: { max_bytes: 80000 } },
    });
    expect(byCode(withOverride, "TASK_CONTEXT_BUDGET_UNACHIEVABLE")).toHaveLength(0);
  });

  it("derives minimum_achievable_bytes from the same shared floor the pack build reports", async () => {
    await writeDecision("huge.md", 70000);
    await writePlan("P1-T1", {
      contextSize: "small",
      decisionRefs: ["design/decisions/huge.md"],
    });
    const issues = await runAdvisories(AGENT);
    const fired = byCode(issues, "TASK_CONTEXT_BUDGET_UNACHIEVABLE")[0]!;

    const pack = await buildContextPack({
      cwd,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: AGENT,
      explain: true,
    });
    expect(fired.details!.minimum_achievable_bytes).toBe(
      pack.explainMetrics!.minimumAchievableBytes,
    );
  });
});

describe("agent-less resolution", () => {
  it("skips the pack-size advisories when no agent name is available", async () => {
    await writeDecision("huge.md", 70000);
    await writePlan("P1-T1", { decisionRefs: ["design/decisions/huge.md"] });
    const issues = await runAdvisories(undefined);
    // The file-based decision advisory still fires; pack-size ones do not.
    expect(byCode(issues, "TASK_DECLARED_DECISION_LARGE")).toHaveLength(1);
    expect(byCode(issues, "TASK_CONTEXT_PACK_LARGE")).toHaveLength(0);
    expect(byCode(issues, "TASK_CONTEXT_BUDGET_UNACHIEVABLE")).toHaveLength(0);
  });
});
