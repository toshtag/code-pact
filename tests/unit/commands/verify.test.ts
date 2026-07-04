import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runVerify, validateTimeoutMs, MAX_TIMEOUT_MS } from "../../../src/commands/verify.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers — build a minimal tmpdir project for mutation tests
// ---------------------------------------------------------------------------

const PHASE_YAML = (
  taskStatus: string,
  requiresDecision = false,
  taskRequiresDecision = false,
) =>
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
    taskRequiresDecision ? "    requires_decision: true" : "",
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
    taskRequiresDecision?: boolean;
  } = {},
): Promise<void> {
  const {
    taskStatus = "done",
    hasDoneEvent = true,
    hasAdr = false,
    requiresDecision = false,
    taskRequiresDecision = false,
  } = opts;

  await mkdir(join(dir, ".code-pact", "state", "baselines"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await mkdir(join(dir, "design", "decisions"), { recursive: true });

  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    PHASE_YAML(taskStatus, requiresDecision, taskRequiresDecision),
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
// Status-aware ADR gate (RFC §3-C, v1.22)
// ---------------------------------------------------------------------------

describe("runVerify — status-aware ADR gate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-status-"));
    await setupProject(dir, { requiresDecision: true, hasAdr: false });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("**Status:** accepted ADR resolves the decision check", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "**Status:** accepted (P1, 2026-05)\n",
      "utf8",
    );
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    const check = result.checks.find((c) => c.name === "decision");
    expect(check?.ok).toBe(true);
  });

  it("**Status:** proposed ADR does NOT resolve the decision check (status-aware)", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "**Status:** proposed (unscheduled, 2026-05)\n",
      "utf8",
    );
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    const check = result.checks.find((c) => c.name === "decision");
    expect(check?.ok).toBe(false);
    expect(check?.reason).toContain('is "proposed"');
  });

  it("explicit unknown status (typo) does NOT resolve", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "**Status:** acceptd\n",
      "utf8",
    );
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    expect(result.checks.find((c) => c.name === "decision")?.ok).toBe(false);
  });

  it("empty ADR file does NOT resolve", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "\n",
      "utf8",
    );
    expect(
      (await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true }))
        .checks.find((c) => c.name === "decision")?.ok,
    ).toBe(false);
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
// BUG-003 regression — task-level requires_decision must be enforced
// ---------------------------------------------------------------------------

describe("runVerify — BUG-003: task-level requires_decision without ADR fails", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-bug003-"));
    await setupProject(dir, { taskRequiresDecision: true, hasAdr: false });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("fails decision check when only task has requires_decision and no ADR exists", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.name === "decision");
    expect(check?.ok).toBe(false);
  });
});

describe("runVerify — BUG-003: task-level requires_decision with ADR passes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-bug003-"));
    await setupProject(dir, { taskRequiresDecision: true, hasAdr: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("passes decision check when task requires_decision and matching ADR exists", async () => {
    const result = await runVerify({ cwd: dir, phaseId: "P1", taskId: "P1-T1", dryRun: true });
    const check = result.checks.find((c) => c.name === "decision");
    expect(check?.ok).toBe(true);
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

describe("runVerify — shell verification commands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-shell-"));
    await setupProject(dir);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("preserves quoted arguments in configured shell commands", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        `node -e "if (process.argv[1] !== 'hello world') process.exit(2)" "hello world"`,
      ),
      "utf8",
    );

    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(true);
  });

  it("bounds captured stdout from failing commands", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        `node -e "process.stdout.write('x'.repeat(1100000), () => process.exit(1))"`,
      ),
      "utf8",
    );

    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.stdout).toContain("output truncated after 1048576 bytes");
    expect(Buffer.byteLength(check?.stdout ?? "")).toBeLessThan(1_050_000);
  });
});

// ---------------------------------------------------------------------------
// Timeout — kills a hanging command and reports timedOut + elapsedMs
// ---------------------------------------------------------------------------

describe("runVerify — timeout kills hanging command", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-timeout-"));
    await setupProject(dir);
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace("echo ok", "node -e \"setTimeout(()=>{}, 10000)\""),
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("kills the command and reports timedOut + elapsedMs", async () => {
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 300,
    });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.timedOut).toBe(true);
    expect(check?.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(check?.elapsedMs).toBeLessThan(5_000);
    expect(check?.reason).toContain("timed out");
  });
});

// ---------------------------------------------------------------------------
// Timeout — normal commands still work with a timeout
// ---------------------------------------------------------------------------

describe("runVerify — timeout does not affect fast commands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-timeout-fast-"));
    await setupProject(dir);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("fast command passes with a generous timeout", async () => {
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 10_000,
    });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(true);
    expect(check?.timedOut).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Child process tree kill — verifies that child processes are actually killed
// ---------------------------------------------------------------------------

describe("runVerify — timeout kills child processes in the tree", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-tree-kill-"));
    await setupProject(dir);

    // Create a child script that writes its PID to a file and hangs.
    const childScript = [
      'import { writeFileSync } from "node:fs";',
      'const pidFile = process.argv[2];',
      'writeFileSync(pidFile, String(process.pid));',
      'setInterval(() => {}, 10000);',
    ].join("\n");
    await writeFile(join(dir, "child.mjs"), childScript, "utf8");

    // Create a parent script that spawns the child and hangs.
    const childPath = join(dir, "child.mjs").replace(/\\/g, "\\\\");
    const pidPath = join(dir, "child-pid.txt").replace(/\\/g, "\\\\");
    const parentScript = [
      'import { spawn } from "node:child_process";',
      `const child = spawn(process.execPath, ["${childPath}", "${pidPath}"], { stdio: "inherit" });`,
      'setInterval(() => {}, 10000);',
    ].join("\n");
    await writeFile(join(dir, "parent.mjs"), parentScript, "utf8");
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace("echo ok", `node ${join(dir, "parent.mjs")}`),
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("child process is killed when parent times out", async () => {
    const childPidFile = join(dir, "child-pid.txt");
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 1_500,
    });

    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.timedOut).toBe(true);

    // Wait for the PID file to appear
    let pidFileExists = false;
    for (let i = 0; i < 30; i++) {
      try {
        await readFile(childPidFile, "utf8");
        pidFileExists = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(pidFileExists).toBe(true);

    // Read the child PID and verify the process is no longer alive
    const childPid = parseInt(await readFile(childPidFile, "utf8"), 10);
    expect(childPid).toBeGreaterThan(0);

    // Give the OS a moment to reap the process
    await new Promise((resolve) => setTimeout(resolve, 200));

    // On POSIX, sending signal 0 to a dead process throws
    let childAlive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
    expect(childAlive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — aborting mid-execution kills the running command
// ---------------------------------------------------------------------------

describe("runVerify — AbortSignal support", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-abort-"));
    await setupProject(dir);
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace("echo ok", "node -e \"setTimeout(()=>{}, 10000)\""),
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("aborting mid-execution kills the command and reports aborted", async () => {
    const controller = new AbortController();
    const runPromise = runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    // Abort after 200ms
    setTimeout(() => controller.abort(), 200);

    const result = await runPromise;
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.aborted).toBe(true);
    expect(check?.reason).toContain("aborted");
  });

  it("already-aborted signal prevents execution", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateTimeoutMs — strict boundary validation
// ---------------------------------------------------------------------------

describe("validateTimeoutMs", () => {
  it("accepts valid positive integers", () => {
    expect(validateTimeoutMs(1)).toBe(1);
    expect(validateTimeoutMs(300_000)).toBe(300_000);
    expect(validateTimeoutMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
  });

  it("rejects 0", () => {
    expect(() => validateTimeoutMs(0)).toThrow();
  });

  it("rejects negative", () => {
    expect(() => validateTimeoutMs(-1)).toThrow();
  });

  it("rejects NaN", () => {
    expect(() => validateTimeoutMs(NaN)).toThrow();
  });

  it("rejects Infinity", () => {
    expect(() => validateTimeoutMs(Infinity)).toThrow();
  });

  it("rejects non-integer (0.5)", () => {
    expect(() => validateTimeoutMs(0.5)).toThrow();
  });

  it("rejects values exceeding MAX_TIMEOUT_MS", () => {
    expect(() => validateTimeoutMs(MAX_TIMEOUT_MS + 1)).toThrow();
  });

  it("rejects non-safe-integer (2^53)", () => {
    expect(() => validateTimeoutMs(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structured result contract — exitCode, timedOut, aborted, elapsedMs
// ---------------------------------------------------------------------------

describe("runVerify — structured result contract", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-contract-"));
    await setupProject(dir);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("success path includes timedOut:false, aborted:false", async () => {
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(true);
    expect(check?.timedOut).toBe(false);
    expect(check?.aborted).toBe(false);
  });

  it("failure path includes exitCode and elapsedMs", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace("echo ok", "node -e \"process.exit(1)\""),
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find((c) => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.exitCode).toBe(1);
    expect(check?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(check?.timedOut).toBe(false);
    expect(check?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Meta test — no tmp directory leaks after test suite completion
// ---------------------------------------------------------------------------

describe("meta: no tmp directory leaks", () => {
  it("no code-pact-* temp directories remain after test suite", async () => {
    const { readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const entries = await readdir(tmpdir(), { withFileTypes: true });
    const leftovers = entries.filter(
      (e) => e.isDirectory() && e.name.startsWith("code-pact-verify-"),
    );
    expect(leftovers).toEqual([]);
  });
});
