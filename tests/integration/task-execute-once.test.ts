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
import { ExternalProcessOneShotExecutor } from "../../src/core/execute-once/executor.ts";
import { runTaskExecuteOnce } from "../../src/core/execute-once/run.ts";

const __filename = fileURLToPath(import.meta.url);
const fixtureDir = join(dirname(__filename), "..", "fixtures", "executors");
const fakeExecutorPath = join(fixtureDir, "fake-executor.mjs");

async function withTempProject<T>(
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-execute-once-"));
  try {
    await setupCodePactProject(cwd);
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function setupCodePactProject(cwd: string): Promise<void> {
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
    - {{verification_command}}
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
  await writeFile(
    join(cwd, "design", "phases", "P78.yaml"),
    phaseYaml.replace("{{verification_command}}", "exit 0"),
    "utf8",
  );
  await writeFile(join(cwd, "src", "example.ts"), sourceContent, "utf8");
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
        cwd,
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
      const phaseYaml = (await readFile(
        join(cwd, "design", "phases", "P78.yaml"),
        "utf8",
      )).replace("exit 0", "exit 1");
      await writeFile(join(cwd, "design", "phases", "P78.yaml"), phaseYaml, "utf8");

      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
        cwd,
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
    });
  });

  it("does not edit when the executor returns blocked", async () => {
    setMode("blocked");
    process.env.EXECUTOR_REASON = "needs human clarification";

    await withTempProject(async cwd => {
      const executor = new ExternalProcessOneShotExecutor({
        executablePath: fakeExecutorPath,
        cwd,
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
        cwd,
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
        cwd,
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
        cwd,
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
        cwd,
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
});
