import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { writePhaseSnapshot } from "../../src/core/archive/phase-snapshot.ts";

// design-docs-ephemeral A2 (step 4a) — hand-`rm` a COMPLETED phase whose roadmap
// ref stays, with a valid snapshot, and the control plane stays green; without a
// (valid) snapshot it fails closed. Cross-phase depends_on into the deleted phase
// is the load-bearing case. The snapshot is written via the library (no CLI verb
// yet — step 3 is library-only).

let tmpDir: string;
const NOW = new Date("2026-06-10T00:00:00.000Z");

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;

const P1_DONE = `id: P1
name: Foundations
weight: 2
confidence: high
risk: low
status: done
objective: Build the base
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: done
`;

// P2-T1 (active) depends_on P1-T1 (the deleted, completed phase's task).
const P2_DEP = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment of work
definition_of_done:
  - The next increment is implemented and its tests pass
verification:
  commands:
    - pnpm test
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    depends_on:
      - P1-T1
`;

// P1-T1 done; P2-T1 started (so analyze sees no STATUS_DRIFT on the active task).
const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P2-T1
    status: started
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`;

// `init` scaffolds project.yaml / model-profiles / .gitignore / brief etc. so
// `validate` (which delegates to doctor) has a complete project; then overlay our
// roadmap + phases + progress. Without this, validate fails on missing project
// scaffolding unrelated to the archive behavior under test.
async function scaffold(
  opts: { p1?: string; p2?: string; progress?: string } = {},
) {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1-x.yaml"), opts.p1 ?? P1_DONE, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P2-y.yaml"), opts.p2 ?? P2_DEP, "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await writeFile(join(tmpDir, ".code-pact", "state", "progress.yaml"), opts.progress ?? PROGRESS, "utf8");
}

// A P1 with a CANCELLED task (P1-T2). The writer records it via design_status
// evidence (cancellation has no progress-event form).
const P1_CANCELLED = `id: P1
name: Foundations
weight: 2
confidence: high
risk: low
status: done
objective: Build the base
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: done
  - id: P1-T2
    type: docs
${TASK_FIELDS}
    status: cancelled
`;

// P2-T1 (active, started) depends_on the CANCELLED P1-T2.
const P2_DEP_CANCELLED = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment of work
definition_of_done:
  - The next increment is implemented and its tests pass
verification:
  commands:
    - pnpm test
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    depends_on:
      - P1-T2
`;

function jsonOk(r: RunResult): boolean {
  try {
    return (JSON.parse(r.stdout) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  // Empty dir — `init` (in scaffold) creates design/ and .code-pact/.
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-archive-tol-int-"));
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("A2 bare-rm of a completed phase with a cross-phase depends_on", () => {
  it("with a valid snapshot → validate / plan lint / analyze --strict + task context/prepare all GREEN", async () => {
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    const lint = run(["plan", "lint", "--include-quality", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(true);
    // No false unresolved-dep / orphan-event on the deleted phase's task.
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(jsonOk(analyze)).toBe(true);
    expect(analyze.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");

    // task context / task prepare on the LIVE active task (P2-T1, depends_on the
    // deleted P1-T1): resolution skips the deleted P1, dep satisfaction reads the
    // surviving done event → not blocked. (touch point E)
    expect(jsonOk(run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
    const prep = run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]);
    expect(jsonOk(prep)).toBe(true);
    // depends_on P1-T1 is satisfied from the surviving event → not wait_for_dependencies.
    expect(prep.stdout).not.toContain("wait_for_dependencies");
  });

  it("archived CANCELLED dep → KNOWN (no false errors) but NOT satisfied (existence != satisfaction)", async () => {
    // The writer refuses to snapshot a phase an ACTIVE task depends_on via a non-done
    // task, so set it up the only way it can legitimately arise: snapshot P1 (which
    // contains the cancelled P1-T2) while P2-T1 depends on the DONE P1-T1 (eligible),
    // THEN re-point P2-T1's dep to the cancelled P1-T2 and delete P1. The tolerated
    // snapshot now carries the cancelled P1-T2 as a known-but-unsatisfiable dep.
    await scaffold({ p1: P1_CANCELLED, p2: P2_DEP });
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    await writeFile(join(tmpDir, "design", "phases", "P2-y.yaml"), P2_DEP_CANCELLED, "utf8");
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    // EXISTENCE: the cancelled archived id is known → no unresolved-dep / orphan.
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(analyze.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");

    // SATISFACTION: a cancelled dep has no done event → P2-T1 is BLOCKED, exactly
    // as a cancelled LIVE dep would be. The archived index must NOT mark it satisfied.
    const prep = run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]);
    const parsed = JSON.parse(prep.stdout) as {
      data?: { next_action?: { type?: string }; blocked_by?: string[] };
    };
    expect(parsed.data?.next_action?.type).toBe("wait_for_dependencies");
    expect(parsed.data?.blocked_by ?? []).toContain("P1-T2");
  });

  it("WITHOUT a snapshot → validate / plan lint fail closed (MISSING/ORPHAN phase)", async () => {
    await scaffold();
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml")); // no snapshot written

    expect(jsonOk(run(["validate", "--json"]))).toBe(false);
    expect(jsonOk(run(["plan", "lint", "--strict", "--json"]))).toBe(false);
  });

  it("deleted phase + corrupt snapshot → exactly ONE PHASE_SNAPSHOT_INVALID in plan lint (no duplicate)", async () => {
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt",
      "utf8",
    );
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(false);
    const parsed = JSON.parse(lint.stdout) as { data: { issues: { code: string }[] } };
    const invalids = parsed.data.issues.filter((i) => i.code === "PHASE_SNAPSHOT_INVALID");
    expect(invalids).toHaveLength(1);
  });

  it("live phase present + corrupt snapshot on disk → still GREEN (live-wins, snapshot ignored)", async () => {
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    // Corrupt the snapshot but KEEP the live P1 file.
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt",
      "utf8",
    );
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    expect(jsonOk(run(["plan", "lint", "--strict", "--json"]))).toBe(true);
  });

  it("collision → EVERY task command returns a clean PHASE_SNAPSHOT_INVALID envelope (exit 2), never INTERNAL_ERROR/crash", async () => {
    // resolveTaskInRoadmap is shared by all task-* commands, so the new throw must
    // surface as a clean control-plane error from each, not crash (exit 3).
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    const P2_COLLIDE = P2_DEP.replace("id: P2-T1", "id: P1-T1");
    await writeFile(join(tmpDir, "design", "phases", "P2-y.yaml"), P2_COLLIDE, "utf8");
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    const cmds: string[][] = [
      ["task", "status", "P1-T1", "--json"],
      ["task", "complete", "P1-T1", "--agent", "claude-code", "--json"],
      ["task", "record-done", "P1-T1", "--agent", "claude-code", "--evidence", "x", "--json"],
      ["task", "finalize", "P1-T1", "--json"],
      ["task", "runbook", "P1-T1", "--json"],
      ["task", "start", "P1-T1", "--json"],
      ["task", "context", "P1-T1", "--agent", "claude-code", "--json"],
      ["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"],
    ];
    for (const c of cmds) {
      const r = run(c);
      expect(r.code, `${c.join(" ")} should exit 2, not crash`).toBe(2);
      const parsed = JSON.parse(r.stdout) as { ok?: boolean; error?: { code?: string } };
      expect(parsed.ok, `${c.join(" ")} should be ok:false`).toBe(false);
      expect(parsed.error?.code, `${c.join(" ")} should map to PHASE_SNAPSHOT_INVALID`).toBe(
        "PHASE_SNAPSHOT_INVALID",
      );
    }
  });

  it("collision (archived id == live id) → ALL FIVE commands fail closed, none green (blocker-2 + E)", async () => {
    // Snapshot P1 while non-colliding, then drift: make P2's live task ALSO own
    // P1-T1, delete P1. The archived P1-T1 now collides with the live P1-T1.
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    const P2_COLLIDE = P2_DEP.replace("id: P2-T1", "id: P1-T1");
    await writeFile(join(tmpDir, "design", "phases", "P2-y.yaml"), P2_COLLIDE, "utf8");
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    // validate (via doctor) + plan lint + plan analyze surface PHASE_SNAPSHOT_INVALID.
    const validate = run(["validate", "--json"]);
    expect(jsonOk(validate)).toBe(false);
    expect(validate.stdout).toContain("PHASE_SNAPSHOT_INVALID");
    expect(jsonOk(run(["plan", "lint", "--strict", "--json"]))).toBe(false);
    expect(jsonOk(run(["plan", "analyze", "--strict", "--json"]))).toBe(false);
    // task context / task prepare must NOT return a green target (E does not bypass).
    const ctx = run(["task", "context", "P1-T1", "--agent", "claude-code", "--json"]);
    expect(jsonOk(ctx)).toBe(false);
    expect(ctx.stdout).toContain("PHASE_SNAPSHOT_INVALID");
    const prep = run(["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"]);
    expect(jsonOk(prep)).toBe(false);
    expect(prep.stdout).toContain("PHASE_SNAPSHOT_INVALID");
  });
});
