import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTaskLock } from "../../../src/commands/task-lock.ts";
import { readContractLock } from "../../../src/core/contract-lock.ts";
import { renderValidReviewContractYaml } from "../../helpers/review-contract.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-task-lock-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

/**
 * A minimal contract written out by hand, for the one case a builder of VALID
 * contracts cannot express: minimal mode on a `feature` task, which the
 * validator must refuse. Every other fixture contract comes from the shared
 * helper.
 */
const RAW_MINIMAL_CONTRACT_LINES: string[] = [
  "    review_contract:",
  "      version: 1",
  "      mode: minimal",
  "      rationale: Documentation-only change with no executable boundary.",
];

type SetupOptions = {
  /**
   * Review contract to embed. `"valid"` asks the shared helper for one the
   * validator accepts (minimal or boundary, whichever the task metadata earns).
   * `"raw_minimal"` is the deliberately wrong one above; `"none"` reproduces a
   * pre-P90 task.
   */
  reviewContract?: "valid" | "raw_minimal" | "none";
  /** Task type, so a `docs` task can exercise valid minimal mode. */
  taskType?: string;
  /** Project rollout policy. Omitted means the field is absent → advisory. */
  reviewContractPolicy?: "advisory" | "required";
};

async function setupProject(
  writes?: string[],
  reads?: string[],
  options: SetupOptions = {},
): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });

  await writeFile(
    join(cwd, ".code-pact", "project.yaml"),
    [
      "name: test",
      "version: 0.1.0",
      "locale: en-US",
      "default_agent: claude-code",
      "agents:",
      "  - name: claude-code",
      "    profile: agent-profiles/claude-code.yaml",
      "    enabled: true",
      ...(options.reviewContractPolicy
        ? [`review_contract_policy: ${options.reviewContractPolicy}`]
        : []),
    ].join("\n") + "\n",
    "utf8",
  );

  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 10\n`,
    "utf8",
  );

  const taskBlock: string[] = [
    "  - id: P1-T1",
    `    type: ${options.taskType ?? "feature"}`,
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
  const contractKind = options.reviewContract ?? "valid";
  if (contractKind === "raw_minimal") {
    taskBlock.push(...RAW_MINIMAL_CONTRACT_LINES);
  } else if (contractKind === "valid") {
    taskBlock.push(
      renderValidReviewContractYaml({
        id: "P1-T1",
        type: options.taskType ?? "feature",
        ambiguity: "low",
        risk: "low",
        write_surface: "low",
        reads,
        writes: writes ?? ["src/a.ts"],
      }).trimEnd(),
    );
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
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], {
    cwd,
  });
  spawnSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
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
    expect(result.base_sha.length).toBe(40);
    expect(result.base_ref).toBe("HEAD");
    expect(result.contract_digest.length).toBe(64);

    const lock = await readContractLock(cwd, "P1-T1");
    expect(lock).not.toBeNull();
    expect(lock?.contract.writes).toEqual(["src/a.ts"]);
    expect(lock?.contract.reads).toEqual(["src/b.ts"]);
  });

  it("refuses to overwrite an existing lock", async () => {
    await setupProject(["src/a.ts"]);
    await runTaskLock({ cwd, taskId: "P1-T1" });
    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_CONTRACT_LOCK_EXISTS",
    });
  });

  it("rejects locking a cancelled task with TASK_CANCELLED", async () => {
    await setupProject(["src/a.ts"]);
    const phasePath = join(cwd, "design", "phases", "P1-foundation.yaml");
    const original = await readFile(phasePath, "utf8");
    await writeFile(
      phasePath,
      original.replace("    status: planned\n", "    status: cancelled\n"),
      "utf8",
    );
    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_CANCELLED",
    });
  });

  it("resolves a custom --base-ref to a SHA", async () => {
    await setupProject(["src/a.ts"]);
    const result = await runTaskLock({
      cwd,
      taskId: "P1-T1",
      baseRef: "HEAD",
    });
    expect(result.base_sha.length).toBe(40);
    expect(result.base_ref).toBe("HEAD");
  });
});

describe("runTaskLock review contract", () => {
  it("still locks a task that declares no review contract", async () => {
    // Migration safety: the missing-contract refusal ships with the rollout
    // policy, not with the field. Until then every task that locked before the
    // field existed keeps locking exactly as it did.
    await setupProject(["src/a.ts"], undefined, { reviewContract: "none" });
    const result = await runTaskLock({ cwd, taskId: "P1-T1" });

    expect(result.kind).toBe("locked");
    const lock = await readContractLock(cwd, "P1-T1");
    expect(lock?.contract.review_contract).toBeUndefined();
  });

  it("refuses minimal mode for a feature task", async () => {
    await setupProject(["src/a.ts"], undefined, {
      reviewContract: "raw_minimal",
    });
    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_REVIEW_CONTRACT_INVALID",
    });
    expect(await readContractLock(cwd, "P1-T1")).toBeNull();
  });

  it("accepts minimal mode for a low-risk docs task", async () => {
    await setupProject(["docs/example.md"], undefined, { taskType: "docs" });
    const result = await runTaskLock({ cwd, taskId: "P1-T1" });
    expect(result.kind).toBe("locked");

    const lock = await readContractLock(cwd, "P1-T1");
    expect(lock?.contract.review_contract?.mode).toBe("minimal");
  });

  it("stores the boundary contract in the lock body", async () => {
    await setupProject(["src/a.ts"]);
    await runTaskLock({ cwd, taskId: "P1-T1" });

    const lock = await readContractLock(cwd, "P1-T1");
    expect(lock?.contract.review_contract?.mode).toBe("boundary");
    expect(lock?.contract.review_contract?.stages).toHaveLength(5);
    expect(lock?.contract.review_contract?.platforms).toHaveLength(3);
    expect(lock?.contract.review_contract?.evidence).not.toHaveLength(0);
  });
});

describe("runTaskLock review_contract_policy", () => {
  it("locks without a contract when the project omits the policy", async () => {
    // The field-absent state an existing project upgrades into. It must stay
    // lockable, or the upgrade strands every task planned before P90.
    await setupProject(["src/a.ts"], undefined, { reviewContract: "none" });
    const result = await runTaskLock({ cwd, taskId: "P1-T1" });

    expect(result.kind).toBe("locked");
  });

  it("locks without a contract under advisory", async () => {
    await setupProject(["src/a.ts"], undefined, {
      reviewContract: "none",
      reviewContractPolicy: "advisory",
    });
    const result = await runTaskLock({ cwd, taskId: "P1-T1" });

    expect(result.kind).toBe("locked");
  });

  it("refuses a missing contract under required and writes no lock", async () => {
    await setupProject(["src/a.ts"], undefined, {
      reviewContract: "none",
      reviewContractPolicy: "required",
    });

    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_REVIEW_CONTRACT_REQUIRED",
      task_id: "P1-T1",
      review_contract_policy: "required",
    });
    expect(await readContractLock(cwd, "P1-T1")).toBeNull();
  });

  it("locks a task that declares a valid contract under required", async () => {
    await setupProject(["src/a.ts"], undefined, {
      reviewContractPolicy: "required",
    });
    const result = await runTaskLock({ cwd, taskId: "P1-T1" });

    expect(result.kind).toBe("locked");
  });

  it("keeps the invalid-contract code under required", async () => {
    // A contract that is present but wrong is a different defect from one that
    // is absent, and the more specific code must win under either policy.
    await setupProject(["src/a.ts"], undefined, {
      reviewContract: "raw_minimal",
      reviewContractPolicy: "required",
    });

    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_REVIEW_CONTRACT_INVALID",
    });
    expect(await readContractLock(cwd, "P1-T1")).toBeNull();
  });
});
