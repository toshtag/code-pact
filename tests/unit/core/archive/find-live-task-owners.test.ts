import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findLiveTaskOwnersByTaskId } from "../../../../src/core/archive/event-pack.ts";

// ---------------------------------------------------------------------------
// findLiveTaskOwnersByTaskId — the Layer 3 (G6) delete-time gate that asks
// "does ANY live phase own this task_id?", keyed on tasks[].id, NOT on phase id.
// This file pins the non-destructive discovery; the unlink that consumes it lands
// in a later PR. See design/decisions/event-pack-compaction-rfc.md (G6 deep-dive).
// ---------------------------------------------------------------------------

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

/** A live phase YAML with the given phase id owning the given task ids. */
function phaseYaml(phaseId: string, taskIds: string[]): string {
  const tasks = taskIds
    .map(
      (id) => `  - id: ${id}
    type: feature
${TASK_FIELDS}
    status: in_progress`,
    )
    .join("\n");
  return `id: ${phaseId}
name: ${phaseId} phase
weight: 1
confidence: high
risk: low
status: in_progress
objective: do the thing
definition_of_done:
  - it works
verification:
  commands:
    - pnpm test
tasks:
${tasks}
`;
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-l3-owners-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});
afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

describe("findLiveTaskOwnersByTaskId", () => {
  it("finds the live phase whose task array owns the task_id", async () => {
    await writeFile(join(cwd, "design", "phases", "P1.yaml"), phaseYaml("P1", ["P1-T1", "P1-T2"]), "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "P1-T2");
    expect(res.incomplete).toBeNull();
    expect(res.owners).toEqual([{ phase_id: "P1", phase_path: "design/phases/P1.yaml" }]);
  });

  it("catches a task_id RE-USED under a DIFFERENTLY-named live phase (the P42/P99 hazard)", async () => {
    // The loose event carries task_id T1; its archived phase was P42. A live phase
    // P99 re-uses T1. phaseFileStillPresent('P42') would find nothing, but T1 is
    // still live under P99 — this gate must catch it.
    await writeFile(join(cwd, "design", "phases", "P99.yaml"), phaseYaml("P99", ["T1"]), "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "T1");
    expect(res.incomplete).toBeNull();
    expect(res.owners).toEqual([{ phase_id: "P99", phase_path: "design/phases/P99.yaml" }]);
  });

  it("returns no owner when no live phase claims the task_id", async () => {
    await writeFile(join(cwd, "design", "phases", "P1.yaml"), phaseYaml("P1", ["P1-T1"]), "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "P2-T9");
    expect(res.incomplete).toBeNull();
    expect(res.owners).toEqual([]);
  });

  it("re-checks DUPLICATE_TASK_ID: reports MULTIPLE owners rather than assuming uniqueness", async () => {
    await writeFile(join(cwd, "design", "phases", "P1.yaml"), phaseYaml("P1", ["DUP"]), "utf8");
    await writeFile(join(cwd, "design", "phases", "P2.yaml"), phaseYaml("P2", ["DUP"]), "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "DUP");
    expect(res.incomplete).toBeNull();
    expect(res.owners).toHaveLength(2);
    expect(res.owners.map((o) => o.phase_id).sort()).toEqual(["P1", "P2"]);
  });

  it("returns {owners: [], incomplete: null} when design/phases/ is absent (nothing live)", async () => {
    await rm(join(cwd, "design", "phases"), { recursive: true, force: true });
    const res = await findLiveTaskOwnersByTaskId(cwd, "P1-T1");
    expect(res.owners).toEqual([]);
    expect(res.incomplete).toBeNull();
  });

  it("fails closed on an UNPARSEABLE phase YAML (could be a live owner)", async () => {
    await writeFile(join(cwd, "design", "phases", "broken.yaml"), "id: [not a phase\n  oops:::", "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "P1-T1");
    expect(res.owners).toEqual([]);
    expect(res.incomplete).not.toBeNull();
    expect(res.incomplete).toContain("broken.yaml");
  });

  it("fails closed on a non-Phase YAML that parses but lacks the Phase shape", async () => {
    await writeFile(join(cwd, "design", "phases", "notaphase.yaml"), "hello: world\n", "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "P1-T1");
    expect(res.owners).toEqual([]);
    expect(res.incomplete).not.toBeNull();
  });

  it("ignores non-.yaml files in the dir", async () => {
    await writeFile(join(cwd, "design", "phases", "P1.yaml"), phaseYaml("P1", ["P1-T1"]), "utf8");
    await writeFile(join(cwd, "design", "phases", "README.md"), "# not a phase\n", "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "P1-T1");
    expect(res.incomplete).toBeNull();
    expect(res.owners).toEqual([{ phase_id: "P1", phase_path: "design/phases/P1.yaml" }]);
  });

  it("tolerates a phase with no tasks array (owns nothing)", async () => {
    const noTasks = `id: P3
name: empty
weight: 1
confidence: high
risk: low
status: planned
objective: tbd
definition_of_done:
  - tbd
verification:
  commands:
    - pnpm test
`;
    await writeFile(join(cwd, "design", "phases", "P3.yaml"), noTasks, "utf8");
    const res = await findLiveTaskOwnersByTaskId(cwd, "P3-T1");
    expect(res.incomplete).toBeNull();
    expect(res.owners).toEqual([]);
  });
});
