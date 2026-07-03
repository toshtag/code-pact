import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  run as cliRun,
  ensureCliBuilt,
  type RunResult,
} from "../helpers/cli.ts";
import { seedDurableEvents } from "../helpers/seed-events.ts";
import { writePhaseSnapshot } from "../../src/core/archive/phase-snapshot.ts";

// When a completed phase's YAML is hand-deleted but its roadmap ref stays AND a
// valid archive snapshot exists, the control plane stays green: an active task in
// another phase that `depends_on` a task of the deleted phase still resolves (from
// the snapshot, not the missing file). Without a valid snapshot, that resolution
// fails closed. The cross-phase `depends_on` into the deleted phase is the
// load-bearing case. (Snapshots are written here via the library API directly.)
// design-docs-ephemeral provenance: the archived-phase reader.

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

// Same as P2_DEP but with NO depends_on (for unreferenced-archived-phase cases that
// must not have a live dep on the archived phase's task).
const P2_NO_DEP = `id: P2
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
  const init = run([
    "init",
    "--non-interactive",
    "--locale",
    "en-US",
    "--agent",
    "claude-code",
    "--json",
  ]);
  if (init.code !== 0)
    throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(
    join(tmpDir, "design", "phases", "P1-x.yaml"),
    opts.p1 ?? P1_DONE,
    "utf8",
  );
  await writeFile(
    join(tmpDir, "design", "phases", "P2-y.yaml"),
    opts.p2 ?? P2_DEP,
    "utf8",
  );
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await seedDurableEvents(tmpDir, opts.progress ?? PROGRESS);
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

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("hand-deleted completed phase with a valid snapshot keeps cross-phase depends_on resolving", () => {
  it("with a valid snapshot → validate / plan lint / analyze --strict + task context/prepare all GREEN", async () => {
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    const lint = run([
      "plan",
      "lint",
      "--include-quality",
      "--strict",
      "--json",
    ]);
    expect(jsonOk(lint)).toBe(true);
    // No false unresolved-dep / orphan-event on the deleted phase's task.
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(jsonOk(analyze)).toBe(true);
    expect(analyze.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");

    // task context / task prepare on the LIVE active task (P2-T1, depends_on the
    // deleted P1-T1): resolution skips the deleted P1, dep satisfaction reads the
    // surviving done event → not blocked. (touch point E)
    expect(
      jsonOk(
        run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]),
      ),
    ).toBe(true);
    const prep = run([
      "task",
      "prepare",
      "P2-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
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
    await writeFile(
      join(tmpDir, "design", "phases", "P2-y.yaml"),
      P2_DEP_CANCELLED,
      "utf8",
    );
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    // EXISTENCE: the cancelled archived id is known → no unresolved-dep / orphan.
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(analyze.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");

    // SATISFACTION: a cancelled dep has no done event → P2-T1 is BLOCKED, exactly
    // as a cancelled LIVE dep would be. The archived index must NOT mark it satisfied.
    const prep = run([
      "task",
      "prepare",
      "P2-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    const parsed = JSON.parse(prep.stdout) as {
      data?: { next_action?: { type?: string }; blocked_by?: string[] };
    };
    expect(parsed.data?.next_action?.type).toBe("wait_for_dependencies");
    expect(parsed.data?.blocked_by ?? []).toContain("P1-T2");
  });

  it("WITHOUT a snapshot → validate / plan lint fail closed with MISSING_PHASE_FILE", async () => {
    await scaffold();
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml")); // no snapshot written

    // A roadmap-referenced phase whose file is gone is MISSING_PHASE_FILE, NOT
    // ORPHAN_PHASE_FILE — doctor/validate now agree with plan lint (the code name
    // matches the condition: "referenced but not present").
    const validate = run(["validate", "--json"]);
    expect(jsonOk(validate)).toBe(false);
    expect(validate.stdout).toContain("MISSING_PHASE_FILE");
    expect(validate.stdout).not.toContain("ORPHAN_PHASE_FILE");

    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(false);
    expect(lint.stdout).toContain("MISSING_PHASE_FILE");
    expect(lint.stdout).not.toContain("ORPHAN_PHASE_FILE");
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
    const parsed = JSON.parse(lint.stdout) as {
      data: { issues: { code: string }[] };
    };
    const invalids = parsed.data.issues.filter(
      i => i.code === "PHASE_SNAPSHOT_INVALID",
    );
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
    await writeFile(
      join(tmpDir, "design", "phases", "P2-y.yaml"),
      P2_COLLIDE,
      "utf8",
    );
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    // Every command that resolves a task / loads plan state shares the throwing
    // path; each must map it to a clean envelope, exit 2 (analyze keeps its exit-1
    // strict-loader convention — checked separately below).
    const exit2: string[][] = [
      ["task", "status", "P1-T1", "--json"],
      ["task", "complete", "P1-T1", "--agent", "claude-code", "--json"],
      [
        "task",
        "record-done",
        "P1-T1",
        "--agent",
        "claude-code",
        "--evidence",
        "x",
        "--json",
      ],
      ["task", "finalize", "P1-T1", "--json"],
      ["task", "runbook", "P1-T1", "--json"],
      ["task", "start", "P1-T1", "--json"],
      ["task", "block", "P1-T1", "--reason", "x", "--json"],
      ["task", "resume", "P1-T1", "--json"],
      ["task", "context", "P1-T1", "--agent", "claude-code", "--json"],
      ["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"],
      // loadPlanState consumers beyond the task family:
      ["status", "--json"],
      ["phase", "runbook", "P2", "--json"],
      ["phase", "next", "P2", "--json"],
      ["phase", "runbook", "--across-phases", "--json"],
    ];
    for (const c of exit2) {
      const r = run(c);
      expect(r.code, `${c.join(" ")} should exit 2, not crash`).toBe(2);
      const parsed = JSON.parse(r.stdout) as {
        ok?: boolean;
        error?: { code?: string };
      };
      expect(parsed.ok, `${c.join(" ")} should be ok:false`).toBe(false);
      expect(
        parsed.error?.code,
        `${c.join(" ")} should map to PHASE_SNAPSHOT_INVALID`,
      ).toBe("PHASE_SNAPSHOT_INVALID");
    }

    // plan analyze surfaces it top-level too, but at its exit-1 failure convention.
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(analyze.code).toBe(1);
    expect(
      (JSON.parse(analyze.stdout) as { error?: { code?: string } }).error?.code,
    ).toBe("PHASE_SNAPSHOT_INVALID");
  });

  it("collision (archived id == live id) → ALL FIVE commands fail closed, none green (blocker-2 + E)", async () => {
    // Snapshot P1 while non-colliding, then drift: make P2's live task ALSO own
    // P1-T1, delete P1. The archived P1-T1 now collides with the live P1-T1.
    await scaffold();
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    const P2_COLLIDE = P2_DEP.replace("id: P2-T1", "id: P1-T1");
    await writeFile(
      join(tmpDir, "design", "phases", "P2-y.yaml"),
      P2_COLLIDE,
      "utf8",
    );
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    // validate (via doctor) + plan lint + plan analyze surface PHASE_SNAPSHOT_INVALID.
    const validate = run(["validate", "--json"]);
    expect(jsonOk(validate)).toBe(false);
    expect(validate.stdout).toContain("PHASE_SNAPSHOT_INVALID");
    expect(jsonOk(run(["plan", "lint", "--strict", "--json"]))).toBe(false);
    expect(jsonOk(run(["plan", "analyze", "--strict", "--json"]))).toBe(false);
    // task context / task prepare must NOT return a green target (E does not bypass).
    const ctx = run([
      "task",
      "context",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(jsonOk(ctx)).toBe(false);
    expect(ctx.stdout).toContain("PHASE_SNAPSHOT_INVALID");
    const prep = run([
      "task",
      "prepare",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
    ]);
    expect(jsonOk(prep)).toBe(false);
    expect(prep.stdout).toContain("PHASE_SNAPSHOT_INVALID");
  });
});

// ---------------------------------------------------------------------------
// UNREFERENCED archived phase (its roadmap ref is GONE, not just its file).
// ---------------------------------------------------------------------------

const ROADMAP_P2_ONLY = `phases:
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;

// Progress with ONLY P2-T1's started event — no P1-T1 done event left behind. Used
// for the "no leftover event" case (the P1-T1 done event is written first so the
// snapshot can capture its terminal evidence, then progress is rewritten to drop it).
const PROGRESS_P2_ONLY = `events:
  - task_id: P2-T1
    status: started
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`;

/** Snapshot P1 while referenced, then archive-remove it: drop its roadmap ref AND
 *  its live file, leaving an UNREFERENCED P1 snapshot on disk. `p2` lets a test set
 *  P2's body; `progressAfter` (optional) replaces the ledger AFTER the snapshot is
 *  taken, e.g. to remove the P1-T1 done event so no orphan event remains. */
async function makeUnreferencedP1(p2: string, progressAfter?: string) {
  await scaffold({ p2 });
  await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
  if (progressAfter !== undefined) {
    // Reset the DURABLE ledger to exactly `progressAfter`: clear the loose event
    // files and re-seed (the durable model has no monolith to overwrite). Used
    // to drop the P1-T1 done event so no orphan remains once the snapshot is
    // also destroyed (a leftover archived-task event is only suppressed while a
    // valid snapshot covers it).
    await rm(join(tmpDir, ".code-pact", "state", "events"), {
      recursive: true,
      force: true,
    });
    await mkdir(join(tmpDir, ".code-pact", "state", "events"), {
      recursive: true,
    });
    await seedDurableEvents(tmpDir, progressAfter);
  }
  await writeFile(
    join(tmpDir, "design", "roadmap.yaml"),
    ROADMAP_P2_ONLY,
    "utf8",
  );
  await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));
}

describe("cross-phase depends_on into an UNREFERENCED archived phase", () => {
  it("valid unreferenced snapshot whose task a live phase depends_on → all GREEN", async () => {
    await makeUnreferencedP1(P2_DEP); // P2-T1 depends_on P1-T1
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    const lint = run([
      "plan",
      "lint",
      "--include-quality",
      "--strict",
      "--json",
    ]);
    expect(jsonOk(lint)).toBe(true);
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(jsonOk(analyze)).toBe(true);
    expect(analyze.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");
    expect(
      jsonOk(
        run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]),
      ),
    ).toBe(true);
    expect(
      jsonOk(
        run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]),
      ),
    ).toBe(true);
    expect(jsonOk(run(["status", "--json"]))).toBe(true);
    expect(jsonOk(run(["phase", "runbook", "P2", "--json"]))).toBe(true);
  });

  // Q4 case (a): corrupt unreferenced snapshot + NO leftover event + NO live dep →
  // the advisory is genuinely inert. The init'd fixture carries unrelated default
  // warnings (ADAPTER_MISSING / BRIEF_MISSING …) so `validate --strict` is not green
  // in the absolute — assert the precise delta: unreferenced-archive discovery
  // introduces NEITHER PHASE_SNAPSHOT_INVALID NOR ORPHAN_PROGRESS_EVENT, and
  // `plan lint --strict` (which here only carries issues relevant to unreferenced
  // archive discovery) stays green with the advisory visible.
  it("(a) corrupt unreferenced snapshot, no event, no dep → no PHASE_SNAPSHOT_INVALID/ORPHAN from validate; plan lint advisory only", async () => {
    // Remove the P1-T1 done event after the snapshot, so no orphan event remains.
    await makeUnreferencedP1(P2_NO_DEP, PROGRESS_P2_ONLY);
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt",
      "utf8",
    );
    const validate = run(["validate", "--strict", "--json"]);
    // doctor emits neither the advisory nor an orphan event for this inert case.
    expect(validate.stdout).not.toContain("PHASE_SNAPSHOT_INVALID");
    expect(validate.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(true); // affects_exit:false advisory never fails --strict
    expect(lint.stdout).toContain("PHASE_SNAPSHOT_INVALID"); // but the advisory IS visible
  });

  // Q4 case (b): corrupt unreferenced snapshot + a LEFTOVER progress event for one of
  // its ids → the snapshot supplies no ids, so that event is a real orphan.
  // validate --strict fails on ORPHAN_PROGRESS_EVENT, NOT on PHASE_SNAPSHOT_INVALID.
  it("(b) corrupt unreferenced snapshot + leftover event → validate --strict fails with ORPHAN_PROGRESS_EVENT (not PHASE_SNAPSHOT_INVALID)", async () => {
    await makeUnreferencedP1(P2_NO_DEP); // keeps the P1-T1 done event
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt",
      "utf8",
    );
    const validate = run(["validate", "--strict", "--json"]);
    expect(jsonOk(validate)).toBe(false);
    expect(validate.stdout).toContain("ORPHAN_PROGRESS_EVENT");
    expect(validate.stdout).not.toContain("PHASE_SNAPSHOT_INVALID"); // doctor never emits it
    // Non-strict validate stays green (the orphan is a warning).
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
  });

  it("unreadable archive dir (a regular file at the path) → no PHASE_SNAPSHOT_INVALID/ORPHAN from validate, no crash; plan lint green", async () => {
    await makeUnreferencedP1(P2_NO_DEP, PROGRESS_P2_ONLY); // no leftover orphan event
    await rm(join(tmpDir, ".code-pact", "state", "archive", "phases"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases"),
      "not a dir",
      "utf8",
    );
    const validate = run(["validate", "--strict", "--json"]);
    expect(validate.code).not.toBe(3); // no crash
    expect(validate.stdout).not.toContain("PHASE_SNAPSHOT_INVALID"); // doctor silent on dir-level
    expect(validate.stdout).not.toContain("ORPHAN_PROGRESS_EVENT");
    expect(jsonOk(run(["plan", "lint", "--strict", "--json"]))).toBe(true);
  });

  type LintIssue = { code: string; severity: string; affects_exit?: boolean };
  const lintIssues = (r: RunResult): LintIssue[] =>
    (JSON.parse(r.stdout) as { data: { issues: LintIssue[] } }).data.issues;

  // FILE-level soft failure + live dep.
  it("(c) corrupt unreferenced snapshot + a live dep on its would-be id → TASK_DEPENDS_ON_UNRESOLVED error; PHASE_SNAPSHOT_INVALID only as the soft advisory", async () => {
    await makeUnreferencedP1(P2_DEP); // P2-T1 depends_on P1-T1
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt",
      "utf8",
    );
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(false);
    const issues = lintIssues(lint);
    // The failure is the live-scoped depends-on ERROR, not the snapshot.
    expect(
      issues.some(
        i => i.code === "TASK_DEPENDS_ON_UNRESOLVED" && i.severity === "error",
      ),
    ).toBe(true);
    // PHASE_SNAPSHOT_INVALID appears ONLY as the affects_exit:false advisory — never as an error.
    expect(
      issues.some(
        i => i.code === "PHASE_SNAPSHOT_INVALID" && i.severity === "error",
      ),
    ).toBe(false);
  });

  // DIRECTORY-level soft failure + live dep (the directory-level soft-failure class the
  // file-level case does not cover): an unreadable archive dir supplies no ids, so a live depends_on
  // into it is a TASK_DEPENDS_ON_UNRESOLVED error (plan lint), NOT a hard
  // PHASE_SNAPSHOT_INVALID. plan analyze does NOT run the depends-on detector.
  it("(d) unreadable archive dir + a live dep → TASK_DEPENDS_ON_UNRESOLVED error (plan lint), no hard PHASE_SNAPSHOT_INVALID", async () => {
    await makeUnreferencedP1(P2_DEP, PROGRESS_P2_ONLY); // P2-T1 depends_on P1-T1, no orphan event
    await rm(join(tmpDir, ".code-pact", "state", "archive", "phases"), {
      recursive: true,
    });
    await writeFile(
      join(tmpDir, ".code-pact", "state", "archive", "phases"),
      "not a dir",
      "utf8",
    );
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(false);
    const issues = lintIssues(lint);
    expect(
      issues.some(
        i => i.code === "TASK_DEPENDS_ON_UNRESOLVED" && i.severity === "error",
      ),
    ).toBe(true);
    expect(
      issues.some(
        i => i.code === "PHASE_SNAPSHOT_INVALID" && i.severity === "error",
      ),
    ).toBe(false);
    // plan analyze does not run the depends-on detector → no TASK_DEPENDS_ON_UNRESOLVED there.
    const analyze = run(["plan", "analyze", "--strict", "--json"]);
    expect(analyze.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
  });

  it("collision (unreferenced task id == live id) → hard PHASE_SNAPSHOT_INVALID across reader commands", async () => {
    // Snapshot P1 while P2 is non-colliding, then rename P2's task to P1-T1 (collides
    // with archived P1-T1) and remove P1's ref/file.
    await scaffold({ p2: P2_NO_DEP });
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    await writeFile(
      join(tmpDir, "design", "phases", "P2-y.yaml"),
      P2_NO_DEP.replace("id: P2-T1", "id: P1-T1"),
      "utf8",
    );
    await writeFile(
      join(tmpDir, "design", "roadmap.yaml"),
      ROADMAP_P2_ONLY,
      "utf8",
    );
    await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));

    // Every public reader path that runs discovery must hard-fail on the collision
    // (pin each — the unreferenced-snapshot discovery path as well as the
    // roadmap-referenced snapshot path).
    for (const cmd of [
      ["validate", "--json"],
      ["plan", "lint", "--strict", "--json"],
      ["plan", "analyze", "--strict", "--json"],
      ["status", "--json"],
      // resolveTaskInRoadmap consumers — P1-T1 is the (now-live) colliding target.
      ["task", "context", "P1-T1", "--agent", "claude-code", "--json"],
      ["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"],
      // loadPlanState consumer over a live phase.
      ["phase", "runbook", "P2", "--json"],
    ]) {
      const r = run(cmd);
      expect(jsonOk(r), `${cmd.join(" ")} must not be ok`).toBe(false);
      expect(
        r.stdout,
        `${cmd.join(" ")} must surface PHASE_SNAPSHOT_INVALID`,
      ).toContain("PHASE_SNAPSHOT_INVALID");
    }
  });

  it("a project with NO archive dir is unaffected (deletes nothing → behaves as before)", async () => {
    await scaffold({ p2: P2_NO_DEP }); // no snapshot ever written
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    expect(jsonOk(run(["plan", "lint", "--strict", "--json"]))).toBe(true);
  });
});
