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

function phaseYaml(
  opts: { status?: string; requiresDecision?: boolean; full?: boolean } = {},
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
    "",
  ].join("\n");
}

async function setupProject(
  opts: { status?: string; requiresDecision?: boolean; full?: boolean } = {},
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
  };
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
  };

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
