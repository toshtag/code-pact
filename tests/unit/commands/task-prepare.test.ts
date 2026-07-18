import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  runTaskPrepare,
  type TaskPrepareMinimalResult,
  type TaskPrepareFullResult,
} from "../../../src/commands/task-prepare.ts";
import { buildContextPack } from "../../../src/core/pack/index.ts";
import { cmdTask } from "../../../src/cli/commands/task.ts";
import {
  __setAtomicTempTokenForTests,
  __setAtomicWriteFailAfterOpenForTests,
} from "../../../src/io/atomic-text.ts";

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
`;

const PROJECT_YAML = `name: project-test
version: 0.1.0
locale: en-US
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
    enabled: true
  - name: codex
    profile: agent-profiles/codex.yaml
    enabled: false
`;

const AGENT_PROFILE_YAML = `name: claude-code
instruction_filename: CLAUDE.md
context_dir: .context/claude-code
model_map:
  highest_reasoning: claude-opus-4-7
  balanced_coding: claude-sonnet-4-6
  cheap_mechanical: claude-haiku-4-5
`;

const PHASE_YAML = `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
objective: test phase
definition_of_done:
  - tests pass
verification:
  commands:
    - echo ok
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: strong
    expected_duration: short
    status: planned
  - id: P1-T2
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: strong
    expected_duration: short
    status: planned
    depends_on:
      - P1-T1
`;

const PHASE_YAML_WITH_SCOPE = `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
objective: test phase with declared scope
definition_of_done:
  - acceptance criteria met
verification:
  commands:
    - pnpm typecheck
    - pnpm test:unit
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: medium
    verification_strength: strong
    expected_duration: short
    status: planned
    description: task with explicit read write and acceptance scope
    reads:
      - src/commands/task-prepare.ts
      - tests/unit/commands/task-prepare.test.ts
    writes:
      - src/commands/task-prepare.ts
      - tests/unit/commands/task-prepare.test.ts
    acceptance_refs:
      - design/decisions/P1-T1-rfc.md
    requires_decision: true
    decision_refs:
      - design/decisions/P1-T1-rfc.md
`;

const PHASE_YAML_FAILED = `id: P1
name: Foundation
weight: 12
confidence: high
risk: low
status: in_progress
objective: test phase
definition_of_done:
  - tests pass
verification:
  commands:
    - echo ok
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: strong
    expected_duration: short
    status: planned
`;

async function setupProject(
  dir: string,
  opts: { phaseYaml?: string; progressYaml?: string } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, ".code-pact", "agent-profiles"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    PROJECT_YAML,
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "agent-profiles", "claude-code.yaml"),
    AGENT_PROFILE_YAML,
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? "events: []\n",
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    opts.phaseYaml ?? PHASE_YAML,
    "utf8",
  );
  // `buildContextPack` enumerates declared `reads` against the Git index.
  // Most minimal tests do not need it, but byte-reduction tests call it and
  // must not fail on untracked-file resolution.
  execSync("git init -q && git add -A", { cwd: dir });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function atEvent(status: string, reason?: string): string {
  const lines = [
    `  - task_id: P1-T1`,
    `    status: ${status}`,
    `    at: "2026-07-18T12:00:00+09:00"`,
    `    actor: agent`,
    `    agent: claude-code`,
  ];
  if (reason) {
    lines.push(`    reason: ${reason}`);
  }
  if (status === "done") {
    lines.push(`    source: loop`);
  }
  return lines.join("\n");
}

function contextPackPath(dir: string, taskId: string): string {
  return join(dir, ".context", "claude-code", `${taskId}.md`);
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-prepare-"));
});

afterEach(async () => {
  __setAtomicTempTokenForTests(null);
  __setAtomicWriteFailAfterOpenForTests(null);
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function minimalResult(
  result: Awaited<ReturnType<typeof runTaskPrepare>>,
): TaskPrepareMinimalResult {
  expect(result.detail).toBe("minimal");
  return result as TaskPrepareMinimalResult;
}

function fullResult(
  result: Awaited<ReturnType<typeof runTaskPrepare>>,
): TaskPrepareFullResult {
  expect(result.detail).toBe("full");
  return result as TaskPrepareFullResult;
}

// ---------------------------------------------------------------------------
// Minimal mode — stable work order across all states
// ---------------------------------------------------------------------------

describe("runTaskPrepare — minimal mode state matrix", () => {
  it("planned state: start_task with the start command", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );

    expect(result.task.id).toBe("P1-T1");
    expect(result.task.phase_id).toBe("P1");
    expect(result.task.state).toBe("planned");
    expect(result.task.goal).toBe("test phase");
    expect(result.task.read_scope).toEqual([]);
    expect(result.task.write_scope).toEqual([]);
    expect(result.task.done_when).toEqual(["tests pass"]);
    expect(result.task.verify).toEqual(["echo ok"]);
    expect(result.task.decision_required).toBe(false);

    expect(result.next.type).toBe("start_task");
    expect(result.next.command).toBe(
      "code-pact task start P1-T1 --agent claude-code",
    );
    expect(result.more.command).toBe(
      "code-pact task prepare P1-T1 --agent claude-code --detail full --json",
    );
  });

  it.each([
    ["started", "continue_implementation"],
    ["resumed", "continue_implementation"],
  ] as const)(
    "%s state: next action is %s with no command",
    async (status, nextType) => {
      await setupProject(dir, {
        progressYaml: `events:\n${atEvent(status)}`,
      });
      const result = minimalResult(
        await runTaskPrepare({
          cwd: dir,
          taskId: "P1-T1",
          agent: "claude-code",
        }),
      );
      expect(result.task.state).toBe(status);
      expect(result.next.type).toBe(nextType);
      expect(result.next.command).toBeNull();
    },
  );

  it("dependency blocked state: wait_for_dependencies with blocked_by", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T2", agent: "claude-code" }),
    );
    expect(result.task.state).toBe("planned");
    expect(result.next.type).toBe("wait_for_dependencies");
    expect(result.next.command).toBeNull();
    expect(result.blocked_by).toEqual(["P1-T1"]);
  });

  it("manual blocked state: wait_for_dependencies with empty blocked_by", async () => {
    await setupProject(dir, {
      progressYaml: `events:\n${atEvent("blocked", "manual block reason")}`,
    });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.state).toBe("blocked");
    expect(result.next.type).toBe("wait_for_dependencies");
    expect(result.next.command).toBeNull();
    expect(result.blocked_by).toEqual([]);
  });

  it("done state: noop_already_done with no command", async () => {
    await setupProject(dir, {
      progressYaml: `events:\n${atEvent("done")}`,
    });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.state).toBe("done");
    expect(result.next.type).toBe("noop_already_done");
    expect(result.next.command).toBeNull();
  });

  it("failed state: investigate_failure with honest failure summary", async () => {
    await setupProject(dir, {
      progressYaml: `events:\n${atEvent("failed", "pnpm test:unit failed")}`,
    });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.state).toBe("failed");
    expect(result.next.type).toBe("investigate_failure");
    expect(result.next.command).toBeNull();
    expect(result.failure).toEqual({
      summary: "pnpm test:unit failed",
      fingerprint: null,
      command: null,
      exit_code: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Minimal mode — actionable completeness
// ---------------------------------------------------------------------------

describe("runTaskPrepare — minimal mode actionable completeness", () => {
  it("goal comes from task.description when present, else phase.objective", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_WITH_SCOPE });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.goal).toBe(
      "task with explicit read write and acceptance scope",
    );
  });

  it("goal falls back to phase.objective when task.description is absent", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.goal).toBe("test phase");
  });

  it("read_scope, write_scope, done_when, verify, acceptance_refs, and decision state are surfaced unchanged", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_WITH_SCOPE });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );

    expect(result.task.read_scope).toEqual([
      "src/commands/task-prepare.ts",
      "tests/unit/commands/task-prepare.test.ts",
    ]);
    expect(result.task.write_scope).toEqual([
      "src/commands/task-prepare.ts",
      "tests/unit/commands/task-prepare.test.ts",
    ]);
    expect(result.task.done_when).toEqual(["acceptance criteria met"]);
    expect(result.task.verify).toEqual(["pnpm typecheck", "pnpm test:unit"]);
    expect(result.task.acceptance_refs).toEqual([
      "design/decisions/P1-T1-rfc.md",
    ]);
    expect(result.task.decision_required).toBe(true);
    expect(result.task.decision_refs).toEqual([
      "design/decisions/P1-T1-rfc.md",
    ]);
  });

  it("decision_required false omits decision_refs", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.decision_required).toBe(false);
    expect(result.task).not.toHaveProperty("decision_refs");
  });

  it("empty acceptance_refs are omitted", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task).not.toHaveProperty("acceptance_refs");
  });
});

// ---------------------------------------------------------------------------
// Minimal mode — no hidden retrieval or heavy I/O
// ---------------------------------------------------------------------------

describe("runTaskPrepare — minimal mode does not trigger heavy work", () => {
  it("does not build or write a context pack", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result).not.toHaveProperty("context_pack_path");
    expect(result).not.toHaveProperty("context_pack_bytes");
    expect(result).not.toHaveProperty("commands");
    expect(result).not.toHaveProperty("recommendation");
    expect(await fileExists(contextPackPath(dir, "P1-T1"))).toBe(false);
  });

  it("does not read ADR bodies for requires_decision tasks", async () => {
    await setupProject(dir, { phaseYaml: PHASE_YAML_WITH_SCOPE });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.task.decision_required).toBe(true);
    expect(result.task.decision_refs).toEqual([
      "design/decisions/P1-T1-rfc.md",
    ]);
    expect(result).not.toHaveProperty("decision_commitments");
  });

  it("does not surface recommendation or applied_context_budget", async () => {
    await setupProject(dir);
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result).not.toHaveProperty("recommendation");
    expect(result).not.toHaveProperty("applied_context_budget");
    expect(result).not.toHaveProperty("deferred_context");
    expect(result).not.toHaveProperty("commands");
  });

  it("does not search memory or synthesize failure metadata for failed tasks", async () => {
    await setupProject(dir, {
      progressYaml: `events:\n${atEvent("failed", "verify failed")}`,
    });
    const result = minimalResult(
      await runTaskPrepare({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    );
    expect(result.failure?.summary).toBe("verify failed");
    expect(result.failure?.fingerprint).toBeNull();
    expect(result.failure?.command).toBeNull();
    expect(result.failure?.exit_code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full detail compatibility
// ---------------------------------------------------------------------------

describe("runTaskPrepare — full detail compatibility", () => {
  it("--detail full returns the historical contract with recommendation, commands, and context pack", async () => {
    await setupProject(dir);
    const result = fullResult(
      await runTaskPrepare({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        detail: "full",
      }),
    );

    expect(result.current_state).toBe("planned");
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation?.tier).toBe("balanced_coding");
    expect(result.context_pack_path).not.toBeNull();
    expect(result.context_pack_bytes).toBeGreaterThan(0);
    expect(result.commands).toEqual({
      context: "code-pact task context P1-T1 --agent claude-code",
      start: "code-pact task start P1-T1 --agent claude-code",
      verify: "code-pact verify --phase P1 --task P1-T1 --json --detail agent",
      complete:
        "code-pact task complete P1-T1 --agent claude-code --json --detail agent",
      finalize: "code-pact task finalize P1-T1 --write --json",
      "record-done":
        'code-pact task record-done P1-T1 --agent claude-code --evidence "<verification you ran>"',
    });
    expect(await fileExists(result.context_pack_path!)).toBe(true);
  });

  it("explicit budget flags imply full detail", async () => {
    await setupProject(dir);
    const result = fullResult(
      await runTaskPrepare({
        cwd: dir,
        taskId: "P1-T1",
        agent: "claude-code",
        budgetSelection: { kind: "explicit_bytes", budgetBytes: 100000 },
      }),
    );
    expect(result.detail).toBe("full");
    expect(result.recommendation).not.toBeNull();
    expect(result.context_pack_path).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("runTaskPrepare — determinism", () => {
  it("produces byte-identical minimal JSON across repeated calls", async () => {
    await setupProject(dir);
    const first = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    const second = await runTaskPrepare({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
    });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ---------------------------------------------------------------------------
// Byte reduction on fixed fixtures
// ---------------------------------------------------------------------------

describe("runTaskPrepare — minimal byte reduction", () => {
  async function minimalAndFullBytes(
    phaseYaml: string,
    progressYaml?: string,
    taskId = "P1-T1",
  ): Promise<{
    minimalBytes: number;
    fullPrepareBytes: number;
    contextPackBytes: number;
  }> {
    await setupProject(dir, { phaseYaml, progressYaml });
    const minimal = await runTaskPrepare({
      cwd: dir,
      taskId,
      agent: "claude-code",
    });
    const full = await runTaskPrepare({
      cwd: dir,
      taskId,
      agent: "claude-code",
      detail: "full",
    });
    const pack = await buildContextPack({
      cwd: dir,
      phaseId: "P1",
      taskId,
      agentName: "claude-code",
    });

    return {
      minimalBytes: Buffer.byteLength(JSON.stringify(minimal), "utf8"),
      fullPrepareBytes: Buffer.byteLength(JSON.stringify(full), "utf8"),
      contextPackBytes: Buffer.byteLength(pack.content, "utf8"),
    };
  }

  function reduction(smaller: number, larger: number): number {
    return larger === 0 ? 0 : (larger - smaller) / larger;
  }

  it("A. small runtime task: minimal JSON is much smaller than full prepare and context pack", async () => {
    const { minimalBytes, fullPrepareBytes, contextPackBytes } =
      await minimalAndFullBytes(PHASE_YAML);

    const prepareReduction = reduction(minimalBytes, fullPrepareBytes);
    const contextReduction = reduction(minimalBytes, contextPackBytes);

    expect(prepareReduction).toBeGreaterThan(0.3);
    expect(contextReduction).toBeGreaterThan(0.3);
  });

  it("B. declared scope task: minimal JSON stays small even with read/write lists", async () => {
    const { minimalBytes, fullPrepareBytes, contextPackBytes } =
      await minimalAndFullBytes(PHASE_YAML_WITH_SCOPE);

    const prepareReduction = reduction(minimalBytes, fullPrepareBytes);
    const contextReduction = reduction(minimalBytes, contextPackBytes);

    expect(prepareReduction).toBeGreaterThan(0.3);
    expect(contextReduction).toBeGreaterThan(0.3);
  });

  it("C. failed task: minimal JSON is still smaller than full prepare output", async () => {
    const { minimalBytes, fullPrepareBytes, contextPackBytes } =
      await minimalAndFullBytes(
        PHASE_YAML_FAILED,
        `events:\n${atEvent("failed", "unit test failure")}`,
      );

    const prepareReduction = reduction(minimalBytes, fullPrepareBytes);
    expect(prepareReduction).toBeGreaterThan(0.2);
    // Default minimal does not build a pack, so context-pack reduction vs
    // minimal JSON is a less meaningful metric for failed early returns.
    expect(minimalBytes).toBeLessThan(contextPackBytes + 1);
  });

  it("median reduction across fixtures is at least 50%", async () => {
    const a = await minimalAndFullBytes(PHASE_YAML);
    const b = await minimalAndFullBytes(PHASE_YAML_WITH_SCOPE);
    const c = await minimalAndFullBytes(
      PHASE_YAML_FAILED,
      `events:\n${atEvent("failed", "unit test failure")}`,
    );

    const reductions = [
      reduction(a.minimalBytes, a.fullPrepareBytes),
      reduction(b.minimalBytes, b.fullPrepareBytes),
      reduction(c.minimalBytes, c.fullPrepareBytes),
    ].sort((x, y) => x - y);

    const median = reductions[1]!;
    expect(median).toBeGreaterThanOrEqual(0.5);
  });
});

// ---------------------------------------------------------------------------
// CLI output
// ---------------------------------------------------------------------------

describe("cmdTask prepare — default minimal vs full", () => {
  function captureStdout(): { stdout: () => string; restore: () => void } {
    const out: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        out.push(chunk.toString());
        return true;
      });
    return {
      stdout: () => out.join(""),
      restore: () => spy.mockRestore(),
    };
  }

  it("cmd task prepare --json emits the minimal envelope by default", async () => {
    await setupProject(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    const capture = captureStdout();
    try {
      const exit = await cmdTask(
        ["prepare", "P1-T1", "--agent", "claude-code", "--json"],
        "en-US",
        false,
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.stdout());
      expect(parsed.ok).toBe(true);
      expect(parsed.data.detail).toBe("minimal");
      expect(parsed.data.task.id).toBe("P1-T1");
      expect(parsed.data.task.state).toBe("planned");
      expect(parsed.data.next.type).toBe("start_task");
      expect(parsed.data.next.command).toContain("task start");
      expect(parsed.data.more.command).toContain("--detail full");
      expect(parsed.data).not.toHaveProperty("recommendation");
      expect(parsed.data).not.toHaveProperty("commands");
      expect(parsed.data).not.toHaveProperty("context_pack_path");
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }
  });

  it("cmd task prepare --detail full --json returns the full contract", async () => {
    await setupProject(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    const capture = captureStdout();
    try {
      const exit = await cmdTask(
        [
          "prepare",
          "P1-T1",
          "--detail",
          "full",
          "--agent",
          "claude-code",
          "--json",
        ],
        "en-US",
        false,
      );
      expect(exit).toBe(0);
      const parsed = JSON.parse(capture.stdout());
      expect(parsed.ok).toBe(true);
      expect(parsed.data.detail).toBe("full");
      expect(parsed.data.recommendation).toBeDefined();
      expect(parsed.data.commands).toBeDefined();
      expect(parsed.data.context_pack_path).toBeDefined();
      expect(parsed.data.context_pack_bytes).toBeGreaterThan(0);
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }
  });

  it("human-readable default output is a concise work order", async () => {
    await setupProject(dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    const capture = captureStdout();
    try {
      const exit = await cmdTask(
        ["prepare", "P1-T1", "--agent", "claude-code"],
        "en-US",
        false,
      );
      expect(exit).toBe(0);
      const output = capture.stdout();
      expect(output).toContain("Task: P1-T1");
      expect(output).toContain("State: planned");
      expect(output).toContain("Goal: test phase");
      expect(output).toContain("Done when:");
      expect(output).toContain("- tests pass");
      expect(output).toContain("Verify:");
      expect(output).toContain("- echo ok");
      expect(output).toContain("Next: start_task");
      expect(output).toContain("More:");
      expect(output).toContain("--detail full");
      expect(output).not.toContain("Recommendation:");
      expect(output).not.toContain("Commands:");
    } finally {
      capture.restore();
      process.chdir(originalCwd);
    }
  });
});
