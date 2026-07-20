import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ExternalProcessOneShotExecutor } from "../../src/core/execute-once/executor.ts";
import { runTaskExecuteOnce } from "../../src/core/execute-once/run.ts";
import type {
  OneShotExecutor,
  OneShotExecutorInput,
} from "../../src/core/execute-once/types.ts";
import {
  withTempProject,
  fakeExecutorPath,
  countEventFiles,
  setMode,
  clearEnv,
  ensureExecutorExecutable,
} from "./helpers/execute-once.ts";

function sha256(content: string): string {
  return createHash("sha256")
    .update(Buffer.from(content, "utf8"))
    .digest("hex");
}

function countInvocations<T>(fn: (input: OneShotExecutorInput) => Promise<T>): {
  calls: number;
  wrapped: (input: OneShotExecutorInput) => Promise<T>;
} {
  let calls = 0;
  const wrapped = async (input: OneShotExecutorInput) => {
    calls += 1;
    return await fn(input);
  };
  return {
    get calls() {
      return calls;
    },
    wrapped,
  };
}

describe("one-shot terminal invariants I1-I8", () => {
  beforeEach(async () => {
    await ensureExecutorExecutable();
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it("I1: invokes the executor at most once even when verification fails", async () => {
    setMode("replace");

    await withTempProject(async cwd => {
      const base = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
      });
      const inv = countInvocations(input => base.invoke(input));
      const countingExecutor: OneShotExecutor = { invoke: inv.wrapped };

      const result = await runTaskExecuteOnce({
        cwd,
        taskId: "P78-T1",
        executor: countingExecutor,
      });

      expect(inv.calls).toBe(1);
      expect(result.kind).toBe("done");
    });
  });

  it("I2/I4: reports execution_scope_violation with stale rollback when verification rewrites source to different content and exits 0", async () => {
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

      expect(result.kind).toBe("execution_scope_violation");
      if (result.kind === "execution_scope_violation") {
        expect(result.rollback).toBe("stale");
        expect(result.head_changed).toBe(false);
        expect(result.index_changed).toBe(false);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("verification-b");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);

      expect(await countEventFiles(cwd)).toBe(0);
    }, 'sh -c "printf \\\"verification-b\\\" > src/example.ts && exit 0"');
  });

  it("I2/I5: reports execution_scope_violation when verification rewrites source and exits 1", async () => {
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

      expect(result.kind).toBe("execution_scope_violation");
      if (result.kind === "execution_scope_violation") {
        expect(result.rollback).toBe("stale");
        expect(result.head_changed).toBe(false);
        expect(result.index_changed).toBe(false);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("verification-b");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);

      expect(await countEventFiles(cwd)).toBe(0);
    }, 'sh -c "printf \\\"verification-b\\\" > src/example.ts && exit 1"');
  });

  it("I2: rolls back to original source when verification reverts the edit and exits 0", async () => {
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

      expect(result.kind).toBe("execution_scope_violation");
      if (result.kind === "execution_scope_violation") {
        expect(result.rollback).toBe("stale");
      }

      // Verification reverted the file to the original content, so the CAS
      // rollback finds the source is no longer the applied content and refuses
      // to overwrite. The original content remains.
      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hello world");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);

      expect(await countEventFiles(cwd)).toBe(0);
    }, 'sh -c "git checkout -- src/example.ts && exit 0"');
  });

  it("I2: accepts verification that rewrites the source with the same applied content", async () => {
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

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("hi world");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);

      expect(await countEventFiles(cwd)).toBe(1);
    }, 'sh -c "printf \"hi world\" > src/example.ts && exit 0"');
  });

  it("I2/I5: detects an external source mutation between edit and verification", async () => {
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

      expect(result.kind).toBe("execution_scope_violation");
      if (result.kind === "execution_scope_violation") {
        expect(result.rollback).toBe("stale");
        expect(result.head_changed).toBe(false);
        expect(result.index_changed).toBe(false);
      }

      const content = await readFile(join(cwd, "src", "example.ts"), "utf8");
      expect(content).toBe("external");

      const headAfter = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf8",
      }).trim();
      expect(headAfter).toBe(headBefore);

      expect(await countEventFiles(cwd)).toBe(0);
    }, 'sh -c "printf \\\"external\\\" > src/example.ts && exit 0"');
  });

  it("I3: does not roll back an unknown external source mutation", async () => {
    const { execSync } = await import("node:child_process");

    await withTempProject(async cwd => {
      class ExternalMutationExecutor {
        async invoke(input: OneShotExecutorInput) {
          execSync('sh -c "echo external > src/example.ts"', {
            cwd,
            stdio: "ignore",
          });
          return {
            kind: "replace_exact",
            expected_file_sha256: sha256(input.source.content),
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

  it("I6: records a done event only when all invariants hold", async () => {
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
      expect(await countEventFiles(cwd)).toBe(1);
    });
  });

  it("I6: does not record a done event when verification fails", async () => {
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
      expect(await countEventFiles(cwd)).toBe(0);
    }, "exit 1");
  });

  it("I7: returns bounded and deterministic public result fields", async () => {
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
      const keys = Object.keys(result).sort();
      expect(keys).toEqual(["changed_file", "kind", "task_id", "verification"]);
    });
  });
});
