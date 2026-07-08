import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_TIMEOUT_MS,
  runVerify,
  validateTimeoutMs,
} from "../../../src/commands/verify.ts";
import { terminateProcessTree } from "../../../src/core/process/bounded-command.ts";

const ROADMAP = "phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 1\n";

function phase(commands: string[]): string {
  return [
    "id: P1",
    "name: Process control",
    "weight: 1",
    "confidence: high",
    "risk: low",
    "status: done",
    "objective: Verify process lifecycle.",
    "definition_of_done:",
    "  - checks pass",
    "verification:",
    "  commands:",
    ...commands.map(command => `    - ${JSON.stringify(command)}`),
    "tasks:",
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: weak",
    "    expected_duration: short",
    "    status: done",
    "",
  ].join("\n");
}

async function setupProject(dir: string, commands: string[]): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await mkdir(join(dir, "design", "decisions"), { recursive: true });
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP);
  await writeFile(join(dir, "design", "phases", "P1.yaml"), phase(commands));
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    'events:\n  - task_id: P1-T1\n    status: done\n    at: "2026-01-01T00:00:00Z"\n    actor: human\n',
  );
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (pidExists(pid)) throw new Error(`Process ${pid} did not exit`);
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function readPids(dir: string): Promise<{ parent: number; child: number } | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "tree-pids.json"), "utf8")) as {
      parent: number;
      child: number;
    };
  } catch {
    return undefined;
  }
}

async function forceCleanup(pids: { parent: number; child: number } | undefined): Promise<void> {
  if (!pids) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pids.parent), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pids.parent, "SIGKILL");
  } catch {
    // Already gone.
  }
  for (const pid of [pids.child, pids.parent]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

async function installProcessTreeFixture(dir: string): Promise<void> {
  await writeFile(
    join(dir, "tree-child.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("child-started", String(process.pid));',
      'setTimeout(() => writeFileSync("child-survived", "yes"), 1_200);',
      "setInterval(() => {}, 10_000);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "tree-parent.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["tree-child.mjs"], { stdio: "ignore" });',
      'writeFileSync("tree-pids.json", JSON.stringify({ parent: process.pid, child: child.pid }));',
      'writeFileSync("tree-ready", "ready");',
      "setInterval(() => {}, 10_000);",
      "",
    ].join("\n"),
  );
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-verify-process-"));
});

afterEach(async () => {
  await forceCleanup(await readPids(dir));
  await rm(dir, { recursive: true, force: true });
});

describe("verification command process lifecycle", () => {
  it("validates every timeout boundary and keeps 2 as a valid value", () => {
    expect(validateTimeoutMs(1)).toBe(1);
    expect(validateTimeoutMs(2)).toBe(2);
    expect(validateTimeoutMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
    for (const value of [0, 0.5, -1, Number.NaN, Infinity, MAX_TIMEOUT_MS + 1]) {
      expect(() => validateTimeoutMs(value)).toThrow();
    }
  });

  it("preserves a structured result for every successful command", async () => {
    await writeFile(
      join(dir, "success.mjs"),
      'setTimeout(() => { console.log("out"); console.error("err"); }, 60);\n',
    );
    await setupProject(dir, ["node success.mjs", "node -e \"process.exit(0)\""]);
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    const commands = result.checks[0]?.commands;
    expect(commands).toHaveLength(2);
    expect(commands?.[0]).toMatchObject({
      ok: true,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      stdout: "out\n",
      stderr: "err\n",
    });
    expect(commands?.[0]?.elapsedMs).toBeGreaterThan(0);
  });

  it("retains successful command evidence when a later command fails", async () => {
    await setupProject(dir, [
      'node -e "console.log(\'first-ok\')"',
      'node -e "console.error(\'second-failed\'); process.exit(7)"',
    ]);
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    const commands = result.checks[0]?.commands;
    expect(commands).toHaveLength(2);
    expect(commands?.[0]).toMatchObject({
      ok: true,
      exitCode: 0,
      stdout: "first-ok\n",
    });
    expect(commands?.[1]).toMatchObject({
      ok: false,
      exitCode: 7,
      stderr: "second-failed\n",
    });
  });

  it("times out and removes the complete parent/child process tree", async () => {
    await installProcessTreeFixture(dir);
    await setupProject(dir, ["node tree-parent.mjs"]);
    const result = await runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: process.platform === "win32" ? 750 : 300,
    });

    const command = result.checks[0]?.commands?.[0];
    expect(command).toMatchObject({ ok: false, timedOut: true, aborted: false });
    expect(command?.termination).toMatchObject({ completed: true, closeObserved: true });
    const pids = await readPids(dir);
    expect(pids).toBeDefined();
    await waitForPidExit(pids!.parent);
    await waitForPidExit(pids!.child);
    expect(pidExists(pids!.parent)).toBe(false);
    expect(pidExists(pids!.child)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1_250));
    expect(existsSync(join(dir, "child-survived"))).toBe(false);
  }, 10_000);

  it("aborts promptly and removes the complete parent/child process tree", async () => {
    await installProcessTreeFixture(dir);
    await setupProject(dir, ["node tree-parent.mjs"]);
    const controller = new AbortController();
    const pending = runVerify({
      cwd: dir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    await waitForFile(join(dir, "tree-ready"));
    controller.abort();
    const result = await pending;

    expect(result.checks).toHaveLength(1);
    const command = result.checks[0]?.commands?.[0];
    expect(command).toMatchObject({ ok: false, timedOut: false, aborted: true });
    expect(command?.termination).toMatchObject({ completed: true, closeObserved: true });
    const pids = await readPids(dir);
    expect(pids).toBeDefined();
    await waitForPidExit(pids!.parent);
    await waitForPidExit(pids!.child);
    expect(pidExists(pids!.parent)).toBe(false);
    expect(pidExists(pids!.child)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1_250));
    expect(existsSync(join(dir, "child-survived"))).toBe(false);
  }, 10_000);
});

describe("Windows process tree termination diagnostics", () => {
  it("reports successful taskkill termination only after the root process exits", async () => {
    const kill = vi.fn(() => true);
    const result = await terminateProcessTree(
      { pid: 1234, kill },
      {
        platform: "win32",
        runTaskkill: async pid => ({ code: pid === 1234 ? 0 : 1 }),
        waitForTargetExit: async target => target === 1234,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      completed: true,
      strategy: "taskkill",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not claim descendant cleanup when taskkill succeeds but the root remains", async () => {
    const kill = vi.fn(() => true);
    const result = await terminateProcessTree(
      { pid: 1234, kill },
      {
        platform: "win32",
        runTaskkill: async () => ({ code: 0 }),
        waitForTargetExit: async () => false,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      completed: false,
      strategy: "taskkill",
      error: "taskkill completed but the root process remained",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to a direct root kill when taskkill exits non-zero", async () => {
    const kill = vi.fn(() => true);
    const result = await terminateProcessTree(
      { pid: 1234, kill },
      {
        platform: "win32",
        runTaskkill: async () => ({ code: 5 }),
        waitForTargetExit: async target => target === 1234,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      completed: false,
      strategy: "direct-kill",
    });
    expect(result.error).toContain("taskkill exited with code 5");
    expect(result.error).toContain("descendant cleanup could not be confirmed");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("preserves taskkill timeout diagnostics when direct root kill is the fallback", async () => {
    const kill = vi.fn(() => true);
    const result = await terminateProcessTree(
      { pid: 1234, kill },
      {
        platform: "win32",
        runTaskkill: async () => ({ code: null, error: "taskkill timed out" }),
        waitForTargetExit: async target => target === 1234,
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      completed: false,
      strategy: "direct-kill",
    });
    expect(result.error).toContain("taskkill timed out");
    expect(result.error).toContain("descendant cleanup could not be confirmed");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });
});
