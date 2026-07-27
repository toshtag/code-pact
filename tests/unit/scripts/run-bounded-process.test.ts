import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error .mjs scripts are not included in tsconfig and are imported as untyped modules across the test suite.
import { runBoundedProcess } from "../../../scripts/lib/run-bounded-process.mjs";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bounded liveness probe for process shutdown.
 *
 * Signal delivery and reaping are scheduled by the OS, so a process that the
 * runner has already killed can still be visible for a moment after the runner
 * resolves. This waits for eventual death within a cap that keeps a leaked
 * process from hanging the suite. It is not a performance threshold: a loaded
 * shared runner may consume the whole budget and still pass.
 */
async function waitForProcessExit(
  pid: number,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 200;
  const intervalMs = options.intervalMs ?? 25;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isProcessAlive(pid)) return true;

    await new Promise(resolve => {
      setTimeout(resolve, intervalMs);
    });
  }

  return !isProcessAlive(pid);
}

function killIfAlive(pid: number): void {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness check and the signal.
  }
}

describe("runBoundedProcess", () => {
  it("succeeds when the command exits 0", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "console.log('ok')"],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("ok");
    expect(result.signal).toBeNull();
  });

  it("fails and reports the exit code when the command exits non-zero", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "console.error('err'); process.exit(42)"],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("err");
  });

  it("reports the timeout result state for a child that never exits", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 100_000)"],
      timeoutMs: 250,
      termGraceMs: 100,
    });

    // The contract under test is the reported state, not how close the runner
    // landed to 250 ms. A shared runner may return late and still be correct.
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(["SIGTERM", "SIGKILL"]).toContain(result.signal);
  });

  it("enforces the stdout/stderr size limit and reports output exceeded", async () => {
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(2 * 1024 * 1024))"],
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });

    expect(result.ok).toBe(false);
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stderr).toContain("max output exceeded");
  });

  it("kills the whole process tree when the output cap aborts the run", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rbp-tree-test-"));
    const fixture = join(tmpDir, "process-tree.mjs");
    writeFileSync(
      fixture,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeSync } from 'node:fs';",
        "import process from 'node:process';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 100000)'], { stdio: 'ignore' });",
        "child.unref();",
        "writeSync(1, 'parent ' + process.pid + '\\n');",
        "writeSync(1, 'child ' + child.pid + '\\n');",
        "setInterval(()=>{}, 100000);",
        // Overflow the cap on the next turn so the parent has already reported
        // both pids. Termination is then triggered by the output cap instead of
        // a timeout that races the child's own startup.
        "setTimeout(() => { writeSync(2, 'x'.repeat(4096)); }, 0);",
      ].join("\n"),
    );

    const spawnedPids: number[] = [];

    try {
      const result = await runBoundedProcess({
        command: process.execPath,
        args: [fixture],
        // Liveness cap so a fixture that never overflows cannot hang the
        // suite. The output cap below is what ends this run.
        timeoutMs: 10_000,
        maxOutputBytes: 1_024,
      });

      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toContain("max output exceeded");

      const parentMatch = /parent (\d+)/.exec(result.stdout);
      const childMatch = /child (\d+)/.exec(result.stdout);
      expect(parentMatch).not.toBeNull();
      expect(childMatch).not.toBeNull();

      const parentPid = Number(parentMatch![1]);
      const childPid = Number(childMatch![1]);
      spawnedPids.push(parentPid, childPid);

      expect(await waitForProcessExit(parentPid)).toBe(true);
      expect(await waitForProcessExit(childPid)).toBe(true);
    } finally {
      // Cleanup runs only after the assertions have resolved, so it can never
      // turn a leaked process into a pass.
      for (const pid of spawnedPids) killIfAlive(pid);
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("calls onProgress on output chunks and exposes the child pid", async () => {
    const progressSnapshots: Array<{ ok: boolean; elapsedMs: number }> = [];
    const result = await runBoundedProcess({
      command: process.execPath,
      args: ["-e", "console.log('hello'); console.error('world');"],
      timeoutMs: 5_000,
      heartbeatIntervalMs: 25,
      onProgress: (snapshot: { ok: boolean; elapsedMs: number }) => {
        progressSnapshots.push({
          ok: snapshot.ok,
          elapsedMs: snapshot.elapsedMs,
        });
      },
    });

    expect(result.ok).toBe(true);
    expect(typeof result.pid).toBe("number");
    expect(result.pid).toBeGreaterThan(0);
    expect(progressSnapshots.length).toBeGreaterThan(0);
    const last = progressSnapshots[progressSnapshots.length - 1]!;
    expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("emits repeated heartbeats while the child is silent", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "rbp-heartbeat-test-"));
    const fixture = join(tmpDir, "silent-child.mjs");
    const releasePath = join(tmpDir, "release");
    writeFileSync(
      fixture,
      [
        "import { existsSync } from 'node:fs';",
        "import process from 'node:process';",
        "const releasePath = process.argv[2];",
        "const poll = setInterval(() => {",
        "  if (existsSync(releasePath)) {",
        "    clearInterval(poll);",
        "    process.exit(0);",
        "  }",
        "}, 5);",
      ].join("\n"),
    );

    let heartbeatCount = 0;
    let released = false;

    try {
      const result = await runBoundedProcess({
        command: process.execPath,
        args: [fixture, releasePath],
        // Liveness cap so a child that never sees the marker cannot hang the
        // suite. Heartbeat pass/fail is decided by the handshake below, not by
        // how many heartbeats fit into a wall-clock window.
        timeoutMs: 10_000,
        heartbeatIntervalMs: 25,
        onProgress: (snapshot: { stdout: string; stderr: string }) => {
          if (released) return;
          // The child writes nothing, so every callback here is a heartbeat
          // tick rather than an output chunk.
          if (snapshot.stdout !== "" || snapshot.stderr !== "") return;

          heartbeatCount += 1;
          if (heartbeatCount === 3) {
            writeFileSync(releasePath, "release\n");
            released = true;
          }
        },
      });

      // The child can only exit once the third heartbeat released it, so a
      // clean exit proves the heartbeats fired.
      expect(result.ok).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(heartbeatCount).toBeGreaterThanOrEqual(3);
      expect(existsSync(releasePath)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
