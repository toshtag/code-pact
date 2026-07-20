import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { ExternalProcessOneShotExecutor } from "../../src/core/execute-once/executor.ts";
import { parseOneShotExecutorOutput } from "../../src/core/execute-once/output-schema.ts";
import { runTaskExecuteOnce } from "../../src/core/execute-once/run.ts";
import type { GitSnapshotProvider } from "../../src/core/execute-once/git-status.ts";

const __filename = fileURLToPath(import.meta.url);
export const fixtureDir = join(
  dirname(__filename),
  "..",
  "fixtures",
  "executors",
);
export const fakeExecutorPath = join(fixtureDir, "fake-executor.mjs");

export async function withTempProject<T>(
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

export async function setupCodePactProject(
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

export function setMode(mode: string): void {
  process.env.EXECUTOR_MODE = mode;
}

export function clearEnv(): void {
  delete process.env.EXECUTOR_MODE;
  delete process.env.EXECUTOR_OLD;
  delete process.env.EXECUTOR_NEW;
  delete process.env.EXECUTOR_REASON;
  delete process.env.EXECUTOR_STDERR;
}

export async function countEventFiles(cwd: string): Promise<number> {
  try {
    const names = await readdir(join(cwd, ".code-pact", "state", "events"));
    return names.filter(n => /^\d{8}T\d{9}Z-[0-9a-f]{64}\.yaml$/.test(n))
      .length;
  } catch {
    return 0;
  }
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
      const headBefore = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
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

      expect(await countEventFiles(cwd)).toBe(1);
      const status = execSync("git status --porcelain", {
        cwd,
        encoding: "utf8",
      });
      expect(status).toContain("M src/example.ts");
      expect(status).toContain("?? .code-pact/state/");
      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);
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
      expect(await countEventFiles(cwd)).toBe(0);
      const status = execSync("git status --porcelain", {
        cwd,
        encoding: "utf8",
      });
      expect(status.trim()).toBe("");
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

  it("reports executor_mutated_worktree and does not roll back when the executor mutates the source file before returning", async () => {
    await withTempProject(async cwd => {
      class MutatingSourceExecutor {
        async invoke(): Promise<
          import("../../src/core/execute-once/types.ts").OneShotExecutorOutput
        > {
          await writeFile(join(cwd, "src", "example.ts"), "mutated", "utf8");
          return {
            kind: "replace_exact",
            expected_file_sha256: "unused",
            old_text: "hello",
            new_text: "hi",
          };
        }
      }

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor: new MutatingSourceExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.paths).toEqual({
          changed_path_count: 1,
          changed_paths: ["src/example.ts"],
          paths_truncated: false,
        });
        expect(result.rollback).toBe("not_attempted");
        expect(result.rollback_reason).toBe(
          "mutation provenance cannot be proven",
        );
        expect(result.head_changed).toBe(false);
        expect(result.index_changed).toBe(false);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("mutated");
    });
  });

  it("does not invoke the executor when the agent is unknown", async () => {
    let invoked = false;
    class SpyExecutor {
      async invoke() {
        invoked = true;
        return { kind: "blocked", reason: "should not run" } as any;
      }
    }

    await withTempProject(async cwd => {
      await expect(
        runTaskExecuteOnce({
          cwd,
          taskId: "P78-T1",
          agent: "unknown-agent",
          executor: new SpyExecutor(),
        }),
      ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
      expect(invoked).toBe(false);

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    });
  });

  it("rejects executor output that fails controller-level schema validation", async () => {
    await withTempProject(async cwd => {
      class BadOutputExecutor {
        async invoke() {
          return {
            kind: "replace_exact",
            expected_file_sha256: "not-hex",
            old_text: "hello",
            new_text: "hi",
          };
        }
      }

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor: new BadOutputExecutor(),
      });

      expect(result.kind).toBe("executor_failed");
      if (result.kind === "executor_failed") {
        expect(result.reason).toMatch(/EXECUTOR_SCHEMA_MISMATCH/);
      }
    });
  });

  it("reports executor_mutated_worktree when the executor stages the source file", async () => {
    const { execSync } = await import("node:child_process");

    await withTempProject(async cwd => {
      class StageThenReturnExecutor {
        async invoke() {
          await writeFile(join(cwd, "src", "example.ts"), "staged", "utf8");
          execSync("git add src/example.ts", { cwd, stdio: "ignore" });
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
        executor: new StageThenReturnExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.rollback).toBe("not_attempted");
        expect(result.index_changed).toBe(true);
        expect(result.head_changed).toBe(false);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("staged");
    });
  });

  it("reports executor_mutated_worktree when the executor deletes the source file", async () => {
    await withTempProject(async cwd => {
      class DeleteSourceExecutor {
        async invoke() {
          await rm(join(cwd, "src", "example.ts"));
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
        executor: new DeleteSourceExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.rollback).toBe("not_attempted");
      }

      await expect(
        readFile(join(cwd, "src", "example.ts"), "utf8"),
      ).rejects.toThrow();
    });
  });

  it("rejects custom executor output with unknown keys via controller schema", async () => {
    await withTempProject(async cwd => {
      class UnknownKeyExecutor {
        async invoke() {
          return {
            kind: "replace_exact",
            expected_file_sha256: "0".repeat(64),
            old_text: "hello",
            new_text: "hi",
            extra: true,
          } as import("../../src/core/execute-once/types.ts").OneShotExecutorOutput;
        }
      }

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor: new UnknownKeyExecutor(),
      });

      expect(result.kind).toBe("executor_failed");
      if (result.kind === "executor_failed") {
        expect(result.reason).toMatch(/EXECUTOR_SCHEMA_MISMATCH/);
        expect(Buffer.byteLength(result.reason, "utf8")).toBeLessThanOrEqual(
          2048,
        );
      }
    });
  });

  it("rejects external executor output with unknown keys via controller schema", async () => {
    const execDir = await mkdtemp(
      join(tmpdir(), "code-pact-executor-unknown-key-"),
    );
    const scriptPath = join(execDir, "unknown-key.mjs");
    const script = `#!/usr/bin/env node
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    kind: "replace_exact",
    expected_file_sha256: "${"0".repeat(64)}",
    old_text: "hello",
    new_text: "hi",
    extra: true
  }));
});
`;

    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);

    try {
      await withTempProject(async cwd => {
        const executor = new ExternalProcessOneShotExecutor({
          executablePath: scriptPath,
        });

        const result = await runTaskExecuteOnce({
          cwd,
          taskId: "P78-T1",
          executor,
        });

        expect(result.kind).toBe("executor_failed");
        if (result.kind === "executor_failed") {
          expect(result.reason).toMatch(/EXECUTOR_SCHEMA_MISMATCH/);
        }
      });
    } finally {
      await rm(execDir, { recursive: true, force: true });
    }
  });

  it("reports executor_mutated_worktree when the executor replaces source with a directory", async () => {
    await withTempProject(async cwd => {
      class DirectoryReplaceExecutor {
        async invoke() {
          await rm(join(cwd, "src", "example.ts"));
          await mkdir(join(cwd, "src", "example.ts"));
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
        executor: new DirectoryReplaceExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.rollback).toBe("not_attempted");
      }

      const stats = await lstat(join(cwd, "src", "example.ts"));
      expect(stats.isDirectory()).toBe(true);
    });
  });

  it("reports executor_mutated_worktree when the executor replaces source with a symlink", async () => {
    await withTempProject(async cwd => {
      class SymlinkReplaceExecutor {
        async invoke() {
          await rm(join(cwd, "src", "example.ts"));
          await symlink(
            join(cwd, "src", "target.txt"),
            join(cwd, "src", "example.ts"),
          );
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
        executor: new SymlinkReplaceExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.rollback).toBe("not_attempted");
      }

      const target = await readlink(join(cwd, "src", "example.ts"));
      expect(target).toBe(join(cwd, "src", "target.txt"));
    });
  });

  it("reports executor_mutated_worktree when the executor creates a commit", async () => {
    const { execSync } = await import("node:child_process");

    await withTempProject(async cwd => {
      class CommittingExecutor {
        async invoke() {
          await writeFile(join(cwd, "src", "example.ts"), "committed", "utf8");
          execSync('git add src/example.ts && git commit -m "executor"', {
            cwd,
            stdio: "ignore",
          });
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
        executor: new CommittingExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.head_changed).toBe(true);
        expect(result.rollback).toBe("not_attempted");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("committed");
      const headNow = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      const headBefore = execSync("git rev-parse HEAD~1", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headNow).not.toBe(headBefore);
    });
  });

  it("reports execution_scope_violation when verification stages the source file", async () => {
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
        expect(result.index_changed).toBe(true);
        expect(result.head_changed).toBe(false);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
    }, 'sh -c "git add src/example.ts && exit 0"');
  });

  it("reports execution_scope_violation when verification commits and exits 1", async () => {
    const { execSync } = await import("node:child_process");

    await withTempProject(async cwd => {
      const headBefore = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
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
        expect(result.head_changed).toBe(true);
        expect(result.rollback).toBe("incomplete");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).not.toBe(headBefore);

      const indexChanged = execSync("git diff --cached --name-only", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(indexChanged).toBe("");

      expect(await countEventFiles(cwd)).toBe(0);
    }, 'sh -c "git add src/example.ts && git commit -m verify-fail && exit 1"');
  });

  it("does not roll back an unknown external source change", async () => {
    const { execSync } = await import("node:child_process");

    await withTempProject(async cwd => {
      class ExternalMutationExecutor {
        async invoke() {
          // Simulate an external process mutating the source before the
          // executor returns. The mutation must not be rolled back.
          execSync('sh -c "echo external > src/example.ts"', {
            cwd,
            stdio: "ignore",
          });
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
        executor: new ExternalMutationExecutor(),
      });

      expect(result.kind).toBe("executor_mutated_worktree");
      if (result.kind === "executor_mutated_worktree") {
        expect(result.rollback).toBe("not_attempted");
        expect(result.rollback_reason).toBe(
          "mutation provenance cannot be proven",
        );
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content.trim()).toBe("external");
      expect(await countEventFiles(cwd)).toBe(0);
    });
  });

  it("rolls back a known edit and reports git_state_unavailable when git snapshot fails after edit", async () => {
    setMode("replace");

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });

      let calls = 0;
      const gitSnapshotProvider: GitSnapshotProvider = async () => {
        calls += 1;
        if (calls === 3) {
          return {
            kind: "git_error",
            reason: "GIT_SNAPSHOT_CHANGED_DURING_READ",
          };
        }
        return {
          kind: "ok",
          head: null,
          entries: [],
        } as import("../../src/core/execute-once/git-status.ts").GitSnapshot;
      };

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor,
        gitSnapshotProvider,
      });

      expect(result.kind).toBe("git_state_unavailable");
      if (result.kind === "git_state_unavailable") {
        expect(result.source_rollback).toBe("complete");
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");
      expect(await countEventFiles(cwd)).toBe(0);
    });
  });

  it("runs external executors in an OS temp directory with a sanitized environment", async () => {
    const execDir = await mkdtemp(join(tmpdir(), "code-pact-executor-env-"));
    const scriptPath = join(execDir, "env-check.mjs");
    const outputPath = join(execDir, "env.json");
    const script = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CP_TEST_OUTPUT, JSON.stringify({
  cwd: process.cwd(),
  hasPwd: "PWD" in process.env,
  hasInitCwd: "INIT_CWD" in process.env,
  hasNpmJson: "npm_package_json" in process.env,
  hasPath: "PATH" in process.env,
}));
process.stdout.write(JSON.stringify({ kind: "blocked", reason: "env check" }));\n`;

    await writeFile(scriptPath, script, "utf8");
    await chmod(scriptPath, 0o755);

    const savedPwd = process.env.PWD;
    const savedInitCwd = process.env.INIT_CWD;
    const savedNpmJson = process.env.npm_package_json;
    process.env.PWD = execDir;
    process.env.INIT_CWD = execDir;
    process.env.npm_package_json = "/should/be/removed/package.json";
    process.env.CP_TEST_OUTPUT = outputPath;

    try {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: scriptPath,
      });
      const raw = await executor.invoke({
        schema_version: 1,
        task: {
          id: "T",
          goal: "x",
          source_path: "s",
          done_when: [],
          verification_command: "exit 0",
        },
        source: { content: "c", sha256: "s" },
        response_contract: { allowed_kinds: ["replace_exact", "blocked"] },
      });

      const result = parseOneShotExecutorOutput(raw);
      expect(result.kind).toBe("blocked");

      const captured = JSON.parse(await readFile(outputPath, "utf8"));
      expect(captured.cwd).not.toBe(execDir);
      expect(await realpath(captured.cwd)).toBe(await realpath(tmpdir()));
      expect(captured.hasPwd).toBe(false);
      expect(captured.hasInitCwd).toBe(false);
      expect(captured.hasNpmJson).toBe(false);
      expect(captured.hasPath).toBe(true);
    } finally {
      if (savedPwd === undefined) delete process.env.PWD;
      else process.env.PWD = savedPwd;
      if (savedInitCwd === undefined) delete process.env.INIT_CWD;
      else process.env.INIT_CWD = savedInitCwd;
      if (savedNpmJson === undefined) delete process.env.npm_package_json;
      else process.env.npm_package_json = savedNpmJson;
      delete process.env.CP_TEST_OUTPUT;
      await rm(execDir, { recursive: true, force: true });
    }
  });
});
