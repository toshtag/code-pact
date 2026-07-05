import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProgressEvent } from "../../../../src/core/schemas/progress-event.ts";
import { writePhaseSnapshot } from "../../../../src/core/archive/phase-snapshot.ts";
import {
  validateSnapshotEventEvidence,
  readArchivedTaskIds,
} from "../../../../src/core/archive/snapshot-evidence.ts";
import {
  validateEventPackBinding,
  newSnapshotRawCache,
} from "../../../../src/core/archive/event-pack-binding.ts";
import { readEventPackFiles } from "../../../../src/core/archive/event-pack-reader.ts";
import { readAllProgressEventSources } from "../../../../src/core/progress/all-sources.ts";
import type { LoadedEventFile } from "../../../../src/core/progress/events-io.ts";
import { seedDurableEvents } from "../../../helpers/seed-events.ts";
import {
  buildValidEventPack,
  writeEventPackFile,
} from "../../../helpers/event-pack-fixture.ts";

const NOW = new Date("2026-06-10T00:00:00.000Z");

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
`;

function p1Yaml(taskStatus: "done" | "cancelled"): string {
  return `id: P1
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
    status: ${taskStatus}
`;
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-snapev-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function scaffoldP1(
  taskStatus: "done" | "cancelled",
  progressYaml: string,
  opts?: { attest?: Record<string, { reason: string }> },
): Promise<void> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), p1Yaml(taskStatus), "utf8");
  if (progressYaml.trim()) await seedDurableEvents(cwd, progressYaml);
  const written = await writePhaseSnapshot(cwd, "P1", { now: NOW, attestations: opts?.attest });
  expect(written.kind).toBe("written");
}

const DONE_EVENTS = `events:
  - task_id: P1-T1
    status: started
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P1-T1
    status: done
    at: 2026-06-01T01:00:00.000Z
    actor: agent
`;

describe("validateSnapshotEventEvidence — progress_events resolution", () => {
  it("resolves from loose events → ok", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    const resolved = new Map<string, ProgressEvent>();
    for (const f of sources.looseFiles) resolved.set(f.id, f.event);
    const { result } = await validateSnapshotEventEvidence(cwd, resolved);
    expect(result.ok).toBe(true);
  });

  it("an unresolvable event_id (hand-deleted loose event after archive) → SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    // The snapshot recorded P1-T1's done event_id. Hand-delete every loose event.
    await rm(join(cwd, ".code-pact", "state", "events"), { recursive: true, force: true });
    const { result } = await validateSnapshotEventEvidence(cwd, new Map());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]!.reason).toBe("unresolved");
  });

  it("evidence resolves from a pack after the loose files are gone (provenance via pack)", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    const events = sources.looseFiles.map((f) => f.event);
    const pack = await buildValidEventPack(cwd, "P1", events);
    await writeEventPackFile(cwd, "P1", pack);
    // Remove the loose files — provenance must now come from the pack.
    await rm(join(cwd, ".code-pact", "state", "events"), { recursive: true, force: true });
    const after = await readAllProgressEventSources(cwd, { mode: "strict" });
    const resolved = new Map<string, ProgressEvent>();
    for (const f of after.validatedPackFiles) resolved.set(f.id, f.event);
    const { result } = await validateSnapshotEventEvidence(cwd, resolved);
    expect(result.ok).toBe(true);
    expect(after.validatedPackFiles.length).toBeGreaterThan(0);
  });
});

describe("semantic replay matrix — evidence kind × snapshot status", () => {
  const looseEmpty = new Map<string, LoadedEventFile>();

  async function bindFirstPack() {
    const loaded = (await readEventPackFiles(cwd))[0]!;
    return validateEventPackBinding(cwd, loaded, looseEmpty, newSnapshotRawCache());
  }

  it("attested done + started-only events → PASS", async () => {
    // Attestation is for ABSENT durable history (zero events). Archive with no
    // events + attest, then forge a pack adding a started event (not done).
    await scaffoldP1("done", "", { attest: { "P1-T1": { reason: "verified out of band" } } });
    const started: ProgressEvent = {
      task_id: "P1-T1",
      status: "started",
      at: "2026-06-01T00:00:00.000Z",
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [started]);
    await writeEventPackFile(cwd, "P1", pack);
    // attested done + replay derives `started` (not failed) → non-contradiction → PASS.
    expect(await bindFirstPack()).toEqual([]);
  });

  it("attested done + a later `failed` event → FAIL (contradicts the attestation)", async () => {
    await scaffoldP1("done", "", { attest: { "P1-T1": { reason: "verified" } } });
    const started: ProgressEvent = {
      task_id: "P1-T1",
      status: "started",
      at: "2026-06-01T00:00:00.000Z",
      actor: "agent",
    };
    const failed: ProgressEvent = {
      task_id: "P1-T1",
      status: "failed",
      at: "2026-06-02T00:00:00.000Z",
      actor: "agent",
    };
    const pack = await buildValidEventPack(cwd, "P1", [started, failed]);
    await writeEventPackFile(cwd, "P1", pack);
    const issues = await bindFirstPack();
    expect(issues.some((i) => i.kind === "semantic_replay_conflict")).toBe(true);
  });

  it("design_status cancelled + started-only → PASS", async () => {
    await scaffoldP1("cancelled", `events:
  - task_id: P1-T1
    status: started
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`);
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    const pack = await buildValidEventPack(cwd, "P1", sources.looseFiles.map((f) => f.event));
    await writeEventPackFile(cwd, "P1", pack);
    expect(await bindFirstPack()).toEqual([]);
  });

  it("design_status cancelled + a later `done` → FAIL (contradicts cancelled)", async () => {
    // A cancelled task whose events derive done would trip the producer's
    // cancelled_task_with_done_event gate, so seed started-only at archive time,
    // then forge a pack adding a later done.
    await scaffoldP1("cancelled", `events:
  - task_id: P1-T1
    status: started
    at: 2026-06-01T00:00:00.000Z
    actor: agent
`);
    const done: ProgressEvent = {
      task_id: "P1-T1",
      status: "done",
      at: "2026-06-02T00:00:00.000Z",
      actor: "agent",
    };
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    const pack = await buildValidEventPack(cwd, "P1", [...sources.looseFiles.map((f) => f.event), done]);
    await writeEventPackFile(cwd, "P1", pack);
    const issues = await bindFirstPack();
    expect(issues.some((i) => i.kind === "semantic_replay_conflict")).toBe(true);
  });
});

describe("LEGACY_EVENT_FOR_ARCHIVED_TASK — legacy conflict for an archived task", () => {
  it("a legacy done that's also in loose (consistent) → no conflict", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    // Write a legacy progress.yaml whose events ARE the same as the loose ones.
    await writeFile(join(cwd, ".code-pact", "state", "progress.yaml"), DONE_EVENTS, "utf8");
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    expect(sources.issues).toEqual([]);
  });

  it("a legacy event for the archived task NOT in the durable set → strict throws LEGACY_EVENT_FOR_ARCHIVED_TASK", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    // Legacy adds a later `failed` for P1-T1 (an archived task) absent from loose/pack.
    await writeFile(
      join(cwd, ".code-pact", "state", "progress.yaml"),
      `events:
  - task_id: P1-T1
    status: failed
    at: 2026-06-09T00:00:00.000Z
    actor: agent
`,
      "utf8",
    );
    await expect(
      readAllProgressEventSources(cwd, { mode: "strict" }),
    ).rejects.toMatchObject({ code: "LEGACY_EVENT_FOR_ARCHIVED_TASK" });
  });

  it("lenient mode: the conflicting legacy event is excluded AND an issue is recorded", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    await writeFile(
      join(cwd, ".code-pact", "state", "progress.yaml"),
      `events:
  - task_id: P1-T1
    status: failed
    at: 2026-06-09T00:00:00.000Z
    actor: agent
`,
      "utf8",
    );
    const sources = await readAllProgressEventSources(cwd, { mode: "lenient" });
    expect(sources.issues.some((i) => i.code === "LEGACY_EVENT_FOR_ARCHIVED_TASK")).toBe(true);
    // The conflicting legacy event is NOT in the mergeable set.
    expect(
      sources.mergeableLegacyEvents.some((e) => e.task_id === "P1-T1" && e.status === "failed"),
    ).toBe(false);
  });

  it("readArchivedTaskIds surfaces the snapshot's task ids", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    const { taskIds } = await readArchivedTaskIds(cwd);
    expect(taskIds.has("P1-T1")).toBe(true);
  });

  it("a corrupt snapshot shrinks the archived set → the legacy gate FAILS CLOSED (Finding B)", async () => {
    // Archive P1, then corrupt its snapshot so readArchivedTaskIds skips it and
    // omits P1-T1. A forged legacy event for P1-T1 (not in the durable set) must
    // NOT slip through just because the archived-task set is now incomplete.
    await scaffoldP1("done", DONE_EVENTS);
    await writeFile(
      join(cwd, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt json",
      "utf8",
    );
    await writeFile(
      join(cwd, ".code-pact", "state", "progress.yaml"),
      `events:
  - task_id: P1-T1
    status: failed
    at: 2026-06-09T00:00:00.000Z
    actor: agent
`,
      "utf8",
    );
    // The corrupt snapshot means the archived-task set is incomplete → strict
    // refuses the whole legacy stream rather than admit a possibly-conflicting one.
    await expect(
      readAllProgressEventSources(cwd, { mode: "strict" }),
    ).rejects.toMatchObject({ code: "LEGACY_EVENT_FOR_ARCHIVED_TASK" });
  });

  it("a corrupt snapshot + NO legacy events → no false failure (nothing to gate)", async () => {
    await scaffoldP1("done", DONE_EVENTS);
    await writeFile(
      join(cwd, ".code-pact", "state", "archive", "phases", "P1.json"),
      "{ corrupt json",
      "utf8",
    );
    // No legacy progress.yaml at all → the incomplete-set gate has nothing to gate.
    const sources = await readAllProgressEventSources(cwd, { mode: "strict" });
    expect(sources.issues).toEqual([]);
  });
});

describe("producer durable-only — LEGACY_ONLY_TERMINAL_EVIDENCE", () => {
  it("a done task whose done event exists ONLY in legacy → block legacy_only_terminal_evidence", async () => {
    await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
    await writeFile(join(cwd, "design", "phases", "P1-x.yaml"), p1Yaml("done"), "utf8");
    // Seed the done event ONLY in legacy progress.yaml — never as a loose file.
    await writeFile(join(cwd, ".code-pact", "state", "progress.yaml"), DONE_EVENTS, "utf8");
    const { planPhaseSnapshot } = await import("../../../../src/core/archive/phase-snapshot.ts");
    const plan = await planPhaseSnapshot(cwd, "P1", { now: NOW });
    expect(plan.kind).toBe("ineligible");
    if (plan.kind !== "ineligible") return;
    expect(plan.blocks.some((b) => b.kind === "legacy_only_terminal_evidence")).toBe(true);
  });
});
