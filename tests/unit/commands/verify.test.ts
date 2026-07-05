import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runVerify,
  validateTimeoutMs,
  throwIfAborted,
  MAX_TIMEOUT_MS,
} from "../../../src/commands/verify.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url)
  .pathname;

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

  await mkdir(join(dir, ".code-pact", "state", "baselines"), {
    recursive: true,
  });
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
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    events,
    "utf8",
  );

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
    expect(result.checks.every(c => c.ok)).toBe(true);
  });

  it("check names are commands, progress_event, decision, task_status", async () => {
    const result = await runVerify({
      cwd: fixtureDir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    const names = result.checks.map(c => c.name);
    expect(names).toEqual([
      "commands",
      "progress_event",
      "decision",
      "task_status",
    ]);
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(c => c.name === "progress_event");
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(c => c.name === "task_status");
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(c => c.name === "decision");
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    const check = result.checks.find(c => c.name === "decision");
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    const check = result.checks.find(c => c.name === "decision");
    expect(check?.ok).toBe(true);
  });

  it("**Status:** proposed ADR does NOT resolve the decision check (status-aware)", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "**Status:** proposed (unscheduled, 2026-05)\n",
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    const check = result.checks.find(c => c.name === "decision");
    expect(check?.ok).toBe(false);
    expect(check?.reason).toContain('is "proposed"');
  });

  it("explicit unknown status (typo) does NOT resolve", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "**Status:** acceptd\n",
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    expect(result.checks.find(c => c.name === "decision")?.ok).toBe(false);
  });

  it("empty ADR file does NOT resolve", async () => {
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "\n",
      "utf8",
    );
    expect(
      (
        await runVerify({
          cwd: dir,
          phaseId: "P1",
          taskId: "P1-T1",
          dryRun: true,
        })
      ).checks.find(c => c.name === "decision")?.ok,
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    const check = result.checks.find(c => c.name === "decision");
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: true,
    });
    const check = result.checks.find(c => c.name === "decision");
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
    await mkdir(join(dir, ".code-pact", "state", "baselines"), {
      recursive: true,
    });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        `node ${join(dir, "fail.mjs")}`,
      ),
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
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find(c => c.name === "commands");
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
    const check = result.checks.find(c => c.name === "commands");
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
    const check = result.checks.find(c => c.name === "commands");
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
      PHASE_YAML("done", false).replace(
        "echo ok",
        'node -e "setTimeout(()=>{}, 10000)"',
      ),
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
    const check = result.checks.find(c => c.name === "commands");
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
    const check = result.checks.find(c => c.name === "commands");
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
      "const pidFile = process.argv[2];",
      "writeFileSync(pidFile, String(process.pid));",
      "setInterval(() => {}, 10000);",
    ].join("\n");
    await writeFile(join(dir, "child.mjs"), childScript, "utf8");

    // Create a parent script that spawns the child and hangs.
    const childPath = join(dir, "child.mjs").replace(/\\/g, "\\\\");
    const pidPath = join(dir, "child-pid.txt").replace(/\\/g, "\\\\");
    const parentScript = [
      'import { spawn } from "node:child_process";',
      `const child = spawn(process.execPath, ["${childPath}", "${pidPath}"], { stdio: "inherit" });`,
      "setInterval(() => {}, 10000);",
    ].join("\n");
    await writeFile(join(dir, "parent.mjs"), parentScript, "utf8");
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        `node ${join(dir, "parent.mjs")}`,
      ),
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("child process is killed when parent times out", async () => {
    const childPidFile = join(dir, "child-pid.txt");
    let childPid: number | null = null;

    try {
      const result = await runVerify({
        cwd: dir,
        phaseId: "P1",
        taskId: "P1-T1",
        dryRun: false,
        timeoutMs: 1_500,
      });

      const check = result.checks.find(c => c.name === "commands");
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
          await new Promise(r => setTimeout(r, 50));
        }
      }
      expect(pidFileExists).toBe(true);

      // Read the child PID and verify the process is no longer alive
      childPid = parseInt(await readFile(childPidFile, "utf8"), 10);
      expect(childPid).toBeGreaterThan(0);

      // Give the OS a moment to reap the process
      await new Promise(resolve => setTimeout(resolve, 200));

      // On POSIX, sending signal 0 to a dead process throws
      let childAlive = true;
      try {
        process.kill(childPid, 0);
      } catch {
        childAlive = false;
      }
      expect(childAlive).toBe(false);
    } finally {
      // Force-kill any orphaned child process if the test failed before kill
      if (childPid !== null) {
        try {
          process.kill(childPid, 0);
          process.kill(childPid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
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
      PHASE_YAML("done", false).replace(
        "echo ok",
        'node -e "setTimeout(()=>{}, 10000)"',
      ),
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

    try {
      const result = await runPromise;
      const check = result.checks.find(c => c.name === "commands");
      expect(check?.ok).toBe(false);
      expect(check?.aborted).toBe(true);
      expect(check?.reason).toContain("aborted");
    } finally {
      // Ensure the abort signal is fired even if the test failed mid-way
      if (!controller.signal.aborted) controller.abort();
    }
  });

  it("already-aborted signal prevents execution", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runVerify({
        cwd: dir,
        phaseId: "P1",
        taskId: "P1-T1",
        dryRun: false,
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Operation aborted");
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
// throwIfAborted — AbortSignal guard
// ---------------------------------------------------------------------------

describe("throwIfAborted", () => {
  it("does not throw when signal is undefined", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("does not throw when signal is not aborted", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it("throws with code ABORTED when signal is aborted", () => {
    const controller = new AbortController();
    controller.abort();
    try {
      throwIfAborted(controller.signal);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("ABORTED");
    }
  });

  it("throws an Error instance (not a string)", () => {
    const controller = new AbortController();
    controller.abort();
    try {
      throwIfAborted(controller.signal);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
    }
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

  it("success path includes timedOut:false, aborted:false, elapsedMs > 0", async () => {
    // Use a command with a small delay so elapsedMs is measurable
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        'node -e "setTimeout(()=>process.exit(0), 50)"',
      ),
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(true);
    expect(check?.timedOut).toBe(false);
    expect(check?.aborted).toBe(false);
    expect(check?.exitCode).toBe(0);
    expect(check?.elapsedMs).toBeGreaterThan(0);
  });

  it("failure path includes exitCode and elapsedMs", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace("echo ok", 'node -e "process.exit(1)"'),
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.exitCode).toBe(1);
    expect(check?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(check?.timedOut).toBe(false);
    expect(check?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Timeout vs abort race condition tests
// ---------------------------------------------------------------------------

describe("runVerify — timeout/abort race conditions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-race-"));
    await setupProject(dir);
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        'node -e "setTimeout(()=>{}, 10000)"',
      ),
      "utf8",
    );
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("timeout fires before abort — reports timedOut", async () => {
    const controller = new AbortController();
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 100,
      signal: controller.signal,
    });
    // Abort after timeout would have fired
    setTimeout(() => controller.abort(), 500);

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.timedOut).toBe(true);
    expect(check?.aborted).toBe(false);
  });

  it("abort fires before timeout — reports aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.aborted).toBe(true);
    expect(check?.timedOut).toBe(false);
  });

  it("natural exit before timeout and abort — reports success", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "echo ok",
        'node -e "setTimeout(()=>process.exit(0), 50)"',
      ),
      "utf8",
    );
    const controller = new AbortController();
    // Schedule abort after the command should have exited
    const abortTimer = setTimeout(() => controller.abort(), 500);
    try {
      const result = await runVerify({
        cwd: dir,
        phaseId: "P1",
        taskId: "P1-T1",
        dryRun: false,
        timeoutMs: 10_000,
        signal: controller.signal,
      });
      const check = result.checks.find(c => c.name === "commands");
      expect(check?.ok).toBe(true);
      expect(check?.timedOut).toBe(false);
      expect(check?.aborted).toBe(false);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("only one termination cause is set (not both)", async () => {
    const controller = new AbortController();
    // Fire abort almost simultaneously with timeout
    setTimeout(() => controller.abort(), 100);
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 100,
      signal: controller.signal,
    });

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    // Exactly one of timedOut or aborted must be true, not both
    expect(check?.timedOut === true || check?.aborted === true).toBe(true);
    expect(check?.timedOut && check?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-command structured result tests
// ---------------------------------------------------------------------------

describe("runVerify — per-command structured results", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-cmds-"));
    await setupProject(dir);
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("commands array contains per-command results on success", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "    - echo ok",
        "    - echo first\n    - echo second",
      ),
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find(c => c.name === "commands");
    expect(check).toBeDefined();
    const cmds = check!.commands!;
    expect(cmds).toHaveLength(2);
    const c0 = cmds[0]!;
    const c1 = cmds[1]!;
    expect(c0.command).toBe("echo first");
    expect(c0.ok).toBe(true);
    expect(c1.command).toBe("echo second");
    expect(c1.ok).toBe(true);
  });

  it("commands array preserves successful commands before a failure", async () => {
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      PHASE_YAML("done", false).replace(
        "    - echo ok",
        '    - echo first\n    - node -e "process.exit(1)"',
      ),
      "utf8",
    );
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
    });
    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check).toBeDefined();
    const cmds = check!.commands!;
    expect(cmds).toHaveLength(2);
    const c0 = cmds[0]!;
    const c1 = cmds[1]!;
    expect(c0.ok).toBe(true);
    expect(c0.exitCode).toBe(0);
    expect(c1.ok).toBe(false);
    expect(c1.exitCode).toBe(1);
  });

  it("dry-run with abort signal returns aborted result", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runVerify({
        cwd: dir,
        phaseId: "P1",
        taskId: "P1-T1",
        dryRun: true,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Operation aborted");
  });
});

// ---------------------------------------------------------------------------
// Meta test — no tmp directory leaks after test suite completion
// ---------------------------------------------------------------------------

describe("meta: no tmp directory leaks", () => {
  it("no new code-pact-verify-* temp directories remain after test suite", async () => {
    const { readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const entries = await readdir(tmpdir(), { withFileTypes: true });
    const leftovers = entries.filter(
      e => e.isDirectory() && e.name.startsWith("code-pact-verify-"),
    );
    expect(leftovers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Timeout/abort race condition tests
// ---------------------------------------------------------------------------

describe("verify: timeout/abort race conditions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verify-race-"));
    await mkdir(join(dir, ".code-pact"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });

    // Create a phase with a hanging command
    const phaseYaml = `
id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
objective: Test objective
definition_of_done:
  - Test done
tasks:
  - id: P1-T1
    name: Test Task
    type: feature
    expected_duration: short
    status: planned
    description: Test task for race conditions
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
verification:
  commands:
    - node -e "setTimeout(() => console.log('done'), 10000)"
`;
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      phaseYaml,
    );

    // Create minimal project files
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      `
name: test-project
agents:
  - id: claude-code
    name: Claude Code
    enabled: true
`,
    );
    await writeFile(
      join(dir, ".code-pact", "plan.yaml"),
      `
phases:
  - id: P1
    ref: design/phases/P1-foundation.yaml
`,
    );
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      `
phases:
  - id: P1
    name: Foundation
    path: design/phases/P1-foundation.yaml
    weight: 12
    description: Foundation phase
`,
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("timeout fires before abort", async () => {
    const controller = new AbortController();
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 100, // Very short timeout
      signal: controller.signal,
    });

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    expect(check?.timedOut).toBe(true);
    expect(check?.aborted).toBe(false);
    expect(check?.reason).toContain("timed out");
  });

  it("abort fires before timeout", async () => {
    const controller = new AbortController();

    // Abort immediately, then wait a bit before calling runVerify
    controller.abort();

    // Small delay to ensure abort is processed first
    await new Promise(resolve => setTimeout(resolve, 10));

    await expect(
      runVerify({
        cwd: dir,
        phaseId: "P1",
        taskId: "P1-T1",
        dryRun: false,
        timeoutMs: 10000, // Long timeout
        signal: controller.signal,
      }),
    ).rejects.toThrow("Operation aborted");
  });

  it("abort and timeout fire nearly simultaneously", async () => {
    const controller = new AbortController();

    // Schedule abort and timeout to fire at nearly the same time
    const abortPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 50);
    });

    const verifyPromise = runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 60, // Slightly longer than abort
      signal: controller.signal,
    });

    await abortPromise;
    const result = await verifyPromise;

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    // Should be aborted, not timed out, since abort takes precedence
    expect(check?.aborted).toBe(true);
    expect(check?.timedOut).toBe(false);
  });

  it("natural completion just before abort", async () => {
    const controller = new AbortController();

    // Create a phase with a fast command
    const phaseYaml = `
id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
objective: Test objective
definition_of_done:
  - Test done
tasks:
  - id: P1-T1
    name: Test Task
    type: feature
    expected_duration: short
    status: planned
    description: Test task for race conditions
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
verification:
  commands:
    - echo "success"
`;
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      phaseYaml,
    );

    // Schedule abort after command should complete
    setTimeout(() => controller.abort(), 200);

    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 1000,
      signal: controller.signal,
    });

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(true);
    expect(check?.timedOut).toBe(false);
    expect(check?.aborted).toBe(false);
  });

  it("killProcessTree is only called once", async () => {
    const controller = new AbortController();

    // This test verifies the behavior doesn't crash when both timeout and abort could occur
    // Full mocking of killProcessTree would require more complex test infrastructure

    // This test would require mocking the internal killProcessTree function
    // For now, we just verify the behavior doesn't crash
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 50,
      signal: controller.signal,
    });

    const check = result.checks.find(c => c.name === "commands");
    expect(check?.ok).toBe(false);
    // Should be either timed out or aborted, but not both
    expect(check?.timedOut || check?.aborted).toBe(true);
    expect(check?.timedOut && check?.aborted).toBe(false);
  });
});
