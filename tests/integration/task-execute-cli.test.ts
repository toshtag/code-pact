import { beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
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
          fakeExecutorPath,
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
          fakeExecutorPath,
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
});
