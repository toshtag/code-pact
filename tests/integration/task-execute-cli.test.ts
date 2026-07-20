import { beforeAll, describe, expect, it } from "vitest";
import {
  chmod,
  copyFile,
  mkdir,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
  expectJsonOk,
  repoRoot,
} from "../helpers/cli.ts";

const fakeExecutorPath = join(
  repoRoot,
  "tests",
  "fixtures",
  "executors",
  "fake-executor.mjs",
);

async function setupProject(
  cwd: string,
  verificationCommand: string,
): Promise<void> {
  await mkdir(join(cwd, "src"), { recursive: true });
  await copyFile(fakeExecutorPath, join(cwd, "executor.mjs"));
  await chmod(join(cwd, "executor.mjs"), 0o755);

  const roadmap = `phases:
  - id: P78
    path: design/phases/P78.yaml
    weight: 1
`;

  const phase = `id: P78
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

  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmap, "utf8");
  await writeFile(join(cwd, "design", "phases", "P78.yaml"), phase, "utf8");
  await writeFile(join(cwd, "src", "example.ts"), "hello world", "utf8");

  execSync("git init", { cwd, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd, stdio: "ignore" });
  execSync("git config user.name Test", { cwd, stdio: "ignore" });
  execSync("git add .", { cwd, stdio: "ignore" });
  execSync("git commit -m init", { cwd, stdio: "ignore" });
}

describe("task execute — CLI", () => {
  beforeAll(() => {
    ensureCliBuilt();
    void chmod(fakeExecutorPath, 0o755);
  });

  it("executes a one-shot edit and reports done", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "executor.mjs",
          "--json",
          "--timeout",
          "10000",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );

      expect(res.code).toBe(0);
      expectJsonOk(res);

      const content = await readFile(
        join(project.dir, "src", "example.ts"),
        "utf8",
      );
      expect(content).toBe("hi world");
    } finally {
      await project.cleanup();
    }
  });

  it("rolls back on verification failure and reports error", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 1");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "executor.mjs",
          "--json",
          "--timeout",
          "10000",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );

      expect(res.code).toBe(1);
      const parsed = expectJsonErr(res, "VERIFICATION_FAILED");
      expect(parsed.data).toEqual({
        rolled_back: true,
        failure: expect.any(Object),
      });

      const content = await readFile(
        join(project.dir, "src", "example.ts"),
        "utf8",
      );
      expect(content).toBe("hello world");
    } finally {
      await project.cleanup();
    }
  });

  it("--help emits experimental usage", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      const res = project.run(["task", "execute", "--help"]);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("EXPERIMENTAL");
      expect(res.stdout).toContain("--executor-file");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects a missing executor file with CONFIG_ERROR", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        ["task", "execute", "P78-T1", "--executor-file", "nope.mjs", "--json"],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      expectJsonErr(res, "CONFIG_ERROR");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects an executor file that is a directory", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        ["task", "execute", "P78-T1", "--executor-file", "src", "--json"],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      expectJsonErr(res, "CONFIG_ERROR");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects an executor file that is a symlink", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      await symlink("executor.mjs", join(project.dir, "bad-link.mjs"));
      execSync("git add .", { cwd: project.dir, stdio: "ignore" });
      execSync("git commit -m symlink", { cwd: project.dir, stdio: "ignore" });
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "bad-link.mjs",
          "--json",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      expectJsonErr(res, "CONFIG_ERROR");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects a non-executable executor file", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      await copyFile(
        join(project.dir, "executor.mjs"),
        join(project.dir, "noexec.mjs"),
      );
      await chmod(join(project.dir, "noexec.mjs"), 0o644);
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "noexec.mjs",
          "--json",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      expectJsonErr(res, "CONFIG_ERROR");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects an executor file outside the project", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          fakeExecutorPath,
          "--json",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      expectJsonErr(res, "CONFIG_ERROR");
    } finally {
      await project.cleanup();
    }
  });

  it("propagates an unknown --agent as AGENT_NOT_FOUND", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "executor.mjs",
          "--agent",
          "unknown-agent",
          "--json",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      const parsed = expectJsonErr(res, "AGENT_NOT_FOUND");
      expect(parsed.error.message).toContain("unknown-agent");

      const content = await readFile(
        join(project.dir, "src", "example.ts"),
        "utf8",
      );
      expect(content).toBe("hello world");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects an absolute executor-file even when it is inside the project", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-absolute-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          join(project.dir, "executor.mjs"),
          "--json",
        ],
        { env: { EXECUTOR_MODE: "replace" } },
      );
      expect(res.code).toBe(2);
      const parsed = expectJsonErr(res, "CONFIG_ERROR");
      expect(parsed.error.message).toContain("relative path");
    } finally {
      await project.cleanup();
    }
  });

  it("emits data.reason in EXECUTOR_FAILED JSON", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-failed-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "executor.mjs",
          "--json",
        ],
        { env: { EXECUTOR_MODE: "nonzero", EXECUTOR_STDERR: "bad thing" } },
      );
      expect(res.code).toBe(1);
      const parsed = expectJsonErr(res, "EXECUTOR_FAILED");
      const data = parsed.data as { reason?: string } | undefined;
      expect(data?.reason).toContain("bad thing");
    } finally {
      await project.cleanup();
    }
  });

  it("emits data.reason in EDIT_REJECTED JSON", async () => {
    const project = await createTempProject({
      prefix: "code-pact-execute-cli-edit-",
    });
    try {
      await setupProject(project.dir, "exit 0");
      const res = project.run(
        [
          "task",
          "execute",
          "P78-T1",
          "--executor-file",
          "executor.mjs",
          "--json",
        ],
        { env: { EXECUTOR_MODE: "sha_mismatch" } },
      );
      expect(res.code).toBe(1);
      const parsed = expectJsonErr(res, "EDIT_REJECTED");
      const data = parsed.data as { reason?: string } | undefined;
      expect(data?.reason).toBeTruthy();
    } finally {
      await project.cleanup();
    }
  });
});
