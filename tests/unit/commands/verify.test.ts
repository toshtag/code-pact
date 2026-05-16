import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runVerify } from "../../../src/commands/verify.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers — build a minimal tmpdir project for mutation tests
// ---------------------------------------------------------------------------

const PHASE_YAML = (taskStatus: string, requiresDecision = false) =>
  [
    "id: P1",
    "name: Foundation",
    "weight: 12",
    "confidence: high",
    "risk: low",
    `status: ${taskStatus === "done" ? "done" : "in_progress"}`,
    "objective: Establish foundation.",
    "definition_of_done:",
    "  - CI passes",
    "verification:",
    "  commands:",
    "    - echo ok",
    requiresDecision ? "requires_decision: true" : "",
    "tasks:",
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: weak",
    "    expected_duration: short",
    `    status: ${taskStatus}`,
  ]
    .filter(Boolean)
    .join("\n");

const ROADMAP_YAML = `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 12\n`;

async function setupProject(
  dir: string,
  opts: {
    taskStatus?: string;
    hasDoneEvent?: boolean;
    hasAdr?: boolean;
    requiresDecision?: boolean;
  } = {},
): Promise<void> {
  const {
    taskStatus = "done",
    hasDoneEvent = true,
    hasAdr = false,
    requiresDecision = false,
  } = opts;

  await mkdir(join(dir, ".code-pact", "state", "baselines"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await mkdir(join(dir, "design", "decisions"), { recursive: true });

  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    PHASE_YAML(taskStatus, requiresDecision),
    "utf8",
  );

  const events = hasDoneEvent
    ? `events:\n  - task_id: P1-T1\n    status: done\n    at: "2026-05-15T10:00:00+09:00"\n    actor: human\n`
    : `events: []\n`;
  await writeFile(join(dir, ".code-pact", "state", "progress.yaml"), events, "utf8");

  if (hasAdr) {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-some-decision.md"),
      "# Decision\nSome decision body.\n",
      "utf8",
    );
  }
}

// ---------------------------------------------------------------------------
// project-a fixture — dry-run (skips actual command execution)
// P1-T1: status=done, done event present, no requires_decision
// ---------------------------------------------------------------------------

describe("runVerify — project-a P1-T1 (dry-run)", () => {
  it("all checks pass in dry-run mode", async () => {
    const result = await runVerify({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it("check names are commands, progress_event, decision, task_status", async () => {
    const result = await runVerify({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual(["commands", "progress_event", "decision", "task_status"]);
  });
});

// ---------------------------------------------------------------------------
// Mutation tests — one broken check per scenario
// ---------------------------------------------------------------------------

describe("runVerify — missing done event", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-"));
    await setupProject(dir, { hasDoneEvent: false });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("fails progress_event check", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "progress_event");
    expect(check?.ok).toBe(false);
  });
});

describe("runVerify — task status not done", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-"));
    await setupProject(dir, { taskStatus: "in_progress" });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("fails task_status check", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "task_status");
    expect(check?.ok).toBe(false);
    expect(check?.reason).toContain("in_progress");
  });
});

describe("runVerify — requires_decision but no ADR", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-"));
    await setupProject(dir, { requiresDecision: true, hasAdr: false });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("fails decision check", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "decision");
    expect(check?.ok).toBe(false);
  });
});

describe("runVerify — requires_decision with ADR present", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-"));
    await setupProject(dir, { requiresDecision: true, hasAdr: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("passes decision check when ADR filename contains task ID", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    const check = result.checks.find((c) => c.name === "decision");
    expect(check?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("runVerify — error cases", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-"));
    await setupProject(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("throws PHASE_NOT_FOUND for unknown phase", async () => {
    await expect(
      runVerify({ cwd: dir, phaseId: "NOPE", taskId: "P1-T1", dryRun: true }),
    ).rejects.toMatchObject({ code: "PHASE_NOT_FOUND" });
  });

  it("throws TASK_NOT_FOUND for unknown task", async () => {
    await expect(
      runVerify({ cwd: dir, phaseId: "P1", taskId: "NOPE", dryRun: true }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

// ---------------------------------------------------------------------------
// BUG-001 regression — verification command stdout must not reach process.stdout
// ---------------------------------------------------------------------------

describe("runVerify — BUG-001: command stdout is captured, not inherited", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-bug001-"));
    // Write a script that emits stdout and exits non-zero; avoids whitespace-in-args split issues.
    await writeFile(
      join(dir, "fail.mjs"),
      'process.stdout.write("boom"); process.exit(1);\n',
      "utf8",
    );
    await mkdir(join(dir, ".code-pact", "state", "baselines"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace("echo ok", `node ${join(dir, "fail.mjs")}`),
      "utf8",
    );
    await writeFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      `events:\n  - task_id: P1-T1\n    status: done\n    at: "2026-05-15T10:00:00+09:00"\n    actor: human\n`,
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("failing command stdout is captured into CheckResult.stdout", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: false });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.stdout).toBe("boom");
  });
});
