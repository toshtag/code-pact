import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskLock } from "../../../src/commands/task-lock.ts";
import { readContractLock } from "../../../src/core/contract-lock.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-task-lock-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function setupProject(
  writes?: string[],
  reads?: string[],
): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  const taskBlock: string[] = [
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
  ];
  if (reads && reads.length > 0) {
    taskBlock.push("    reads:");
    for (const r of reads) taskBlock.push(`      - ${r}`);
  }
  if (writes && writes.length > 0) {
    taskBlock.push("    writes:");
    for (const w of writes) taskBlock.push(`      - ${w}`);
  }

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
      ...taskBlock,
      "",
    ].join("\n"),
    "utf8",
  );

  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["init", "--quiet"], { cwd });
  spawnSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd },
  );
}

describe("runTaskLock", () => {
  it("creates a contract lock with declared reads/writes and base_ref=HEAD", async () => {
    await setupProject(["src/a.ts"], ["src/b.ts"]);
    const result = await runTaskLock({ cwd, taskId: "P1-T1" });

    expect(result.kind).toBe("locked");
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.path).toBe(
      join(cwd, ".code-pact", "state", "locks", "P1-T1.yaml"),
    );
    expect(result.plan_sha).toBe(result.base_ref);

    const lock = await readContractLock(cwd, "P1-T1");
    expect(lock).not.toBeNull();
    expect(lock?.writes).toEqual(["src/a.ts"]);
    expect(lock?.reads).toEqual(["src/b.ts"]);
  });

  it("refuses to overwrite an existing lock", async () => {
    await setupProject(["src/a.ts"]);
    await runTaskLock({ cwd, taskId: "P1-T1" });
    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_CONTRACT_LOCK_EXISTS",
    });
  });

  it("resolves a custom --base-ref to a SHA", async () => {
    await setupProject(["src/a.ts"]);
    const result = await runTaskLock({
      cwd,
      taskId: "P1-T1",
      baseRef: "HEAD",
    });
    expect(result.base_ref.length).toBe(40);
  });
});
