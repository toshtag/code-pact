// AMBIGUOUS_PHASE_ID integration tests — control-plane v2 PR1a.
//
// A roadmap with a DUPLICATE phase id (e.g. two branches that both minted `P1`
// and merged — separate files, no git conflict) must make phase-id resolution
// fail closed with `AMBIGUOUS_PHASE_ID` (exit 2) across every command, instead
// of silently resolving the first match. A valid (unique-id) project is
// unaffected.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createTempProject,
  ensureCliBuilt,
  expectJsonErr,
} from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let cleanups: Array<() => Promise<void>> = [];

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

const PATH_A = "design/phases/P1-a.yaml";
const PATH_B = "design/phases/P1-b.yaml";

function phaseYaml(name: string, taskId: string): string {
  return [
    "id: P1",
    `name: ${name}`,
    "weight: 10",
    "confidence: medium",
    "risk: low",
    "status: planned",
    "objective: |",
    "  Duplicate-id fixture.",
    "definition_of_done:",
    "  - done",
    "verification:",
    "  commands:",
    "    - echo ok",
    "tasks:",
    `  - id: ${taskId}`,
    "    type: feature",
    "    ambiguity: low",
    "    risk: low",
    "    context_size: small",
    "    write_surface: low",
    "    verification_strength: strong",
    "    expected_duration: short",
    "    status: planned",
    "    description: |",
    "      A task.",
    "",
  ].join("\n");
}

/**
 * A project whose roadmap.yaml lists the same id `P1` twice (two distinct
 * files). Task `P1-T1` lives only in P1-a, so task-keyed commands resolve the
 * task uniquely and then hit the phase-id collision (not AMBIGUOUS_TASK_ID).
 */
async function dupPhaseProject(): Promise<Project> {
  const p = await createTempProject({ prefix: "code-pact-ambiguous-phase-" });
  cleanups.push(p.cleanup);
  await mkdir(join(p.dir, "design", "phases"), { recursive: true });
  await writeFile(
    join(p.dir, "design", "roadmap.yaml"),
    [
      "phases:",
      "  - id: P1",
      `    path: ${PATH_A}`,
      "    weight: 10",
      "  - id: P1",
      `    path: ${PATH_B}`,
      "    weight: 10",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(p.dir, PATH_A), phaseYaml("Phase One A", "P1-T1"), "utf8");
  await writeFile(join(p.dir, PATH_B), phaseYaml("Phase One B", "P1-T2"), "utf8");
  return p;
}

describe("AMBIGUOUS_PHASE_ID — phase-id resolution fails closed", () => {
  const cases: Array<{ name: string; args: string[] }> = [
    { name: "pack", args: ["pack", "--phase", "P1", "--task", "P1-T1", "--agent", "claude-code", "--json"] },
    { name: "task prepare", args: ["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"] },
    { name: "phase show", args: ["phase", "show", "P1", "--json"] },
    { name: "verify", args: ["verify", "--phase", "P1", "--task", "P1-T1", "--json"] },
    { name: "recommend", args: ["recommend", "--phase", "P1", "--task", "P1-T1", "--agent", "claude-code", "--json"] },
    { name: "phase reconcile", args: ["phase", "reconcile", "P1", "--json"] },
    { name: "phase runbook", args: ["phase", "runbook", "P1", "--json"] },
  ];

  for (const c of cases) {
    it(`${c.name} → AMBIGUOUS_PHASE_ID (exit 2, data.phases lists both files)`, async () => {
      const p = await dupPhaseProject();
      const res = p.run(c.args);
      expect(res.code).toBe(2);
      const env = expectJsonErr(res, "AMBIGUOUS_PHASE_ID");
      // Machine-readable colliding paths surface in top-level `data` (the
      // documented envelope convention — detail lives in `data`, not `error`).
      expect(env.data).toMatchObject({ phases: [PATH_A, PATH_B] });
    });
  }

  it("does NOT regress a valid (unique-id) project: phase show resolves", async () => {
    const p = await createTempProject({
      prefix: "code-pact-ambiguous-phase-ok-",
      init: ["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--sample-phase", "--json"],
    });
    cleanups.push(p.cleanup);
    const res = p.run(["phase", "show", "TUTORIAL", "--json"]);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});
