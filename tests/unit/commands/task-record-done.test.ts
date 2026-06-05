import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { runTaskRecordDone } from "../../../src/commands/task-record-done.ts";
import { runTaskComplete } from "../../../src/commands/task-complete.ts";
import { loadMergedProgress } from "../../../src/core/progress/io.ts";

// ---------------------------------------------------------------------------
// Minimal project fixture. record-done never runs verification commands, so
// the phase deliberately uses a FAILING command ("false") in most tests to
// prove that record-done ignores it (task complete would fail on the same
// fixture). Phase.verification.commands is min(1), so there is always one.
// ---------------------------------------------------------------------------

const ROADMAP_YAML = `phases:
  - id: P1
    path: design/phases/P1-foundation.yaml
    weight: 12
`;

const PROJECT_YAML = (defaultAgent = "claude-code", agents = ["claude-code"]) =>
  [
    "name: project-test",
    "version: 0.1.0",
    "locale: en-US",
    `default_agent: ${defaultAgent}`,
    "agents:",
    ...agents.flatMap((a) => [
      `  - name: ${a}`,
      `    profile: agent-profiles/${a}.yaml`,
      `    enabled: true`,
    ]),
  ].join("\n") + "\n";

const PROJECT_YAML_WITH_DISABLED = `name: project-test
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

const PHASE_YAML = (
  opts: {
    failingCommand?: boolean;
    status?: string;
    requiresDecision?: boolean;
  } = {},
) =>
  [
    "id: P1",
    "name: Foundation",
    "weight: 12",
    "confidence: high",
    "risk: low",
    "status: planned",
    "objective: test phase",
    "definition_of_done:",
    "  - tests pass",
    "verification:",
    "  commands:",
    // Quote "false" so YAML keeps it a string. The bin "false" exits 1.
    opts.failingCommand ? '    - "false"' : "    - echo ok",
    opts.requiresDecision ? "requires_decision: true" : "",
    "tasks:",
    "  - id: P1-T1",
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: weak",
    "    expected_duration: short",
    `    status: ${opts.status ?? "planned"}`,
  ]
    .filter(Boolean)
    .join("\n") + "\n";

const EMPTY_PROGRESS = `events: []\n`;

async function setupProject(
  dir: string,
  opts: {
    failingCommand?: boolean;
    requiresDecision?: boolean;
    hasAdr?: boolean;
    projectYaml?: string;
    progressYaml?: string;
  } = {},
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    opts.projectYaml ?? PROJECT_YAML(),
    "utf8",
  );
  await writeFile(
    join(dir, ".code-pact", "state", "progress.yaml"),
    opts.progressYaml ?? EMPTY_PROGRESS,
    "utf8",
  );
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP_YAML, "utf8");
  await writeFile(
    join(dir, "design", "phases", "P1-foundation.yaml"),
    PHASE_YAML({
      failingCommand: opts.failingCommand,
      requiresDecision: opts.requiresDecision,
    }),
    "utf8",
  );
  if (opts.hasAdr) {
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-some-decision.md"),
      "# Decision\nSome decision body.\n",
      "utf8",
    );
  }
}

async function readProgress(dir: string) {
  // Merged view (legacy progress.yaml + per-event files).
  const { raw, log } = await loadMergedProgress(dir);
  return { raw, log };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-task-record-done-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — happy path", () => {
  it("appends a done event with source=external and the supplied evidence", async () => {
    await setupProject(dir);
    const fakeNow = () => new Date("2026-05-17T00:00:00+09:00");

    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      agent: "claude-code",
      evidence: ["PR #123"],
      notes: "Already merged",
      now: fakeNow,
    });

    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.task_id).toBe("P1-T1");
    expect(result.phase_id).toBe("P1");
    expect(result.agent).toBe("claude-code");
    expect(result.event.status).toBe("done");
    expect(result.event.actor).toBe("agent");
    expect(result.event.source).toBe("external");
    expect(result.event.evidence).toEqual(["PR #123"]);
    expect(result.event.notes).toBe("Already merged");
    expect(result.event.at).toBe("2026-05-16T15:00:00.000Z");

    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(1);
    expect(log.events[0]!.status).toBe("done");
    expect(log.events[0]!.source).toBe("external");
    expect(log.events[0]!.evidence).toEqual(["PR #123"]);
  });

  it("uses default_agent when agent is omitted", async () => {
    await setupProject(dir);
    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
    });
    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.agent).toBe("claude-code");
  });

  it("preserves existing events when appending", async () => {
    const existing = `events:
  - task_id: P0-T9
    status: done
    at: "2026-05-15T10:00:00+09:00"
    actor: human
    evidence:
      - manual review
`;
    await setupProject(dir, { progressYaml: existing });

    await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
    });

    const { log } = await readProgress(dir);
    expect(log.events).toHaveLength(2);
    expect(log.events[0]!.task_id).toBe("P0-T9");
    expect(log.events[1]!.task_id).toBe("P1-T1");
  });
});

// ---------------------------------------------------------------------------
// The differentiator: record-done does NOT run verification commands
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — does not run verification commands", () => {
  it("succeeds even when verification.commands would fail", async () => {
    await setupProject(dir, { failingCommand: true });
    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
    });
    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.event.source).toBe("external");
  });

  it("task complete fails on the same failing-command fixture (contrast)", async () => {
    await setupProject(dir, { failingCommand: true });
    await expect(
      runTaskComplete({ cwd: dir, taskId: "P1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  });
});

// ---------------------------------------------------------------------------
// Idempotency + transitions
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — idempotency and transitions", () => {
  it("returns already_done on second call and does not append a duplicate", async () => {
    await setupProject(dir);
    await runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["x"] });
    const before = await readProgress(dir);
    expect(before.log.events).toHaveLength(1);

    const second = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["x"],
    });
    expect(second.kind).toBe("already_done");

    const after = await readProgress(dir);
    expect(after.log.events).toHaveLength(1);
  });

  it("failed → done succeeds and appends a done event", async () => {
    const failed = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: failed
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
`;
    await setupProject(dir, { progressYaml: failed });
    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
    });
    expect(result.kind).toBe("done");
    const { log } = await readProgress(dir);
    expect(log.events.map((e) => e.status)).toEqual(["started", "failed", "done"]);
  });

  it("blocked → done is rejected with INVALID_TASK_TRANSITION, progress byte-identical", async () => {
    const blocked = `events:
  - task_id: P1-T1
    status: started
    at: "2026-05-18T09:00:00+00:00"
    actor: agent
    agent: claude-code
  - task_id: P1-T1
    status: blocked
    at: "2026-05-18T10:00:00+00:00"
    actor: agent
    agent: claude-code
    reason: waiting on review
`;
    await setupProject(dir, { progressYaml: blocked });
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    await expect(
      runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["x"] }),
    ).rejects.toMatchObject({ code: "INVALID_TASK_TRANSITION" });
    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — dry run", () => {
  it("returns would_append and leaves progress.yaml byte-identical", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
      dryRun: true,
    });
    expect(result.kind).toBe("dry_run");
    if (result.kind !== "dry_run") throw new Error("type narrow");
    expect(result.would_append.status).toBe("done");
    expect(result.would_append.source).toBe("external");

    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Author attribution (D1)
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — author attribution (D1)", () => {
  let savedAuthor: string | undefined;
  beforeEach(() => {
    savedAuthor = process.env.CODE_PACT_AUTHOR;
    process.env.CODE_PACT_AUTHOR = "Ada Lovelace";
  });
  afterEach(() => {
    if (savedAuthor === undefined) delete process.env.CODE_PACT_AUTHOR;
    else process.env.CODE_PACT_AUTHOR = savedAuthor;
  });

  it("stamps the recorded done event with author", async () => {
    await setupProject(dir);
    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
    });
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.event.author).toBe("Ada Lovelace");
    const { log } = await readProgress(dir);
    expect(log.events.at(-1)?.author).toBe("Ada Lovelace");
  });

  it("dry-run would_append carries author", async () => {
    await setupProject(dir);
    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
      dryRun: true,
    });
    if (result.kind !== "dry_run") throw new Error("type narrow");
    expect(result.would_append.author).toBe("Ada Lovelace");
  });
});

// ---------------------------------------------------------------------------
// Evidence validation (core is the final defense)
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — evidence validation", () => {
  it("rejects an empty evidence array with CONFIG_ERROR before any progress I/O", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    await expect(
      runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: [] }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("rejects whitespace-only evidence with CONFIG_ERROR", async () => {
    await setupProject(dir);
    await expect(
      runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["   "] }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });

  it("rejects a mix of valid and whitespace-only items (blank items are not silently dropped)", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    await expect(
      runTaskRecordDone({
        cwd: dir,
        taskId: "P1-T1",
        evidence: ["PR #123", "   "],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("evidence is validated before project/roadmap is read (missing project still CONFIG_ERROR)", async () => {
    // No setupProject — the dir has no .code-pact/project.yaml. If evidence
    // were validated after loading the project, this would throw ENOENT.
    await expect(
      runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: [] }),
    ).rejects.toMatchObject({ code: "CONFIG_ERROR" });
  });
});

// ---------------------------------------------------------------------------
// Decision gate
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — decision gate", () => {
  it("requires_decision with no ADR → DECISION_REQUIRED, status-aware data, progress byte-identical", async () => {
    await setupProject(dir, { requiresDecision: true, hasAdr: false });
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );

    try {
      await runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["x"] });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { code?: string; data?: Record<string, unknown> };
      expect(e.code).toBe("DECISION_REQUIRED");
      expect(e.data).toBeDefined();
      expect(e.data!.task_id).toBe("P1-T1");
      expect(e.data!.current_resolution).toBe("status-aware");
      expect(e.data!.via).toBe("filename-scan");
      expect(e.data!.expected_pattern).toBe("design/decisions/*P1-T1*.md");
      expect(e.data!.considered).toEqual([]);
      const check = e.data!.decision_check as { name: string; ok: boolean; reason?: string };
      expect(check.name).toBe("decision");
      expect(check.ok).toBe(false);
      expect(check.reason).toBeTruthy();
    }

    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("requires_decision with a no-status ADR → succeeds (backward compat)", async () => {
    // setupProject writes a body-only "# Decision\nSome decision body.\n" — no
    // **Status:** line. Under the lenient rule this still resolves as accepted.
    await setupProject(dir, { requiresDecision: true, hasAdr: true });
    const result = await runTaskRecordDone({
      cwd: dir,
      taskId: "P1-T1",
      evidence: ["PR #123"],
    });
    expect(result.kind).toBe("done");
    if (result.kind !== "done") throw new Error("type narrow");
    expect(result.event.source).toBe("external");
  });

  it("requires_decision with a PROPOSED ADR → DECISION_REQUIRED; considered shows acceptance=blocked", async () => {
    await setupProject(dir, { requiresDecision: true });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(
      join(dir, "design", "decisions", "P1-T1-rfc.md"),
      "**Status:** proposed (unscheduled, 2026-05)\n",
      "utf8",
    );

    try {
      await runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["x"] });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { code?: string; data?: Record<string, unknown> };
      expect(e.code).toBe("DECISION_REQUIRED");
      expect(e.data!.via).toBe("filename-scan");
      expect(e.data!.expected_pattern).toBe("design/decisions/*P1-T1*.md");
      const considered = e.data!.considered as Array<{
        path: string;
        status: string | null;
        accepted: boolean;
        acceptance: string;
      }>;
      expect(considered).toHaveLength(1);
      expect(considered[0]!.acceptance).toBe("blocked");
      expect(considered[0]!.status).toBe("proposed");
      expect(considered[0]!.accepted).toBe(false);
    }
  });

  it("requires_decision with EXPLICIT decision_refs (accepted + proposed) → DECISION_REQUIRED via decision_refs, no expected_pattern", async () => {
    // Same fixture, but with task.decision_refs set in the phase YAML, plus
    // one accepted + one proposed ref. all-must-be-accepted → unresolved.
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      "name: x\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml\n    enabled: true\n",
      "utf8",
    );
    await writeFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "events: []\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 12\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "phases", "P1-foundation.yaml"),
      [
        "id: P1",
        "name: F",
        "weight: 12",
        "confidence: high",
        "risk: low",
        "status: planned",
        "objective: test",
        "definition_of_done:",
        "  - tests pass",
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
        "    verification_strength: weak",
        "    expected_duration: short",
        "    status: planned",
        "    requires_decision: true",
        "    decision_refs:",
        "      - design/decisions/accepted-base.md",
        "      - design/decisions/proposed-risky.md",
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "decisions", "accepted-base.md"),
      "**Status:** accepted (P1, 2026-05)\n",
      "utf8",
    );
    await writeFile(
      join(dir, "design", "decisions", "proposed-risky.md"),
      "**Status:** proposed\n",
      "utf8",
    );

    try {
      await runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["x"] });
      throw new Error("should have thrown");
    } catch (err: unknown) {
      const e = err as Error & { code?: string; data?: Record<string, unknown> };
      expect(e.code).toBe("DECISION_REQUIRED");
      expect(e.data!.via).toBe("decision_refs");
      // expected_pattern is filename-scan specific and must NOT be present.
      expect(e.data!.expected_pattern).toBeUndefined();
      expect(e.data!.declared_decision_refs).toEqual([
        "design/decisions/accepted-base.md",
        "design/decisions/proposed-risky.md",
      ]);
      const considered = e.data!.considered as Array<{
        path: string;
        accepted: boolean;
        acceptance: string;
      }>;
      expect(considered).toHaveLength(2);
      expect(considered.find((c) => c.path.endsWith("accepted-base.md"))!.accepted).toBe(true);
      expect(considered.find((c) => c.path.endsWith("proposed-risky.md"))!.acceptance).toBe("blocked");
    }
  });

  it("requires_decision with an UNSAFE decision_refs ('..' to an accepted ADR outside the repo) → DECISION_REQUIRED, acceptance=unsafe_path, progress unchanged", async () => {
    // The regression this pins: an `accepted` ADR planted OUTSIDE the project
    // root must never satisfy the gate. `decision_refs` carries no schema-level
    // path refinement (task.ts: z.string().min(1)), so an escaping ref reaches
    // the gate — which is fail-closed (never reads it) and reports unsafe_path.
    const outsideDir = await mkdtemp(join(tmpdir(), "code-pact-outside-"));
    try {
      await writeFile(
        join(outsideDir, "outside.md"),
        "**Status:** accepted\n",
        "utf8",
      );
      // Relative path from the project root to the planted file — begins with "..".
      const unsafeRef = relative(dir, join(outsideDir, "outside.md"));
      expect(unsafeRef.startsWith("..")).toBe(true);

      await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
      await mkdir(join(dir, "design", "phases"), { recursive: true });
      await writeFile(
        join(dir, ".code-pact", "project.yaml"),
        "name: x\nversion: 0.1.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml\n    enabled: true\n",
        "utf8",
      );
      await writeFile(
        join(dir, ".code-pact", "state", "progress.yaml"),
        "events: []\n",
        "utf8",
      );
      await writeFile(
        join(dir, "design", "roadmap.yaml"),
        "phases:\n  - id: P1\n    path: design/phases/P1-foundation.yaml\n    weight: 12\n",
        "utf8",
      );
      await writeFile(
        join(dir, "design", "phases", "P1-foundation.yaml"),
        [
          "id: P1",
          "name: F",
          "weight: 12",
          "confidence: high",
          "risk: low",
          "status: planned",
          "objective: test",
          "definition_of_done:",
          "  - tests pass",
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
          "    verification_strength: weak",
          "    expected_duration: short",
          "    status: planned",
          "    requires_decision: true",
          "    decision_refs:",
          `      - ${JSON.stringify(unsafeRef)}`,
        ].join("\n") + "\n",
        "utf8",
      );

      const before = await readFile(
        join(dir, ".code-pact", "state", "progress.yaml"),
        "utf8",
      );
      try {
        await runTaskRecordDone({ cwd: dir, taskId: "P1-T1", evidence: ["x"] });
        throw new Error("should have thrown");
      } catch (err: unknown) {
        const e = err as Error & { code?: string; data?: Record<string, unknown> };
        expect(e.code).toBe("DECISION_REQUIRED");
        expect(e.data!.via).toBe("decision_refs");
        const considered = e.data!.considered as Array<{
          accepted: boolean;
          acceptance: string;
        }>;
        expect(considered).toHaveLength(1);
        expect(considered[0]!.acceptance).toBe("unsafe_path");
        expect(considered[0]!.accepted).toBe(false);
      }
      const after = await readFile(
        join(dir, ".code-pact", "state", "progress.yaml"),
        "utf8",
      );
      expect(after).toBe(before);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Agent / task resolution errors
// ---------------------------------------------------------------------------

describe("runTaskRecordDone — resolution errors", () => {
  it("TASK_NOT_FOUND when no phase has the task", async () => {
    await setupProject(dir);
    await expect(
      runTaskRecordDone({ cwd: dir, taskId: "NOPE-T9", evidence: ["x"] }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("AGENT_NOT_FOUND for an agent not in project.yaml", async () => {
    await setupProject(dir);
    await expect(
      runTaskRecordDone({
        cwd: dir,
        taskId: "P1-T1",
        agent: "missing-agent",
        evidence: ["x"],
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("AGENT_NOT_ENABLED for an agent with enabled: false", async () => {
    await setupProject(dir, { projectYaml: PROJECT_YAML_WITH_DISABLED });
    await expect(
      runTaskRecordDone({
        cwd: dir,
        taskId: "P1-T1",
        agent: "codex",
        evidence: ["x"],
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ENABLED" });
  });

  it("agent validation runs before progress.yaml is touched", async () => {
    await setupProject(dir);
    const before = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    await expect(
      runTaskRecordDone({
        cwd: dir,
        taskId: "P1-T1",
        agent: "missing-agent",
        evidence: ["x"],
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    const after = await readFile(
      join(dir, ".code-pact", "state", "progress.yaml"),
      "utf8",
    );
    expect(after).toBe(before);
  });
});
