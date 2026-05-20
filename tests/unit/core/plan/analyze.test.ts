import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAnalyze } from "../../../../src/core/plan/analyze.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-analyze-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, ".code-pact", "state"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const phaseYaml = (
  id: string,
  tasks: Array<{ id: string; status?: "planned" | "in_progress" | "done" | "cancelled" }>,
  phaseStatus: "planned" | "in_progress" | "done" | "cancelled" = "planned",
): string => `id: ${id}
name: ${id}
weight: 10
confidence: medium
risk: low
status: ${phaseStatus}
objective: An objective long enough
definition_of_done:
  - thing is done
verification:
  commands:
    - pnpm test
tasks:
${tasks
  .map(
    (t) => `  - id: ${t.id}
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: ${t.status ?? "planned"}`,
  )
  .join("\n")}
`;

async function setupProject(
  phases: Array<{
    id: string;
    tasks: Array<{ id: string; status?: "planned" | "in_progress" | "done" | "cancelled" }>;
    status?: "planned" | "in_progress" | "done" | "cancelled";
  }>,
  events: Array<{
    task_id: string;
    status: "started" | "blocked" | "resumed" | "done" | "failed";
    reason?: string;
  }>,
): Promise<void> {
  const roadmap = `phases:\n${phases
    .map(
      (p) => `  - id: ${p.id}\n    path: design/phases/${p.id}.yaml\n    weight: 10`,
    )
    .join("\n")}\n`;
  await writeFile(join(cwd, "design", "roadmap.yaml"), roadmap, "utf8");
  for (const p of phases) {
    await writeFile(
      join(cwd, "design", "phases", `${p.id}.yaml`),
      phaseYaml(p.id, p.tasks, p.status),
      "utf8",
    );
  }
  const progress =
    events.length === 0
      ? "events: []\n"
      : `events:\n${events
          .map(
            (e, idx) =>
              `  - task_id: ${e.task_id}\n    status: ${e.status}\n    at: "2026-05-18T0${idx}:00:00+00:00"\n    actor: agent${
                e.reason ? `\n    reason: ${e.reason}` : ""
              }`,
          )
          .join("\n")}\n`;
  await writeFile(
    join(cwd, ".code-pact", "state", "progress.yaml"),
    progress,
    "utf8",
  );
}

describe("runAnalyze — clean state", () => {
  it("no drift when design done + progress done agree", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "done" }] }],
      [{ task_id: "P1-T1", status: "started" }, { task_id: "P1-T1", status: "done" }],
    );
    const result = await runAnalyze({ cwd });
    expect(result.issues).toEqual([]);
  });

  it("no drift when design planned and there are no events", async () => {
    await setupProject([{ id: "P1", tasks: [{ id: "P1-T1" }] }], []);
    const result = await runAnalyze({ cwd });
    expect(result.issues).toEqual([]);
  });
});

describe("runAnalyze — STATUS_DRIFT kinds", () => {
  it("done-blocked-conflict: design done + derived blocked", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "done" }] }],
      [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "blocked", reason: "waiting" },
      ],
    );
    const result = await runAnalyze({ cwd });
    const drift = result.issues.find((i) => i.code === "STATUS_DRIFT");
    expect(drift).toBeDefined();
    expect(drift?.severity).toBe("error");
    expect(drift?.details?.["kind"]).toBe("done-blocked-conflict");
  });

  it("done-with-incomplete-events: design done + derived started + hasEvents", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "done" }] }],
      [{ task_id: "P1-T1", status: "started" }],
    );
    const result = await runAnalyze({ cwd });
    const drift = result.issues.find((i) => i.code === "STATUS_DRIFT");
    expect(drift?.severity).toBe("error");
    expect(drift?.details?.["kind"]).toBe("done-with-incomplete-events");
  });

  it("done-historical: design done + no progress events → hidden_by_default + affects_exit=false", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "done" }] }],
      [],
    );
    const result = await runAnalyze({ cwd });
    const drift = result.issues.find((i) => i.code === "STATUS_DRIFT");
    expect(drift).toBeDefined();
    expect(drift?.details?.["kind"]).toBe("done-historical");
    expect(drift?.severity).toBe("warning");
    expect(drift?.hidden_by_default).toBe(true);
    expect(drift?.affects_exit).toBe(false);
  });

  it("done-but-design-not-done: design planned + derived done", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "planned" }] }],
      [{ task_id: "P1-T1", status: "started" }, { task_id: "P1-T1", status: "done" }],
    );
    const result = await runAnalyze({ cwd });
    const drift = result.issues.find((i) => i.code === "STATUS_DRIFT");
    expect(drift?.severity).toBe("warning");
    expect(drift?.details?.["kind"]).toBe("done-but-design-not-done");
    // v1.2 P11-T5: additive remediation hint for the only mechanizable kind.
    expect(drift?.details?.["remediation"]).toBe("code-pact task finalize P1-T1");
  });

  it("remediation hint is not emitted for other STATUS_DRIFT kinds", async () => {
    // in-progress-no-events is human-judgement territory — no hint.
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "in_progress" }] }],
      [],
    );
    const result = await runAnalyze({ cwd });
    const drift = result.issues.find((i) => i.code === "STATUS_DRIFT");
    expect(drift?.details?.["kind"]).toBe("in-progress-no-events");
    expect(drift?.details?.["remediation"]).toBeUndefined();
  });

  it("in-progress-no-events: design in_progress + no events", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "in_progress" }] }],
      [],
    );
    const result = await runAnalyze({ cwd });
    const drift = result.issues.find((i) => i.code === "STATUS_DRIFT");
    expect(drift?.severity).toBe("warning");
    expect(drift?.details?.["kind"]).toBe("in-progress-no-events");
  });
});

describe("runAnalyze — exclusivity", () => {
  // Top-down evaluation: done + blocked must NOT also produce
  // done-with-incomplete-events for the same task.
  it("done + blocked produces exactly ONE STATUS_DRIFT (done-blocked-conflict only)", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "done" }] }],
      [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "blocked", reason: "x" },
      ],
    );
    const result = await runAnalyze({ cwd });
    const drifts = result.issues.filter(
      (i) => i.code === "STATUS_DRIFT" && i.task_id === "P1-T1",
    );
    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.details?.["kind"]).toBe("done-blocked-conflict");
  });
});

describe("runAnalyze — PHASE_DONE_WITH_OPEN_TASKS", () => {
  it("flags a done phase that still has non-done tasks", async () => {
    await setupProject(
      [
        {
          id: "P1",
          status: "done",
          tasks: [
            { id: "P1-T1", status: "done" },
            { id: "P1-T2", status: "in_progress" },
          ],
        },
      ],
      [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "done" },
        { task_id: "P1-T2", status: "started" },
      ],
    );
    const result = await runAnalyze({ cwd });
    const issue = result.issues.find((i) => i.code === "PHASE_DONE_WITH_OPEN_TASKS");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.phase_id).toBe("P1");
  });

  it("does not flag a done phase whose tasks are all done", async () => {
    await setupProject(
      [
        {
          id: "P1",
          status: "done",
          tasks: [{ id: "P1-T1", status: "done" }],
        },
      ],
      [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "done" },
      ],
    );
    const result = await runAnalyze({ cwd });
    expect(
      result.issues.some((i) => i.code === "PHASE_DONE_WITH_OPEN_TASKS"),
    ).toBe(false);
  });
});

describe("runAnalyze — ORPHAN_PROGRESS_EVENT", () => {
  it("flags events whose task_id does not exist in any phase", async () => {
    await setupProject(
      [{ id: "P1", tasks: [{ id: "P1-T1", status: "done" }] }],
      [
        { task_id: "P1-T1", status: "started" },
        { task_id: "P1-T1", status: "done" },
        { task_id: "GHOST", status: "started" },
      ],
    );
    const result = await runAnalyze({ cwd });
    const orphan = result.issues.find((i) => i.code === "ORPHAN_PROGRESS_EVENT");
    expect(orphan).toBeDefined();
    expect(orphan?.severity).toBe("warning");
    expect(orphan?.task_id).toBe("GHOST");
  });
});
