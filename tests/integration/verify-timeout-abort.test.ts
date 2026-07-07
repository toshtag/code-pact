import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliPath, ensureCliBuilt, run } from "../helpers/cli.ts";
import { loadMergedProgress } from "../../src/core/progress/io.ts";

function phase(command: string, taskStatus: "planned" | "done" = "planned"): string {
  return [
    "id: P1",
    "name: Timeout integration",
    "weight: 1",
    "confidence: high",
    "risk: low",
    "status: in_progress",
    "objective: Verify bounded command execution.",
    "definition_of_done:",
    "  - checks pass",
    "verification:",
    "  commands:",
    `    - ${JSON.stringify(command)}`,
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
    "",
  ].join("\n");
}

async function setupProject(
  dir: string,
  command: string,
  opts: { taskStatus?: "planned" | "done"; progressDone?: boolean } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await mkdir(join(dir, "design", "decisions"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    [
      "name: timeout-integration",
      "version: 0.1.0",
      "locale: en-US",
      "default_agent: claude-code",
      "agents:",
      "  - name: claude-code",
      "    profile: agent-profiles/claude-code.yaml",
      "    enabled: true",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressDone
      ? [
          "events:",
          "  - task_id: P1-T1",
          "    status: done",
          '    at: "2026-07-07T00:00:00.000Z"',
          "    actor: agent",
          "",
        ].join("\n")
      : "events: []\n",
  );
  await writeFile(
    join(dir, "design", "roadmap.yaml"),
    "phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 1\n",
  );
  await writeFile(
    join(dir, "design", "phases", "P1.yaml"),
    phase(command, opts.taskStatus),
  );
}

async function installLongProcessFixture(dir: string): Promise<void> {
  await writeFile(
    join(dir, "long-child.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("long-child-started", String(process.pid));',
      'setTimeout(() => writeFileSync("long-child-survived", "yes"), 1_000);',
      "setInterval(() => {}, 10_000);",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(dir, "long-parent.mjs"),
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["long-child.mjs"], { stdio: "ignore" });',
      'writeFileSync("long-pids.json", JSON.stringify({ parent: process.pid, child: child.pid }));',
      'writeFileSync("long-ready", "ready");',
      "setInterval(() => {}, 10_000);",
      "",
    ].join("\n"),
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

async function readPids(dir: string): Promise<{ parent: number; child: number } | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "long-pids.json"), "utf8")) as {
      parent: number;
      child: number;
    };
  } catch {
    return undefined;
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function forceCleanupTree(pids: { parent: number; child: number } | undefined): Promise<void> {
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

async function collectProcess(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", chunk => {
    stderr += String(chunk);
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      reject(new Error("CLI process did not exit after cancellation"));
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let dir: string;
let activeCli: ChildProcess | undefined;

beforeAll(() => ensureCliBuilt());

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-timeout-integration-"));
});

afterEach(async () => {
  if (activeCli && activeCli.exitCode === null) {
    try {
      activeCli.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  activeCli = undefined;
  await forceCleanupTree(await readPids(dir));
  await rm(dir, { recursive: true, force: true });
});

describe("CLI timeout contract", () => {
  it("accepts --timeout 2 as a valid value", async () => {
    await setupProject(dir, "echo ok", {
      taskStatus: "done",
      progressDone: true,
    });
    const result = run(dir, [
      "verify",
      "--phase",
      "P1",
      "--task",
      "P1-T1",
      "--dry-run",
      "--timeout",
      "2",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  });

  it("rejects timeout values outside the documented integer range", async () => {
    await setupProject(dir, "echo ok");
    for (const value of ["0", "0.5", "2147483648"]) {
      const result = run(dir, [
        "verify",
        "--phase",
        "P1",
        "--task",
        "P1-T1",
        "--timeout",
        value,
        "--json",
      ]);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "CONFIG_ERROR" },
      });
    }
  });

  it("does not record completion when verification times out", async () => {
    await installLongProcessFixture(dir);
    await setupProject(dir, "node long-parent.mjs");
    const result = run(dir, [
      "task",
      "complete",
      "P1-T1",
      "--timeout",
      "250",
      "--json",
    ]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      error: { code: string; cause_code?: string };
      data: { verify: { checks: Array<{ commands?: Array<{ timedOut: boolean }> }> } };
    };
    expect(envelope.error).toMatchObject({
      code: "VERIFICATION_FAILED",
      cause_code: "COMMANDS_FAILED",
    });
    expect(envelope.data.verify.checks[0]?.commands?.[0]?.timedOut).toBe(true);
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(0);
    const pids = await readPids(dir);
    expect(pids).toBeDefined();
    await waitForPidExit(pids!.parent);
    await waitForPidExit(pids!.child);
    expect(pidExists(pids!.parent)).toBe(false);
    expect(pidExists(pids!.child)).toBe(false);
  }, 15_000);

  it("honours a longer task-complete timeout", async () => {
    await writeFile(join(dir, "short.mjs"), "setTimeout(() => process.exit(0), 100);\n");
    await setupProject(dir, "node short.mjs");
    const result = run(dir, [
      "task",
      "complete",
      "P1-T1",
      "--timeout",
      "5000",
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
    expect((await loadMergedProgress(dir)).log.events).toHaveLength(1);
  });
});

if (process.platform !== "win32") {
  describe("CLI cancellation contract", () => {
    it.each(["SIGINT", "SIGTERM"] as const)(
      "cancels task complete on %s, removes descendants, and records no event",
      async (signal: NodeJS.Signals) => {
        await installLongProcessFixture(dir);
        await setupProject(dir, "node long-parent.mjs");
        activeCli = spawn(
          process.execPath,
          [cliPath, "task", "complete", "P1-T1", "--timeout", "10000", "--json"],
          { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
        );
        const resultPromise = collectProcess(activeCli);
        await waitForFile(join(dir, "long-ready"));
        activeCli.kill(signal);
        const result = await resultPromise;
        activeCli = undefined;

        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { code: "VERIFICATION_FAILED", cause_code: "ABORTED" },
          data: { aborted: true },
        });
        expect((await loadMergedProgress(dir)).log.events).toHaveLength(0);
        const pids = await readPids(dir);
        expect(pids).toBeDefined();
        await waitForPidExit(pids!.parent);
        await waitForPidExit(pids!.child);
        expect(pidExists(pids!.parent)).toBe(false);
        expect(pidExists(pids!.child)).toBe(false);
        expect(existsSync(join(dir, "long-child-survived"))).toBe(false);
      },
      15_000,
    );

    it("reports standalone verify cancellation through the stable error envelope", async () => {
      await installLongProcessFixture(dir);
      await setupProject(dir, "node long-parent.mjs");
      activeCli = spawn(
        process.execPath,
        [cliPath, "verify", "--phase", "P1", "--task", "P1-T1", "--json"],
        { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
      );
      const resultPromise = collectProcess(activeCli);
      await waitForFile(join(dir, "long-ready"));
      activeCli.kill("SIGTERM");
      const result = await resultPromise;
      activeCli = undefined;

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "VERIFICATION_FAILED", cause_code: "ABORTED" },
      });
      const pids = await readPids(dir);
      expect(pids).toBeDefined();
      await waitForPidExit(pids!.parent);
      await waitForPidExit(pids!.child);
      expect(pidExists(pids!.parent)).toBe(false);
      expect(pidExists(pids!.child)).toBe(false);
    }, 15_000);
  });
}
