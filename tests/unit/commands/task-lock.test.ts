import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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

/**
 * Review-contract YAML for the fixture task, indented for a task entry.
 *
 * `boundary` is the default because the fixture task is a `feature`: minimal
 * mode is restricted to low-risk docs / mechanical_refactor work, so a feature
 * task can only be locked with a full boundary contract. Every ref points at
 * `ref`, which the caller also declares in `writes`, so the ref-coverage rule
 * holds for stage, platform, and evidence entries alike.
 */
function reviewContractLines(
  kind: "boundary" | "minimal",
  ref: string,
): string[] {
  if (kind === "minimal") {
    return [
      "    review_contract:",
      "      version: 1",
      "      mode: minimal",
      "      rationale: Documentation-only change with no executable boundary.",
    ];
  }
  const stage = (name: string, claim: string): string[] => [
    `        - stage: ${name}`,
    "          disposition: in_scope",
    `          claim: ${claim}`,
    "          refs:",
    `            - ${ref}`,
  ];
  return [
    "    review_contract:",
    "      version: 1",
    "      mode: boundary",
    "      stages:",
    ...stage("producer", "The producer emits a stable envelope."),
    ...stage("consumer", "The consumer validates the envelope."),
    ...stage("runner", "The validated command reaches the bounded runner."),
    ...stage("os", "Windows launch semantics are exercised on Windows."),
    ...stage("security", "The authority boundary fails closed."),
    "      platforms:",
    "        - platform: linux",
    "          disposition: required",
    "          level: integration",
    "          refs:",
    `            - ${ref}`,
    "        - platform: macos",
    "          disposition: not_required",
    "          rationale: No macOS-specific behavior changes.",
    "        - platform: windows",
    "          disposition: required",
    "          level: actual_platform",
    "          refs:",
    `            - ${ref}`,
    "      evidence:",
    "        - id: envelope-contract",
    "          claim: Producer and consumer agree on the envelope.",
    "          level: integration",
    "          refs:",
    `            - ${ref}`,
    "        - id: windows-runtime",
    "          claim: The real Windows launch succeeds.",
    "          level: actual_platform",
    "          platform: windows",
    "          refs:",
    `            - ${ref}`,
  ];
}

type SetupOptions = {
  /** Review contract to embed. `"none"` reproduces a pre-P90 task. */
  reviewContract?: "boundary" | "minimal" | "none";
  /** Task type, so a `docs` task can exercise valid minimal mode. */
  taskType?: string;
};

async function setupProject(
  writes?: string[],
  reads?: string[],
  options: SetupOptions = {},
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
  const contractKind = options.reviewContract ?? "boundary";
  if (contractKind !== "none") {
    taskBlock.push(
      ...reviewContractLines(contractKind, writes?.[0] ?? "src/a.ts"),
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
    await setupProject(["src/a.ts"], undefined, { reviewContract: "minimal" });
    await expect(runTaskLock({ cwd, taskId: "P1-T1" })).rejects.toMatchObject({
      code: "TASK_REVIEW_CONTRACT_INVALID",
    });
    expect(await readContractLock(cwd, "P1-T1")).toBeNull();
  });

  it("accepts minimal mode for a low-risk docs task", async () => {
    await setupProject(["docs/example.md"], undefined, {
      reviewContract: "minimal",
      taskType: "docs",
    });
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
    expect(
      lock?.contract.review_contract?.evidence?.map(e => e.id),
    ).toEqual(["envelope-contract", "windows-runtime"]);
  });
});
