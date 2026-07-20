import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCiParity } from "../../../src/commands/ci-parity.ts";
import { writeReviewManifest } from "../../../src/core/review-bundle.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-ci-parity-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function setupProject(): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    [
      "id: P1",
      "name: Foundation",
      "weight: 10",
      "confidence: medium",
      "risk: low",
      "status: planned",
      "objective: Establish the project foundation",
      "definition_of_done:",
      "  - All tasks done",
      "verification:",
      "  commands:",
      "    - node --version",
      "tasks:",
      "  - id: P1-T1",
      "    type: feature",
      "    ambiguity: low",
      "    risk: low",
      "    context_size: small",
      "    write_surface: low",
      "    verification_strength: medium",
      "    expected_duration: short",
      "    status: planned",
      "    description: Test task",
      "",
    ].join("\n"),
    "utf8",
  );

  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "--quiet"], { cwd });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--quiet", "--allow-empty", "-m", "initial"], { cwd });
}

async function currentHead(): Promise<string> {
  const { execSync } = await import("node:child_process");
  return execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();
}

describe("runCiParity", () => {
  it("passes when manifest matches HEAD and statuses are success", async () => {
    await setupProject();
    const head = await currentHead();
    await writeReviewManifest(cwd, {
      task_id: "P1-T1",
      phase_id: "P1",
      tested_head: head,
      ci_status: "success",
      classifier_result: "success",
      at: new Date().toISOString(),
      actor: "agent",
      agent: "claude-code",
    });

    const result = await runCiParity({ cwd, taskId: "P1-T1" });
    expect(result.kind).toBe("ok");
    expect(result.tested_head).toBe(head);
    expect(result.ci_status).toBe("success");
  });

  it("throws CI_PARITY_HEAD_MISMATCH when HEAD drifted", async () => {
    await setupProject();
    await writeReviewManifest(cwd, {
      task_id: "P1-T1",
      phase_id: "P1",
      tested_head: "0".repeat(40),
      ci_status: "success",
      at: new Date().toISOString(),
      actor: "agent",
      agent: "claude-code",
    });

    await expect(
      runCiParity({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "CI_PARITY_HEAD_MISMATCH" });
  });

  it("throws CI_PARITY_STATUS_MISMATCH when CI is not success", async () => {
    await setupProject();
    const head = await currentHead();
    await writeReviewManifest(cwd, {
      task_id: "P1-T1",
      phase_id: "P1",
      tested_head: head,
      ci_status: "failure",
      at: new Date().toISOString(),
      actor: "agent",
      agent: "claude-code",
    });

    await expect(
      runCiParity({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "CI_PARITY_STATUS_MISMATCH" });
  });

  it("throws CI_PARITY_MANIFEST_MISSING when no manifest exists", async () => {
    await setupProject();
    await expect(
      runCiParity({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "CI_PARITY_MANIFEST_MISSING" });
  });
});
