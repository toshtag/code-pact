import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyPhaseLifecycle } from "../../../src/core/review-bundle-phase-lifecycle.ts";
import type { ProgressEvent } from "../../../src/core/schemas/progress-event.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-lifecycle-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
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

async function commitPhase(name: string, content: string): Promise<void> {
  await writeFile(join(cwd, "design", "phases", name), content, "utf8");
  git(["add", `design/phases/${name}`]);
  git(["commit", "--quiet", "-m", name]);
}

function baseSha(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return r.stdout.trim();
}

function phasePath(name: string): string {
  return `design/phases/${name}`;
}

function basePhase(): string {
  return [
    "id: P1",
    "name: Foundation",
    "weight: 10",
    "confidence: medium",
    "risk: low",
    "status: in_progress",
    "objective: Test phase",
    "definition_of_done:",
    "  - All tasks done",
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
    "    status: planned",
    "    description: First task",
    "    writes:",
    "      - src/example.ts",
  ].join("\n");
}

function makeEvents(
  taskId: string,
  status: "started" | "done" = "done",
): ProgressEvent[] {
  const events: ProgressEvent[] = [
    {
      task_id: taskId,
      status: "started",
      at: "2026-05-19T10:00:00.000Z",
      actor: "agent",
      agent: "claude-code",
    },
  ];
  if (status === "done") {
    events.push({
      task_id: taskId,
      status: "done",
      at: "2026-05-19T11:00:00.000Z",
      actor: "agent",
      agent: "claude-code",
    });
  }
  return events;
}

describe("classifyPhaseLifecycle", () => {
  it("allows a single task status flip to done when derived state is done", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated = basePhase().replace("status: planned", "status: done");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(true);
    expect(classification.changedFields).toEqual(["tasks[P1-T1].status"]);
  });

  it("allows phase status flip when it matches derived status", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase(
      "P1-foundation.yaml",
      basePhase().replace("status: in_progress", "status: planned"),
    );

    const updated = basePhase()
      .replace("status: in_progress", "status: done")
      .replace("status: planned", "status: done");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(true);
    expect(classification.changedFields).toEqual(["status", "tasks[P1-T1].status"]);
  });

  it("allows multiple task done status updates", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    const twoTasks =
      `${basePhase()}\n` +
      "  - id: P1-T2\n" +
      "    type: feature\n" +
      "    ambiguity: low\n" +
      "    risk: low\n" +
      "    context_size: small\n" +
      "    write_surface: low\n" +
      "    verification_strength: medium\n" +
      "    expected_duration: short\n" +
      "    status: planned\n" +
      "    description: Second task\n" +
      "    writes:\n" +
      "      - src/example2.ts\n";
    await commitPhase("P1-foundation.yaml", twoTasks);

    const updated = twoTasks
      .replace("    status: planned\n    description: First task", "    status: done\n    description: First task")
      .replace("    status: planned\n    description: Second task", "    status: done\n    description: Second task");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const events = [...makeEvents("P1-T1"), ...makeEvents("P1-T2")];
    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events,
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(true);
    expect(classification.changedFields).toEqual([
      "tasks[P1-T1].status",
      "tasks[P1-T2].status",
    ]);
  });

  it("rejects a phase objective change", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated = basePhase().replace(
      "objective: Test phase",
      "objective: Changed objective",
    );
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("objective");
  });

  it("rejects an unrelated task description change", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated = basePhase()
      .replace("status: planned", "status: done")
      .replace("description: First task", "description: Changed task");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("description");
  });

  it("rejects a task writes change", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated = basePhase()
      .replace("status: planned", "status: done")
      .replace("      - src/example.ts", "      - src/example.ts\n      - src/extra.ts");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("writes");
  });

  it("rejects an unknown YAML field addition", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated =
      basePhase().replace("status: planned", "status: done") +
      "\nunknown_field: value";
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("unknown_field");
  });

  it("rejects task reordering", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    const twoTasks =
      `${basePhase()}\n` +
      "  - id: P1-T2\n" +
      "    type: feature\n" +
      "    ambiguity: low\n" +
      "    risk: low\n" +
      "    context_size: small\n" +
      "    write_surface: low\n" +
      "    verification_strength: medium\n" +
      "    expected_duration: short\n" +
      "    status: planned\n" +
      "    description: Second task\n" +
      "    writes:\n" +
      "      - src/example2.ts\n";
    await commitPhase("P1-foundation.yaml", twoTasks);

    const lines = twoTasks.split("\n");
    const t1Start = lines.findIndex((l) => l.startsWith("  - id: P1-T1"));
    const t2Start = lines.findIndex((l) => l.startsWith("  - id: P1-T2"));
    const reordered = [
      ...lines.slice(0, t1Start),
      ...lines.slice(t2Start),
      ...lines.slice(t1Start, t2Start),
    ].join("\n");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      reordered,
      "utf8",
    );

    const events = [...makeEvents("P1-T1"), ...makeEvents("P1-T2")];
    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events,
      derivedPhaseStatus: "done",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("id");
  });

  it("rejects a non-done task status change", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated = basePhase().replace("status: planned", "status: in_progress");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1", "started"),
      derivedPhaseStatus: "in_progress",
    });

    expect(classification.lifecycleOnly).toBe(false);
  });

  it("rejects a task status done without a derived done event", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const updated = basePhase().replace("status: planned", "status: done");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: [],
      derivedPhaseStatus: "planned",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("progress ledger");
  });

  it("rejects a phase status that does not match derived status", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase(
      "P1-foundation.yaml",
      basePhase().replace("status: in_progress", "status: planned"),
    );

    const updated = basePhase()
      .replace("status: in_progress", "status: done")
      .replace("status: planned", "status: done");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      updated,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: makeEvents("P1-T1"),
      derivedPhaseStatus: "in_progress",
    });

    expect(classification.lifecycleOnly).toBe(false);
    expect(classification.reason).toContain("derived status");
  });

  it("ignores key-order-only changes as no semantic change", async () => {
    git(["init", "--quiet", "--initial-branch=main"]);
    await commitPhase("P1-foundation.yaml", basePhase());

    const reordered = [
      "id: P1",
      "status: in_progress",
      "name: Foundation",
      "weight: 10",
      "confidence: medium",
      "risk: low",
      "objective: Test phase",
      "definition_of_done:",
      "  - All tasks done",
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
      "    status: planned",
      "    description: First task",
      "    writes:",
      "      - src/example.ts",
    ].join("\n");
    await writeFile(
      join(cwd, "design", "phases", "P1-foundation.yaml"),
      reordered,
      "utf8",
    );

    const classification = await classifyPhaseLifecycle({
      cwd,
      phasePath: phasePath("P1-foundation.yaml"),
      baseSha: baseSha(),
      events: [],
      derivedPhaseStatus: "in_progress",
    });

    expect(classification.lifecycleOnly).toBe(true);
    expect(classification.changedFields).toEqual([]);
  });
});
