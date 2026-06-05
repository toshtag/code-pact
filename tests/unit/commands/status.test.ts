import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStatus } from "../../../src/commands/status.ts";

let dir: string;
const ENV = "CODE_PACT_AUTHOR";
let savedEnv: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-status-test-"));
  savedEnv = process.env[ENV];
  delete process.env[ENV];
});
afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
  await rm(dir, { recursive: true, force: true });
});

// A two-phase plan exercising every bucket:
//   P1-T1 done, P1-T2 started (Ada), P1-T3 blocked (Bo)
//   P2-T1 planned, deps [P1-T1] (done) → available
//   P2-T2 planned, deps [P1-T2] (not done) → waiting (dependency)
//   P2-T3 planned, requires_decision, no ADR → waiting (missing decision)
const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1.yaml
    weight: 10
  - id: P2
    path: design/phases/P2.yaml
    weight: 10
`;

function task(id: string, extra = ""): string {
  return [
    `  - id: ${id}`,
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: weak",
    "    expected_duration: short",
    "    status: planned",
    extra,
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

const P1 = `id: P1
name: P1
weight: 10
confidence: high
risk: low
status: planned
objective: phase one objective
definition_of_done:
  - done
verification:
  commands:
    - echo ok
tasks:
${task("P1-T1")}
${task("P1-T2")}
${task("P1-T3")}
`;

const P2 = `id: P2
name: P2
weight: 10
confidence: high
risk: low
status: planned
objective: phase two objective
definition_of_done:
  - done
verification:
  commands:
    - echo ok
tasks:
${task("P2-T1", "    depends_on: [P1-T1]")}
${task("P2-T2", "    depends_on: [P1-T2]")}
${task("P2-T3", "    requires_decision: true")}
`;

const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: "2026-06-01T10:00:00.000Z"
    actor: agent
    agent: claude-code
    author: Ada
    source: loop
  - task_id: P1-T2
    status: started
    at: "2026-06-02T10:00:00.000Z"
    actor: agent
    agent: claude-code
    author: Ada
  - task_id: P1-T3
    status: started
    at: "2026-06-03T09:00:00.000Z"
    actor: agent
    agent: claude-code
    author: Bo
  - task_id: P1-T3
    status: blocked
    at: "2026-06-03T10:00:00.000Z"
    actor: agent
    agent: claude-code
    author: Bo
    reason: waiting on infra
`;

async function setup(opts: { collaborationOff?: boolean } = {}): Promise<void> {
  await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
  await mkdir(join(dir, "design", "phases"), { recursive: true });
  const collab = opts.collaborationOff ? "\ncollaboration:\n  author: off\n" : "\n";
  await writeFile(
    join(dir, ".code-pact", "project.yaml"),
    `name: t\nversion: 1.0.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml${collab}`,
    "utf8",
  );
  await writeFile(join(dir, ".code-pact", "state", "progress.yaml"), PROGRESS, "utf8");
  await writeFile(join(dir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(dir, "design", "phases", "P1.yaml"), P1, "utf8");
  await writeFile(join(dir, "design", "phases", "P2.yaml"), P2, "utf8");
}

describe("runStatus — activity buckets (Collaboration UX D2)", () => {
  it("partitions tasks into in_flight / blocked / available / waiting with author + reasons", async () => {
    await setup();
    const r = await runStatus({ cwd: dir });

    expect(r.filter).toEqual({ mine: false });

    // in_flight: P1-T2 (started, Ada) — author + since carried
    expect(r.in_flight.map((e) => e.task_id).sort()).toEqual(["P1-T2"]);
    expect(r.in_flight[0]?.author).toBe("Ada");
    expect(r.in_flight[0]?.since).toBe("2026-06-02T10:00:00.000Z");

    // blocked: P1-T3 (Bo, reason)
    expect(r.blocked.map((e) => e.task_id)).toEqual(["P1-T3"]);
    expect(r.blocked[0]?.author).toBe("Bo");
    expect(r.blocked[0]?.reason).toBe("waiting on infra");

    // available: P2-T1 (dep P1-T1 done, no decision)
    expect(r.available.map((e) => e.task_id)).toEqual(["P2-T1"]);

    // waiting: P2-T2 (dep not done), P2-T3 (missing decision)
    const waiting = Object.fromEntries(r.waiting.map((w) => [w.task_id, w.reasons]));
    expect(waiting["P2-T2"]).toEqual([{ code: "WAITING_FOR_DEPENDENCY", task_id: "P1-T2" }]);
    expect(waiting["P2-T3"]).toEqual([{ code: "MISSING_DECISION" }]);

    expect(r.totals.tasks).toBe(6);
    expect(r.totals.by_state.done).toBe(1);
    expect(r.totals.by_state.started).toBe(1);
    expect(r.totals.by_state.blocked).toBe(1);
    expect(r.totals.by_state.planned).toBe(3);
  });

  it("--phase restricts to one phase (throws PHASE_NOT_FOUND for an unknown id)", async () => {
    await setup();
    const r = await runStatus({ cwd: dir, phase: "P2" });
    expect(r.in_flight).toEqual([]);
    expect(r.available.map((e) => e.task_id)).toEqual(["P2-T1"]);
    expect(r.totals.tasks).toBe(3);
    await expect(runStatus({ cwd: dir, phase: "P9" })).rejects.toMatchObject({
      code: "PHASE_NOT_FOUND",
    });
  });

  it("--phase fails closed on a duplicate phase id (AMBIGUOUS_PHASE_ID)", async () => {
    // Two roadmap entries + two files both claiming id P2 (a clean-but-wrong
    // merge). --phase P2 must fail closed, not silently union both.
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      "name: t\nversion: 1.0.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml\n",
      "utf8",
    );
    await writeFile(join(dir, ".code-pact", "state", "progress.yaml"), "events: []\n", "utf8");
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P2\n    path: design/phases/P2-a.yaml\n    weight: 10\n  - id: P2\n    path: design/phases/P2-b.yaml\n    weight: 10\n",
      "utf8",
    );
    const body = (name: string) =>
      `id: P2\nname: ${name}\nweight: 10\nconfidence: high\nrisk: low\nstatus: planned\nobjective: phase objective long enough\ndefinition_of_done:\n  - done\nverification:\n  commands:\n    - echo ok\n`;
    await writeFile(join(dir, "design", "phases", "P2-a.yaml"), body("A"), "utf8");
    await writeFile(join(dir, "design", "phases", "P2-b.yaml"), body("B"), "utf8");

    await expect(runStatus({ cwd: dir, phase: "P2" })).rejects.toMatchObject({
      code: "AMBIGUOUS_PHASE_ID",
    });
  });

  it("is read-only — never writes the ledger or design", async () => {
    await setup();
    const { readdir } = await import("node:fs/promises");
    const before = await readdir(join(dir, ".code-pact", "state"));
    await runStatus({ cwd: dir });
    const after = await readdir(join(dir, ".code-pact", "state"));
    expect(after).toEqual(before); // no events/ dir created, nothing written
  });
});

describe("runStatus — MISSING_DECISION.decision_ref points at the blocker", () => {
  async function setupDecisionProject(refs: string[]): Promise<void> {
    await mkdir(join(dir, ".code-pact", "state"), { recursive: true });
    await mkdir(join(dir, "design", "phases"), { recursive: true });
    await mkdir(join(dir, "design", "decisions"), { recursive: true });
    await writeFile(
      join(dir, ".code-pact", "project.yaml"),
      "name: t\nversion: 1.0.0\nlocale: en-US\ndefault_agent: claude-code\nagents:\n  - name: claude-code\n    profile: agent-profiles/claude-code.yaml\n",
      "utf8",
    );
    await writeFile(join(dir, ".code-pact", "state", "progress.yaml"), "events: []\n", "utf8");
    await writeFile(
      join(dir, "design", "roadmap.yaml"),
      "phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n",
      "utf8",
    );
    const refsYaml = refs.map((r) => `      - ${r}`).join("\n");
    await writeFile(
      join(dir, "design", "phases", "P1.yaml"),
      `id: P1\nname: P1\nweight: 10\nconfidence: high\nrisk: low\nstatus: planned\nobjective: phase objective long enough\ndefinition_of_done:\n  - done\nverification:\n  commands:\n    - echo ok\ntasks:\n  - id: P1-T1\n    type: feature\n    ambiguity: low\n    risk: low\n    context_size: small\n    write_surface: low\n    verification_strength: weak\n    expected_duration: short\n    status: planned\n    requires_decision: true\n    decision_refs:\n${refsYaml}\n`,
      "utf8",
    );
    // a.md accepted, b.md proposed (the actual blocker).
    await writeFile(join(dir, "design", "decisions", "a.md"), "# A\n\n**Status:** accepted\n", "utf8");
    await writeFile(join(dir, "design", "decisions", "b.md"), "# B\n\n**Status:** proposed\n", "utf8");
  }

  it("names the first NON-accepted ref, not decision_refs[0]", async () => {
    await setupDecisionProject(["design/decisions/a.md", "design/decisions/b.md"]);
    const r = await runStatus({ cwd: dir });
    const w = r.waiting.find((e) => e.task_id === "P1-T1");
    expect(w?.reasons).toEqual([
      { code: "MISSING_DECISION", decision_ref: "design/decisions/b.md" },
    ]);
  });

  it("omits decision_ref for an unsafe_path ref (structural — not status's job)", async () => {
    await setupDecisionProject(["../escape.md"]);
    const r = await runStatus({ cwd: dir });
    const w = r.waiting.find((e) => e.task_id === "P1-T1");
    expect(w?.reasons).toEqual([{ code: "MISSING_DECISION" }]); // no decision_ref
  });
});

describe("runStatus — --mine filter (D2)", () => {
  it("supported: filters in_flight/blocked to the current author, empties suggestions", async () => {
    await setup();
    process.env[ENV] = "Ada";
    const r = await runStatus({ cwd: dir, mine: true });
    expect(r.filter).toEqual({ mine: true, supported: true, author: "Ada" });
    expect(r.in_flight.map((e) => e.task_id)).toEqual(["P1-T2"]); // Ada's
    expect(r.blocked).toEqual([]); // P1-T3 is Bo's
    expect(r.available).toEqual([]);
    expect(r.waiting).toEqual([]);
  });

  it("unsupported (capture off): AUTHOR_CAPTURE_DISABLED, all buckets empty", async () => {
    await setup({ collaborationOff: true });
    process.env[ENV] = "Ada"; // off wins → still unsupported
    const r = await runStatus({ cwd: dir, mine: true });
    expect(r.filter).toEqual({
      mine: true,
      supported: false,
      reason: "AUTHOR_CAPTURE_DISABLED",
    });
    expect(r.in_flight).toEqual([]);
    expect(r.blocked).toEqual([]);
  });

  it("unsupported (no identity): AUTHOR_UNAVAILABLE", async () => {
    await setup();
    // no CODE_PACT_AUTHOR, not a git repo with user.name → unresolvable
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    try {
      const r = await runStatus({ cwd: dir, mine: true });
      expect(r.filter).toEqual({
        mine: true,
        supported: false,
        reason: "AUTHOR_UNAVAILABLE",
      });
    } finally {
      delete process.env.GIT_CONFIG_GLOBAL;
      delete process.env.GIT_CONFIG_SYSTEM;
    }
  });
});
