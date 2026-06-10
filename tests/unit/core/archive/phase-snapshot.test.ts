import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyPhaseSnapshotPlan,
  planPhaseSnapshot,
  writePhaseSnapshot,
} from "../../../../src/core/archive/phase-snapshot.ts";
import { PhaseSnapshot } from "../../../../src/core/schemas/phase-snapshot.ts";
import { SnapshotTask } from "../../../../src/core/schemas/phase-snapshot.ts";
import { sha256Hex } from "../../../../src/core/archive/paths.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-phasesnap-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

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
  - id: P1-T2
    type: docs
${TASK_FIELDS}
    status: cancelled
`;

const P2_ACTIVE = (dependsOn: string) => `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Next work
definition_of_done:
  - done
verification:
  commands:
    - pnpm test
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    depends_on:
      - ${dependsOn}
`;

const DONE_EVENT_P1T1 = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`;

async function scaffold(opts?: { p2DependsOn?: string; progress?: string; p1?: string }) {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), opts?.p1 ?? P1_DONE, "utf8");
  await writeFile(
    join(cwd, "design", "phases", "P2-y.yaml"),
    P2_ACTIVE(opts?.p2DependsOn ?? "P1-T1"),
    "utf8",
  );
  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    opts?.progress ?? DONE_EVENT_P1T1,
    "utf8",
  );
}

function evidenceOf(record: PhaseSnapshot, taskId: string) {
  const task = record.tasks.find((t: SnapshotTask) => t.id === taskId);
  expect(task).toBeDefined();
  return task!.terminal_evidence;
}

describe("planPhaseSnapshot / writePhaseSnapshot — happy path", () => {
  it("table case 1: no record + live file + eligible → write, with correct evidence kinds", async () => {
    await scaffold();
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;

    const onDisk = PhaseSnapshot.parse(JSON.parse(await readFile(outcome.path, "utf8")));
    expect(onDisk.phase_id).toBe("P1");
    expect(onDisk.phase_status).toBe("done");
    expect(onDisk.weight).toBe(2);
    expect(onDisk.snapshotted_at).toBe(NOW.toISOString());
    expect(onDisk.original_path).toBe("design/phases/P1-x.yaml");
    expect(onDisk.source_sha256).toBe(sha256Hex(P1_DONE));
    // done task → progress_events; cancelled task → design_status (never anything else)
    expect(evidenceOf(onDisk, "P1-T1").kind).toBe("progress_events");
    expect(evidenceOf(onDisk, "P1-T2")).toEqual({
      kind: "design_status",
      observed_status: "cancelled",
      source_field: "tasks[].status",
    });
  });

  it("table case 2: existing record + same source_sha256 → noop_same_source (byte-identical record)", async () => {
    await scaffold();
    const first = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(first.kind).toBe("written");
    const bytes = await readFile((first as { path: string }).path, "utf8");

    const second = await writePhaseSnapshot(cwd, "P1", { now: new Date("2027-01-01T00:00:00Z") });
    expect(second.kind).toBe("noop_same_source");
    expect(await readFile((first as { path: string }).path, "utf8")).toBe(bytes);
  });
});

describe("staleness — live design file wins, default fail, explicit refresh only", () => {
  it("table case 3: existing record + different source_sha256 → ineligible (record_stale), nothing rewritten", async () => {
    await scaffold();
    const first = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(first.kind).toBe("written");
    const bytes = await readFile((first as { path: string }).path, "utf8");

    const edited = P1_DONE.replace("Build the base", "Build the base (edited)");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), edited, "utf8");

    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    const stale = outcome.blocks.find((b) => b.kind === "record_stale");
    expect(stale).toEqual({
      kind: "record_stale",
      existing_source_sha256: sha256Hex(P1_DONE),
      current_source_sha256: sha256Hex(edited),
    });
    expect(await readFile(outcome.path!, "utf8")).toBe(bytes); // untouched
  });

  it("table case 4: explicit refresh with BOTH expected hashes matching → rewrite; plan previews old/new hashes", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    const edited = P1_DONE.replace("Build the base", "Build the base (edited)");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), edited, "utf8");

    const plan = await planPhaseSnapshot(cwd, "P1", {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(P1_DONE),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(plan.kind).toBe("refresh");
    if (plan.kind !== "refresh") return;
    expect(plan.existing_source_sha256).toBe(sha256Hex(P1_DONE));
    expect(plan.current_source_sha256).toBe(sha256Hex(edited));

    const outcome = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(P1_DONE),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(outcome.kind).toBe("written");
    const onDisk = PhaseSnapshot.parse(
      JSON.parse(await readFile((outcome as { path: string }).path, "utf8")),
    );
    expect(onDisk.source_sha256).toBe(sha256Hex(edited));
  });

  it("refresh with a wrong expected hash → refresh_expectation_mismatch, nothing rewritten (no generic force)", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    const edited = P1_DONE.replace("Build the base", "Build the base (edited)");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), edited, "utf8");

    const outcome = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex("not-the-old-content"),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks.some((b) => b.kind === "refresh_expectation_mismatch")).toBe(true);
  });
});

describe("missing live file — the record is read-only authority, never regenerated", () => {
  it("table case 5: live file missing + record exists → noop_record_authoritative (even with refresh)", async () => {
    await scaffold();
    const first = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(first.kind).toBe("written");
    const bytes = await readFile((first as { path: string }).path, "utf8");

    await rm(join(cwd, "design", "phases", "P1-x.yaml"));

    const outcome = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(P1_DONE),
        expected_new_source_sha256: sha256Hex("anything"),
      },
    });
    expect(outcome.kind).toBe("noop_record_authoritative");
    expect(await readFile((first as { path: string }).path, "utf8")).toBe(bytes);
  });

  it("table case 6: live file missing + record missing → ineligible (live_file_missing)", async () => {
    await scaffold();
    await rm(join(cwd, "design", "phases", "P1-x.yaml"));
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toEqual([
      { kind: "live_file_missing", original_path: "design/phases/P1-x.yaml" },
    ]);
  });
});

describe("eligibility — fail closed", () => {
  it("a non-terminal phase is refused", async () => {
    await scaffold({ p1: P1_DONE.replace("status: done\nobjective", "status: in_progress\nobjective") });
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks.some((b) => b.kind === "phase_not_terminal")).toBe(true);
  });

  it("a done task without a derived-done progress state is refused by default (YAML alone is never trusted silently)", async () => {
    await scaffold({ progress: "events: []\n" });
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toContainEqual({
      kind: "task_done_without_done_event",
      task_id: "P1-T1",
    });
  });

  it("an explicit maintainer attestation (reason required) converts that refusal into auditable evidence", async () => {
    await scaffold({ progress: "events: []\n" });
    const outcome = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      attestations: { "P1-T1": { reason: "verified manually before the event ledger existed" } },
    });
    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(evidenceOf(outcome.record, "P1-T1")).toEqual({
      kind: "maintainer_attestation",
      recorded_at: NOW.toISOString(),
      reason: "verified manually before the event ledger existed",
    });
  });

  it("an attestation for a task that does not need one is a block, not a no-op", async () => {
    await scaffold(); // P1-T1 has a done event
    const outcome = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      attestations: { "P1-T1": { reason: "unnecessary" } },
    });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks.some((b) => b.kind === "attestation_not_applicable")).toBe(true);
  });

  it("an attestation for a cancelled task is a block (cancelled is always design_status)", async () => {
    await scaffold();
    const outcome = await writePhaseSnapshot(cwd, "P1", {
      now: NOW,
      attestations: { "P1-T2": { reason: "nope" } },
    });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(
      outcome.blocks.some(
        (b) => b.kind === "attestation_not_applicable" && b.task_id === "P1-T2",
      ),
    ).toBe(true);
  });

  it("an active task depending on this phase's cancelled task is refused (a buried permanent block)", async () => {
    await scaffold({ p2DependsOn: "P1-T2" }); // P1-T2 is cancelled
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toContainEqual({
      kind: "active_dependant_on_non_done_task",
      dependant_task_id: "P2-T1",
      dependant_phase_id: "P2",
      depends_on_task_id: "P1-T2",
    });
  });

  it("an active task depending on this phase's DONE task does not block the snapshot", async () => {
    await scaffold({ p2DependsOn: "P1-T1" });
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("written");
  });

  it("an invalid existing record fails closed (never silently overwritten)", async () => {
    await scaffold();
    await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
    await writeFile(
      join(cwd, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ not json",
      "utf8",
    );
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_invalid");
  });
});

describe("concurrent-writer guard (plan-observed ExpectedState at apply time)", () => {
  it("a record created between plan and apply makes the fresh write THROW, not overwrite", async () => {
    await scaffold();
    const plan = await planPhaseSnapshot(cwd, "P1", { now: NOW });
    expect(plan.kind).toBe("write");
    if (plan.kind !== "write") return;

    // Concurrent writer lands first.
    await mkdir(join(cwd, ".code-pact", "state", "archive", "phases"), { recursive: true });
    await writeFile(plan.path, '{"winner":"other"}\n', "utf8");

    await expect(applyPhaseSnapshotPlan(plan)).rejects.toThrow(/expected absent/);
    expect(await readFile(plan.path, "utf8")).toBe('{"winner":"other"}\n'); // untouched
  });

  it("a record changed between refresh-plan and apply makes the refresh THROW, not overwrite", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    const edited = P1_DONE.replace("Build the base", "Build the base (edited)");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), edited, "utf8");

    const plan = await planPhaseSnapshot(cwd, "P1", {
      now: NOW,
      refresh: {
        expected_old_source_sha256: sha256Hex(P1_DONE),
        expected_new_source_sha256: sha256Hex(edited),
      },
    });
    expect(plan.kind).toBe("refresh");
    if (plan.kind !== "refresh") return;

    await writeFile(plan.path, plan.existing_raw + "\n", "utf8"); // concurrent change
    await expect(applyPhaseSnapshotPlan(plan)).rejects.toThrow(/changed before write/);
  });
});

describe("record identity — a valid-looking record for the wrong target is fail-closed", () => {
  it("a record whose phase_id is not the requested id → record_identity_mismatch (no noop, no overwrite)", async () => {
    await scaffold();
    const first = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(first.kind).toBe("written");
    const recordPath = (first as { path: string }).path;

    const tampered = JSON.parse(await readFile(recordPath, "utf8"));
    tampered.phase_id = "P2"; // still schema-valid, but not OUR record
    await writeFile(recordPath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_identity_mismatch");
  });

  it("a record whose path_sha256 does not cover its own original_path → record_identity_mismatch", async () => {
    await scaffold();
    const first = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    const recordPath = (first as { path: string }).path;

    const tampered = JSON.parse(await readFile(recordPath, "utf8"));
    tampered.original_path = "design/phases/P1-renamed.yaml"; // hash no longer covers it
    await writeFile(recordPath, JSON.stringify(tampered, null, 2) + "\n", "utf8");

    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks[0]?.kind).toBe("record_identity_mismatch");
  });
});

describe("phase id mismatch — roadmap ref id vs YAML id (fresh-write identity)", () => {
  it("roadmap says P1 but the YAML says id: P2 → ineligible phase_id_mismatch, NO record written", async () => {
    await scaffold({ p1: P1_DONE.replace("id: P1\n", "id: P2\n") });
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toEqual([
      {
        kind: "phase_id_mismatch",
        requested_phase_id: "P1",
        roadmap_phase_id: "P1",
        yaml_phase_id: "P2",
        path: "design/phases/P1-x.yaml",
      },
    ]);
    await expect(readFile(outcome.path, "utf8")).rejects.toThrow(); // nothing written
  });

  it("an id-diverged OTHER active phase blocks the dependant scan (never scan an untrusted control doc)", async () => {
    await scaffold();
    // P2's roadmap ref says P2 but its YAML claims P9.
    const p2 = await readFile(join(cwd, "design", "phases", "P2-y.yaml"), "utf8");
    await writeFile(
      join(cwd, "design", "phases", "P2-y.yaml"),
      p2.replace("id: P2\n", "id: P9\n"),
      "utf8",
    );
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toContainEqual({
      kind: "phase_id_mismatch",
      requested_phase_id: "P1",
      roadmap_phase_id: "P2",
      yaml_phase_id: "P9",
      path: "design/phases/P2-y.yaml",
    });
  });
});

describe("status drift — cancelled task with a derived-done progress state", () => {
  it("refuses to freeze a snapshot that would contradict event-derived dependency satisfaction", async () => {
    await scaffold({
      progress: `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P1-T2
    status: done
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`,
    });
    const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
    expect(outcome.kind).toBe("ineligible");
    if (outcome.kind !== "ineligible") return;
    expect(outcome.blocks).toContainEqual({
      kind: "cancelled_task_with_done_event",
      task_id: "P1-T2",
    });
  });
});

describe("active control docs stay fail-closed", () => {
  it("a missing roadmap.yaml THROWS even when a record exists — it is never 'already archived'", async () => {
    await scaffold();
    await writePhaseSnapshot(cwd, "P1", { now: NOW });
    await rm(join(cwd, "design", "roadmap.yaml"));
    await expect(writePhaseSnapshot(cwd, "P1", { now: NOW })).rejects.toThrow();
  });

  it("a phase YAML that is a symlink escaping the project → unsafe_path (never snapshotted)", async () => {
    await scaffold();
    const outside = await mkdtemp(join(tmpdir(), "code-pact-outside-"));
    try {
      await writeFile(join(outside, "evil.yaml"), P1_DONE, "utf8");
      await rm(join(cwd, "design", "phases", "P1-x.yaml"));
      await symlink(join(outside, "evil.yaml"), join(cwd, "design", "phases", "P1-x.yaml"));

      const outcome = await writePhaseSnapshot(cwd, "P1", { now: NOW });
      expect(outcome.kind).toBe("ineligible");
      if (outcome.kind !== "ineligible") return;
      expect(outcome.blocks[0]?.kind).toBe("unsafe_path");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("schema invariants", () => {
  it("design_status evidence on a done task is schema-invalid", () => {
    const parsed = SnapshotTask.safeParse({
      id: "P1-T1",
      status: "done",
      terminal_evidence: {
        kind: "design_status",
        observed_status: "cancelled",
        source_field: "tasks[].status",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("a cancelled task with non-design_status evidence is schema-invalid", () => {
    const parsed = SnapshotTask.safeParse({
      id: "P1-T2",
      status: "cancelled",
      terminal_evidence: { kind: "progress_events", event_ids: [sha256Hex("x")] },
    });
    expect(parsed.success).toBe(false);
  });

  it("a whitespace-only attestation reason is schema-invalid (an audit trail needs a real reason)", () => {
    const parsed = SnapshotTask.safeParse({
      id: "P1-T1",
      status: "done",
      terminal_evidence: {
        kind: "maintainer_attestation",
        recorded_at: NOW.toISOString(),
        reason: "   ",
      },
    });
    expect(parsed.success).toBe(false);
  });

  it("unknown keys are rejected (strict control record — future fields come via a schema_version bump)", () => {
    const parsed = SnapshotTask.safeParse({
      id: "P1-T1",
      status: "done",
      archived_at: NOW.toISOString(), // reserved for step 7, schema v2 — not silently stripped
      terminal_evidence: { kind: "progress_events", event_ids: [sha256Hex("x")] },
    });
    expect(parsed.success).toBe(false);
  });

  it("a planned/in_progress phase_status is schema-invalid (terminal-only by construction)", () => {
    expect(
      PhaseSnapshot.safeParse({
        schema_version: 1,
        phase_id: "P1",
        phase_name: "x",
        original_path: "design/phases/P1-x.yaml",
        phase_status: "in_progress",
        weight: 1,
        snapshotted_at: NOW.toISOString(),
        source_sha256: sha256Hex("a"),
        path_sha256: sha256Hex("b"),
        tasks: [],
      }).success,
    ).toBe(false);
  });
});
