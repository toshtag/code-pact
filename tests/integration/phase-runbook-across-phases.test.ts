// `phase runbook --across-phases` integration tests — v1.9 P19-T3.
//
// Verifies:
//   * Aggregated envelope shape (kind, phases_considered, phases[])
//   * in_progress phases included; done / planned / cancelled excluded
//     unless pulled in by a dep-driven inclusion
//   * Cross-phase dep with unsatisfied source pulls in the declaring phase
//   * --across-phases with no in_progress phases returns empty arrays
//   * Default `phase runbook <id>` invocation unchanged (regression)

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import {
  createTempProject,
  ensureCliBuilt,
  type JsonEnvelope,
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

async function freshProject(prefix: string): Promise<Project> {
  const p = await createTempProject({
    prefix: `code-pact-phase-runbook-across-${prefix}-`,
  });
  cleanups.push(p.cleanup);
  return p;
}

interface PhaseSpec {
  id: string;
  status: "planned" | "in_progress" | "done" | "cancelled";
  tasks: Array<{ id: string; status?: string; depends_on?: string[] }>;
}

async function setupProject(p: Project, phases: PhaseSpec[]): Promise<void> {
  const designDir = join(p.dir, "design");
  const phasesDir = join(designDir, "phases");
  await mkdir(phasesDir, { recursive: true });

  const roadmap = {
    phases: phases.map((spec) => ({
      id: spec.id,
      path: `design/phases/${spec.id}.yaml`,
      weight: 10,
    })),
  };
  await writeFile(join(designDir, "roadmap.yaml"), stringifyYaml(roadmap), "utf8");

  for (const spec of phases) {
    const phase = {
      id: spec.id,
      name: spec.id,
      weight: 10,
      confidence: "medium",
      risk: "medium",
      status: spec.status,
      objective: `Objective for ${spec.id}`,
      definition_of_done: ["x"],
      verification: { commands: ["pnpm test"] },
      tasks: spec.tasks.map((t) => ({
        id: t.id,
        type: "feature",
        ambiguity: "medium",
        risk: "medium",
        context_size: "medium",
        write_surface: "medium",
        verification_strength: "medium",
        expected_duration: "medium",
        status: t.status ?? "planned",
        description: `desc ${t.id}`,
        ...(t.depends_on ? { depends_on: t.depends_on } : {}),
      })),
    };
    await writeFile(
      join(phasesDir, `${spec.id}.yaml`),
      stringifyYaml(phase),
      "utf8",
    );
  }

  const projectYaml = {
    project_name: "test",
    default_locale: "en-US",
    enabled_agents: ["claude-code"],
    default_agent: "claude-code",
  };
  await writeFile(
    join(p.dir, ".code-pact", "project.yaml"),
    stringifyYaml(projectYaml),
    "utf8",
  );
}

interface StrictData {
  kind?: string;
  phases_considered?: string[];
  phases?: Array<{ phase_id: string; kind: string; next_steps: unknown[] }>;
}

describe("phase runbook --across-phases", () => {
  it("aggregates two in_progress phases in id-ascending order", async () => {
    const p = await freshProject("two-in-progress");
    await setupProject(p, [
      { id: "P1", status: "in_progress", tasks: [{ id: "P1-T1" }] },
      { id: "P2", status: "in_progress", tasks: [{ id: "P2-T1" }] },
    ]);

    const res = p.run(["phase", "runbook", "--across-phases", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(true);
    const data = env.data as StrictData | undefined;
    expect(data?.kind).toBe("aggregated_runbook");
    expect(data?.phases_considered).toEqual(["P1", "P2"]);
    expect(data?.phases?.map((ph) => ph.phase_id)).toEqual(["P1", "P2"]);
    expect(data?.phases?.every((ph) => ph.kind === "runbook")).toBe(true);
  });

  it("excludes done and planned phases by default", async () => {
    const p = await freshProject("excludes");
    await setupProject(p, [
      { id: "PA", status: "done", tasks: [{ id: "PA-T1" }] },
      { id: "PB", status: "planned", tasks: [{ id: "PB-T1" }] },
      { id: "PC", status: "in_progress", tasks: [{ id: "PC-T1" }] },
      { id: "PD", status: "cancelled", tasks: [{ id: "PD-T1" }] },
    ]);

    const res = p.run(["phase", "runbook", "--across-phases", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    const data = env.data as StrictData | undefined;
    expect(data?.phases_considered).toEqual(["PC"]);
  });

  it("pulls in a planned phase that an in_progress phase depends on", async () => {
    const p = await freshProject("dep-driven");
    await setupProject(p, [
      // PB is planned; PA is in_progress and PA-T1 depends_on PB-T1
      { id: "PA", status: "in_progress", tasks: [{ id: "PA-T1", depends_on: ["PB-T1"] }] },
      { id: "PB", status: "planned", tasks: [{ id: "PB-T1" }] },
    ]);

    const res = p.run(["phase", "runbook", "--across-phases", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    const data = env.data as StrictData | undefined;
    expect(data?.phases_considered?.sort()).toEqual(["PA", "PB"]);
  });

  it("dep-driven inclusion only pulls in DECLARING phases not already in scope", async () => {
    // PA (in_progress) depends on PB-T1; both PA and PB end up in
    // considered, but for different reasons: PA on its own status,
    // PB via the dep-driven rule. Asserts the rule does not de-dupe
    // by accident.
    const p = await freshProject("dep-no-dedup");
    await setupProject(p, [
      { id: "PA", status: "in_progress", tasks: [{ id: "PA-T1", depends_on: ["PB-T1"] }] },
      { id: "PB", status: "planned", tasks: [{ id: "PB-T1" }] },
    ]);
    const res = p.run(["phase", "runbook", "--across-phases", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    const data = env.data as StrictData | undefined;
    expect(data?.phases_considered?.sort()).toEqual(["PA", "PB"]);
    // Both appear exactly once in `phases` (no duplicates).
    expect(data?.phases?.map((p) => p.phase_id)).toEqual(["PA", "PB"]);
  });

  it("no in_progress phases → empty aggregation envelope", async () => {
    const p = await freshProject("none");
    await setupProject(p, [
      { id: "PA", status: "done", tasks: [{ id: "PA-T1" }] },
      { id: "PB", status: "planned", tasks: [{ id: "PB-T1" }] },
    ]);

    const res = p.run(["phase", "runbook", "--across-phases", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<StrictData>;
    expect(env.ok).toBe(true);
    const data = env.data as StrictData | undefined;
    expect(data?.kind).toBe("aggregated_runbook");
    expect(data?.phases_considered).toEqual([]);
    expect(data?.phases).toEqual([]);
  });

  it("default `phase runbook P1 --json` still works (regression)", async () => {
    const p = await freshProject("default-regression");
    await setupProject(p, [
      { id: "P1", status: "in_progress", tasks: [{ id: "P1-T1" }] },
    ]);
    const res = p.run(["phase", "runbook", "P1", "--json"]);
    expect(res.code).toBe(0);
    const env = JSON.parse(res.stdout) as JsonEnvelope<{ kind?: string; phase_id?: string }>;
    expect(env.ok).toBe(true);
    if (env.ok) {
      expect(env.data?.kind).toBe("runbook");
      expect(env.data?.phase_id).toBe("P1");
    }
  });
});
