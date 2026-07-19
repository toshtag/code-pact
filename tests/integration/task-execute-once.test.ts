import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ExternalProcessOneShotExecutor } from "../../src/core/execute-once/executor.ts";
import { runTaskExecuteOnce } from "../../src/core/execute-once/run.ts";

const __filename = fileURLToPath(import.meta.url);
const fixtureDir = join(dirname(__filename), "..", "fixtures", "executors");
const fakeExecutorPath = join(fixtureDir, "fake-executor.mjs");

async function withTempProject<T>(
  fn: (cwd: string) => Promise<T>,
  verificationCommand = "exit 0",
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-execute-once-"));
  try {
    await setupCodePactProject(cwd, verificationCommand);
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function setupCodePactProject(
  cwd: string,
  verificationCommand: string,
): Promise<void> {
  const projectYaml = `name: test
version: "0.0.1"
locale: en-US
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
`;
  const roadmapYaml = `phases:
  - id: P78
    path: design/phases/P78.yaml
    weight: 1
`;
  const phaseYaml = `id: P78
name: One-shot
weight: 1
confidence: medium
risk: low
status: in_progress
objective: test objective
definition_of_done:
  - done
verification:
  commands:
    - ${verificationCommand}
tasks:
  - id: P78-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned
    description: test goal
    reads:
      - src/example.ts
    writes:
      - src/example.ts
`;
  const sourceContent = "hello world";

  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });

  await writeFile(join(cwd, ".code-pact", "project.yaml"), projectYaml, "utf8");
  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmapYaml, "utf8");
  await writeFile(join(cwd, "design", "phases", "P78.yaml"), phaseYaml, "utf8");
  await writeFile(join(cwd, "src", "example.ts"), sourceContent, "utf8");

  execSync("git init", { cwd, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd, stdio: "ignore" });
  execSync("git config user.name Test", { cwd, stdio: "ignore" });
  execSync("git add .", { cwd, stdio: "ignore" });
  execSync("git commit -m init", { cwd, stdio: "ignore" });
}

function setMode(mode: string): void {
  process.env.EXECUTOR_MODE = mode;
}

function clearEnv(): void {
  delete process.env.EXECUTOR_MODE;
  delete process.env.EXECUTOR_OLD;
  delete process.env.EXECUTOR_NEW;
  delete process.env.EXECUTOR_REASON;
  delete process.env.EXECUTOR_STDERR;
}

describe("runTaskExecuteOnce integration", () => {
  beforeEach(async () => {
    await chmod(fakeExecutorPath, 0o755);
    clearEnv();
    process.env.CODE_PACT_AUTHOR = "test-author";
  });

  afterEach(() => {
    clearEnv();
    delete process.env.CODE_PACT_AUTHOR;
  });

  it("applies a valid edit, verifies, and records done", async () => {
    setMode("replace");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("done");
      if (result.kind === "done") {
        expect(result.task_id).toBe("P78-T1");
        expect(result.changed_file).toBe("src/example.ts");
        expect(result.verification).toBe("passed");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hi world");
    });
  });

  it("rolls back on verification failure and does not record done", async () => {
    setMode("replace");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("verification_failed");
      if (result.kind === "verification_failed") {
        expect(result.rolled_back).toBe(true);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    }, "exit 1");
  });

  it("does not edit when the executor returns blocked", async () => {
    setMode("blocked");
    process.env.EXECUTOR_REASON = "needs human clarification";

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("blocked");
      if (result.kind === "blocked") {
        expect(result.reason).toBe("needs human clarification");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  it("fails on executor timeout", async () => {
    setMode("timeout");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
        cwd,
        timeoutMs: 100,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("executor_failed");
      if (result.kind === "executor_failed") {
        expect(result.reason).toContain("EXECUTOR_TIMEOUT");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  it("fails on malformed executor output", async () => {
    setMode("malformed");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("executor_failed");
    });
  });

  it("fails on non-zero executor exit", async () => {
    setMode("nonzero");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("executor_failed");
      if (result.kind === "executor_failed") {
        expect(result.reason).toContain("EXECUTOR_NON_ZERO_EXIT");
      }
    });
  });

  it("fails on oversized executor output", async () => {
    setMode("oversized");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("executor_failed");
      if (result.kind === "executor_failed") {
        expect(result.reason).toContain("EXECUTOR_OUTPUT_TOO_LARGE");
      }
    });
  });

  it("rejects an edit whose sha does not match the current source", async () => {
    setMode("sha_mismatch");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("edit_rejected");
      if (result.kind === "edit_rejected") {
        expect(result.reason).toBe("STALE_FILE_SHA");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  it("allows empty new_text to delete matched old_text", async () => {
    setMode("replace");
    process.env.EXECUTOR_OLD = "hello";
    process.env.EXECUTOR_NEW = "";

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("done");

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe(" world");
    });
  });

  it("bounds executor failure reason size", async () => {
    setMode("nonzero");
    process.env.EXECUTOR_STDERR = "x".repeat(10_000);

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("executor_failed");
      if (result.kind === "executor_failed") {
        expect(Buffer.byteLength(result.reason, "utf8")).toBeLessThanOrEqual(
          2048,
        );
      }
    });
  });

  it("detects when the executor mutates files outside the source path and returns bounded paths", async () => {
    await withTempProject(async cwd => {
      class MutatingExecutor {
        async invoke() {
          await writeFile(join(cwd, "src", "side.ts"), "mutation", "utf8");
          return {
            kind: "replace_exact",
            expected_file_sha256: "unused",
            old_text: "hello",
            new_text: "hi",
          } as import("../../src/core/execute-once/types.ts").OneShotExecutorOutput;
        }
      }

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor: new MutatingExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.paths).toEqual({
          changed_path_count: 1,
          changed_paths: ["src/side.ts"],
          paths_truncated: false,
        });
      }
    });
  });

  it("rejects a non-clean working tree with a bounded path summary", async () => {
    await withTempProject(async cwd => {
      await writeFile(join(cwd, "src", "extra.ts"), "extra", "utf8");
      class NoopExecutor {
        async invoke() {
          return {
            kind: "replace_exact",
            expected_file_sha256: "unused",
            old_text: "hello",
            new_text: "hi",
          } as import("../../src/core/execute-once/types.ts").OneShotExecutorOutput;
        }
      }

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor: new NoopExecutor(),
      });

      expect(result.kind).toBe("worktree_not_clean");
      if (result.kind === "worktree_not_clean") {
        expect(result.paths).toEqual({
          changed_path_count: 1,
          changed_paths: ["src/extra.ts"],
          paths_truncated: false,
        });
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  it("detects verification side effects outside the source file and reports rollback status", async () => {
    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
      });

      expect(result.kind).toBe("execution_scope_violation");
      if (result.kind === "execution_scope_violation") {
        expect(result.rollback).toMatch(/^(complete|incomplete|stale)$/);
        expect(result.paths.changed_path_count).toBeGreaterThanOrEqual(1);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    }, 'sh -c "touch src/side2.ts && exit 0"');
  });

  it("propagates unknown agent to the caller", async () => {
    setMode("replace");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      await expect(
        runTaskExecuteOnce({
          cwd,
          taskId: "P78-T1",
          agent: "unknown-agent",
          executor,
        }),
      ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    });
  });
});
