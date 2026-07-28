import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createTaskContractLock,
  assertTaskContractCurrent,
} from "../../../src/core/contract-lock.ts";
import {
  canonicalTaskRegistration,
  taskRegistrationDigest,
} from "../../../src/core/task-registration-spec.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-contract-lock-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function git(args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
}

const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 10
`;

/**
 * The fixture task is a `feature`, so minimal mode is not available to it — the
 * lock gate only accepts a full boundary contract. Every ref points at
 * `src/example.ts`, the task's single declared write, so stage, platform, and
 * evidence refs all stay inside the declared scope.
 */
const REVIEW_CONTRACT_LINES: string[] = (() => {
  const stage = (name: string, claim: string): string[] => [
    `        - stage: ${name}`,
    "          disposition: in_scope",
    `          claim: ${claim}`,
    "          refs:",
    "            - src/example.ts",
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
    "            - src/example.ts",
    "        - platform: macos",
    "          disposition: not_required",
    "          rationale: No macOS-specific behavior changes.",
    "        - platform: windows",
    "          disposition: required",
    "          level: actual_platform",
    "          refs:",
    "            - src/example.ts",
    "      evidence:",
    "        - id: envelope-contract",
    "          claim: Producer and consumer agree on the envelope.",
    "          level: integration",
    "          refs:",
    "            - src/example.ts",
    "        - id: windows-runtime",
    "          claim: The real Windows launch succeeds.",
    "          level: actual_platform",
    "          platform: windows",
    "          refs:",
    "            - src/example.ts",
  ];
})();

/** The same contract as an object, for spec digests built in-test. */
function reviewContractObject(): Record<string, unknown> {
  return parseYaml(
    ["review_contract:", ...REVIEW_CONTRACT_LINES.slice(1)]
      .map(line => line.replace(/^ {4}/, ""))
      .join("\n"),
  ).review_contract as Record<string, unknown>;
}

function phaseYaml(
  opts: {
    status?: string;
    requiresDecision?: boolean;
    full?: boolean;
    reviewContract?: boolean;
  } = {},
): string {
  const status = opts.status ?? "planned";
  const requiresDecision =
    opts.requiresDecision === undefined ? true : opts.requiresDecision;
  const emptyArrays = opts.full
    ? [
        "    depends_on: []",
        "    decision_refs: []",
        "    reads: []",
        "    acceptance_refs:",
        "      - design/specs/P1-T1-task-spec.yaml",
      ]
    : [];
  const reviewContract =
    opts.reviewContract === false ? [] : REVIEW_CONTRACT_LINES;
  return [
    "id: P1",
    "name: Foundation",
    "weight: 10",
    "confidence: medium",
    "risk: low",
    "status: planned",
    "objective: test",
    "definition_of_done:",
    "  - ok",
    "verification:",
    "  commands:",
    "    - echo ok",
    "tasks:",
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: medium",
    "    expected_duration: short",
    `    status: ${status}`,
    "    description: test",
    `    requires_decision: ${requiresDecision}`,
    ...emptyArrays,
    "    writes:",
    "      - src/example.ts",
    ...reviewContract,
    "",
  ].join("\n");
}

async function setupProject(
  opts: {
    status?: string;
    requiresDecision?: boolean;
    full?: boolean;
    reviewContract?: boolean;
  } = {},
): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
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
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    "events: []\n",
    "utf8",
  );
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(
    join(cwd, "design", "phases", "P1-foundation.yaml"),
    phaseYaml({
      status: opts.status,
      requiresDecision: opts.requiresDecision,
      full: opts.full,
      reviewContract: opts.reviewContract,
    }),
    "utf8",
  );
  await writeFile(
    join(cwd, "src", "example.ts"),
    "export const x = 1;\n",
    "utf8",
  );

  git(["init", "--quiet"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "init",
  ]);
}

async function mutatePhase(
  replacer: (content: string) => string,
): Promise<void> {
  const phasePath = join(cwd, "design", "phases", "P1-foundation.yaml");
  const content = await readFile(phasePath, "utf8");
  await writeFile(phasePath, replacer(content), "utf8");
  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "mutate",
  ]);
}

async function createLockWithRegistration(
  cwd: string,
): Promise<ReturnType<typeof createTaskContractLock>> {
  const lock = await createTaskContractLock({ cwd, taskId: "P1-T1" });
  // Augment the lock with a registration proof so the post-lock registration
  // drift gate is active. In real usage this is supplied by `task lock --spec-file`.
  const task = {
    id: "P1-T1",
    type: "feature" as const,
    ambiguity: "low" as const,
    risk: "low" as const,
    context_size: "small" as const,
    write_surface: "low" as const,
    verification_strength: "medium" as const,
    expected_duration: "short" as const,
    status: "planned" as const,
    description: "test",
    requires_decision: false,
    writes: ["src/example.ts"],
    review_contract: reviewContractObject(),
  } as unknown as Parameters<typeof taskRegistrationDigest>[1];
  const specDigest = taskRegistrationDigest("P1", task);
  const specCanonical = canonicalTaskRegistration("P1", task);
  const lockPath = join(cwd, ".code-pact", "state", "locks", "P1-T1.yaml");
  const raw = await readFile(lockPath, "utf8");
  const parsed = parseYaml(raw) as Record<string, unknown>;
  parsed.registration = {
    mode: "spec_file",
    spec_digest: specDigest,
    spec_canonical: specCanonical,
  };
  await writeFile(lockPath, stringifyYaml(parsed));
  return lock;
}

describe("assertTaskContractCurrent post-lock drift", () => {
  it("allows status lifecycle changes after lock", async () => {
    await setupProject({ status: "planned", requiresDecision: false });
    const lock = await createLockWithRegistration(cwd);
    expect(lock).toBeDefined();

    await mutatePhase(content =>
      content.replace("    status: planned", "    status: in_progress"),
    );

    const result = await assertTaskContractCurrent({ cwd, taskId: "P1-T1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lock).not.toBeNull();
    }
  });

  it("rejects removal of requires_decision after lock", async () => {
    await setupProject({ status: "planned", requiresDecision: false });
    const lock = await createLockWithRegistration(cwd);
    expect(lock).toBeDefined();

    await mutatePhase(content =>
      content.replace("    requires_decision: false\n", ""),
    );

    await expect(
      assertTaskContractCurrent({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_DRIFT",
      changed_fields: expect.arrayContaining(["requires_decision"]),
    });
  });
});

async function createLockWithSpecFile(cwd: string) {
  await setupProject({
    status: "planned",
    requiresDecision: false,
    full: true,
  });

  const task = {
    id: "P1-T1",
    type: "feature" as const,
    ambiguity: "low" as const,
    risk: "low" as const,
    context_size: "small" as const,
    write_surface: "low" as const,
    verification_strength: "medium" as const,
    expected_duration: "short" as const,
    status: "planned" as const,
    description: "test",
    requires_decision: false,
    depends_on: [] as string[],
    decision_refs: [] as string[],
    reads: [] as string[],
    writes: ["src/example.ts"],
    acceptance_refs: ["design/specs/P1-T1-task-spec.yaml"],
    review_contract: reviewContractObject(),
  } as unknown as Parameters<typeof taskRegistrationDigest>[1];

  const spec = {
    schema_version: 1 as const,
    phase_id: "P1",
    task,
  };

  await mkdir(join(cwd, "design", "specs"), { recursive: true });
  await writeFile(
    join(cwd, "design", "specs", "P1-T1-task-spec.yaml"),
    stringifyYaml(spec),
    "utf8",
  );

  git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--quiet",
    "-m",
    "add spec",
  ]);

  const specDigest = taskRegistrationDigest("P1", task);
  return createTaskContractLock({
    cwd,
    taskId: "P1-T1",
    registration: {
      mode: "spec_file",
      spec_digest: specDigest,
      spec_path: "design/specs/P1-T1-task-spec.yaml",
    },
  });
}

describe("assertTaskContractCurrent spec-file drift (P83-T4)", () => {
  it("passes when the spec file is unchanged after lock", async () => {
    const lock = await createLockWithSpecFile(cwd);
    expect(lock).toBeDefined();

    const result = await assertTaskContractCurrent({
      cwd,
      taskId: "P1-T1",
      requireLock: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects spec file drift after lock", async () => {
    const lock = await createLockWithSpecFile(cwd);
    expect(lock).toBeDefined();

    const specPath = join(cwd, "design", "specs", "P1-T1-task-spec.yaml");
    const raw = await readFile(specPath, "utf8");
    const parsed = parseYaml(raw) as {
      task: { reads?: string[] };
    };
    parsed.task.reads = ["src/extra.ts"];
    await writeFile(specPath, stringifyYaml(parsed), "utf8");
    git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git([
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "mutate spec",
    ]);

    await expect(
      assertTaskContractCurrent({ cwd, taskId: "P1-T1", requireLock: true }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_DRIFT",
      changed_fields: expect.arrayContaining(["registration_spec_file"]),
    });
  });

  it("rejects a missing spec file after lock", async () => {
    const lock = await createLockWithSpecFile(cwd);
    expect(lock).toBeDefined();

    const specPath = join(cwd, "design", "specs", "P1-T1-task-spec.yaml");
    await rm(specPath);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
    git([
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--quiet",
      "-m",
      "delete spec",
    ]);

    await expect(
      assertTaskContractCurrent({ cwd, taskId: "P1-T1", requireLock: true }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_DRIFT",
      changed_fields: expect.arrayContaining(["registration_spec_file"]),
    });
  });
});

describe("createTaskContractLock review contract", () => {
  it("locks a task that declares no review contract", async () => {
    // The missing-contract refusal is deferred to the enforcement stage, so
    // every pre-field task and fixture keeps locking unchanged.
    await setupProject({ requiresDecision: false, reviewContract: false });
    const lock = await createTaskContractLock({ cwd, taskId: "P1-T1" });
    expect(lock.kind).toBe("locked");
  });

  it("refuses a semantically invalid review contract", async () => {
    await setupProject({ requiresDecision: false });
    await mutatePhase(content =>
      content.replace("        - stage: runner\n", "        - stage: producer\n"),
    );
    await expect(
      createTaskContractLock({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({ code: "TASK_REVIEW_CONTRACT_INVALID" });
  });

  it("stores the review contract in the lock body", async () => {
    await setupProject({ requiresDecision: false });
    await createTaskContractLock({ cwd, taskId: "P1-T1" });

    const lockPath = join(cwd, ".code-pact", "state", "locks", "P1-T1.yaml");
    const lock = parseYaml(await readFile(lockPath, "utf8")) as {
      contract: { review_contract?: { mode?: string; stages?: unknown[] } };
    };
    expect(lock.contract.review_contract?.mode).toBe("boundary");
    expect(lock.contract.review_contract?.stages).toHaveLength(5);
  });
});

describe("assertTaskContractCurrent review contract drift", () => {
  it("passes when the review contract is unchanged", async () => {
    await setupProject({ requiresDecision: false });
    await createLockWithRegistration(cwd);

    const result = await assertTaskContractCurrent({ cwd, taskId: "P1-T1" });
    expect(result.ok).toBe(true);
  });

  it("rejects a stage claim edit after lock", async () => {
    await setupProject({ requiresDecision: false });
    await createLockWithRegistration(cwd);

    await mutatePhase(content =>
      content.replace(
        "          claim: The authority boundary fails closed.",
        "          claim: The authority boundary is reviewed by hand.",
      ),
    );

    await expect(
      assertTaskContractCurrent({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_DRIFT",
      changed_fields: ["review_contract"],
    });
  });

  it("rejects a platform disposition downgrade after lock", async () => {
    await setupProject({ requiresDecision: false });
    await createLockWithRegistration(cwd);

    await mutatePhase(content =>
      content.replace(
        [
          "        - platform: windows",
          "          disposition: required",
          "          level: actual_platform",
          "          refs:",
          "            - src/example.ts",
        ].join("\n"),
        [
          "        - platform: windows",
          "          disposition: not_required",
          "          rationale: Reconsidered after lock.",
        ].join("\n"),
      ),
    );

    await expect(
      assertTaskContractCurrent({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_DRIFT",
      changed_fields: expect.arrayContaining(["review_contract"]),
    });
  });

  it("rejects removing the review contract after lock", async () => {
    await setupProject({ requiresDecision: false });
    await createLockWithRegistration(cwd);

    await mutatePhase(content =>
      content.slice(0, content.indexOf("    review_contract:")) + "\n",
    );

    await expect(
      assertTaskContractCurrent({ cwd, taskId: "P1-T1" }),
    ).rejects.toMatchObject({
      code: "TASK_CONTRACT_DRIFT",
      changed_fields: expect.arrayContaining(["review_contract"]),
    });
  });

  it("reads a historical lock that predates the review contract", async () => {
    // A lock written before P90 has no `contract.review_contract`, and the task
    // it locked has none either. Both sides are absent, so the digests agree and
    // the historical lock stays readable and drift-free.
    await setupProject({ requiresDecision: false, reviewContract: false });

    const lockPath = join(cwd, ".code-pact", "state", "locks", "P1-T1.yaml");
    await mkdir(join(cwd, ".code-pact", "state", "locks"), { recursive: true });
    const { buildContract, contractDigest } = await import(
      "../../../src/core/contract-lock.ts"
    );
    const { loadPhase } = await import("../../../src/core/plan/load-phase.ts");
    const phase = await loadPhase(cwd, "design/phases/P1-foundation.yaml");
    const task = phase.tasks!.find(t => t.id === "P1-T1")!;
    const { spawnSync: spawn } = await import("node:child_process");
    const baseSha = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).stdout.trim();
    const blobSha = spawn(
      "git",
      ["rev-parse", `${baseSha}:design/phases/P1-foundation.yaml`],
      { cwd, encoding: "utf8" },
    ).stdout.trim();
    const contract = buildContract(task, phase, baseSha, blobSha);
    const historical = {
      schema_version: 1,
      task_id: "P1-T1",
      phase_id: "P1",
      phase_path: "design/phases/P1-foundation.yaml",
      base_ref: "HEAD",
      base_sha: baseSha,
      phase_blob_sha: blobSha,
      contract_digest: contractDigest(contract),
      contract,
      at: "2026-01-01T00:00:00.000Z",
      actor: "agent",
    };
    await writeFile(lockPath, stringifyYaml(historical), "utf8");

    const result = await assertTaskContractCurrent({ cwd, taskId: "P1-T1" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.lock).not.toBeNull();
  });
});
