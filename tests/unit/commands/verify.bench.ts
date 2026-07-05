import { describe, bench, beforeAll } from "vitest";
import { runVerify } from "../../../src/commands/verify.ts";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("verify command performance", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "code-pact-verify-bench-"));
    await mkdir(join(testDir, ".code-pact"), { recursive: true });
    await mkdir(join(testDir, "design", "phases"), { recursive: true });

    // Create a test phase with simple commands
    const phaseYaml = `
id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
tasks:
  - id: P1-T1
    name: Test Task
    expected_duration: short
    status: planned
    description: Performance test task
verification:
  commands:
    - echo "test"
    - date
`;
    await writeFile(
      join(testDir, "design", "phases", "P1-foundation.yaml"),
      phaseYaml,
      "utf8",
    );
  });

  bench("runVerify with simple commands", async () => {
    await runVerify({
      cwd: testDir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 5000,
      skipConsistencyChecks: true,
    });
  });

  bench("runVerify with timeout", async () => {
    await runVerify({
      cwd: testDir,
      phaseId: "P1",
      taskId: "P1-T1",
      dryRun: false,
      timeoutMs: 1000,
      skipConsistencyChecks: true,
    });
  });

  bench("runVerify with abort signal", async () => {
    const controller = new AbortController();
    // Abort immediately to test abort performance
    controller.abort();

    try {
      await runVerify({
        cwd: testDir,
        phaseId: "P1",
        taskId: "P1-T1",
        dryRun: false,
        timeoutMs: 5000,
        signal: controller.signal,
        skipConsistencyChecks: true,
      });
    } catch {
      // Expected to abort
    }
  });
});
