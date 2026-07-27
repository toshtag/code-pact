import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPlannedWrite,
  classifyWriteRequest,
} from "../../../../src/core/finalize/safe-write.ts";
import { __setAtomicWriteFailAfterOpenForTests } from "../../../../src/io/atomic-text.ts";
import { parse as parseYaml } from "yaml";
import { Phase } from "../../../../src/core/schemas/phase.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
//
// Each test gets its own tmp project root so the fs side of safe-write
// has somewhere isolated to read from / write to. The phase YAML is
// laid out at design/phases/<file>.yaml so classifyWriteRequest's
// "under design/phases/" guard sees the right shape.
// ---------------------------------------------------------------------------

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-finalize-safe-write-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writePhase(relPath: string, body: string): Promise<void> {
  const abs = join(cwd, relPath);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, body, "utf8");
}

const validPhaseYaml = `id: P1
name: Foundation
weight: 10
confidence: medium
risk: low
status: planned
objective: Establish the project foundation
definition_of_done:
  - All tasks done
verification:
  commands:
    - node --version
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned
  - id: P1-T2
    type: docs
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: done
`;

// ---------------------------------------------------------------------------
// classifyWriteRequest — happy paths
// ---------------------------------------------------------------------------

describe("classifyWriteRequest — planned writes", () => {
  it("returns a planned write when the task needs flipping", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/P1-foundation.yaml",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("planned");
    if (result.kind !== "planned") return;
    expect(result.diff.file).toBe("design/phases/P1-foundation.yaml");
    expect(result.diff.task_id).toBe("P1-T1");
    expect(result.diff.before).toBe("planned");
    expect(result.diff.after).toBe("done");
    expect(result.phase.id).toBe("P1");
  });

  it("returns no-op when the task is already at the target status", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/P1-foundation.yaml",
      taskId: "P1-T2",
      targetStatus: "done",
    });
    expect(result.kind).toBe("no-op");
    if (result.kind !== "no-op") return;
    expect(result.task_id).toBe("P1-T2");
    expect(result.current_status).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// classifyWriteRequest — refusal reasons
// ---------------------------------------------------------------------------

describe("classifyWriteRequest — refusals", () => {
  it("refuses with unsafe_path for path traversal", async () => {
    const result = await classifyWriteRequest({
      cwd,
      file: "../escape/phase.yaml",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unsafe_path");
  });

  it("refuses with unsafe_path for absolute path", async () => {
    const result = await classifyWriteRequest({
      cwd,
      file: "/etc/passwd",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unsafe_path");
  });

  it("refuses with outside_design_phases when path is under src/", async () => {
    const result = await classifyWriteRequest({
      cwd,
      file: "src/core/foo.ts",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("outside_design_phases");
  });

  it("refuses with outside_design_phases when path is design/roadmap.yaml", async () => {
    // design/roadmap.yaml is deliberately NOT writable by P11
    // (it lives under design/, but not under design/phases/).
    const result = await classifyWriteRequest({
      cwd,
      file: "design/roadmap.yaml",
      taskId: "anything",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("outside_design_phases");
  });

  it("refuses with not_yaml when the file doesn't end in .yaml", async () => {
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/foo.txt",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("not_yaml");
  });

  it("refuses with unreadable when the file does not exist", async () => {
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/missing.yaml",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unreadable");
  });

  it("refuses with unparseable_phase when YAML is malformed", async () => {
    await writePhase(
      "design/phases/bad.yaml",
      "id: P1\nname: [unclosed bracket\n",
    );
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/bad.yaml",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unparseable_phase");
  });

  it("refuses with unparseable_phase when the YAML parses but fails Phase schema", async () => {
    // Missing required fields like weight, confidence, etc.
    await writePhase(
      "design/phases/partial.yaml",
      "id: P1\nname: Foundation\n",
    );
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/partial.yaml",
      taskId: "P1-T1",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("unparseable_phase");
  });

  it("refuses with task_not_found when the task id is missing from phase.tasks[]", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    const result = await classifyWriteRequest({
      cwd,
      file: "design/phases/P1-foundation.yaml",
      taskId: "P1-T99",
      targetStatus: "done",
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toBe("task_not_found");
  });

  it("refuses with symlink_escape when a path-component symlink escapes the project", async () => {
    // Create design/phases/escape -> /tmp (outside cwd). A read of
    // design/phases/escape/anything.yaml would resolve outside the
    // project root.
    await mkdir(join(cwd, "design", "phases"), { recursive: true });
    const target = await mkdtemp(join(tmpdir(), "code-pact-finalize-escape-"));
    try {
      await symlink(target, join(cwd, "design", "phases", "escape"));
      const result = await classifyWriteRequest({
        cwd,
        file: "design/phases/escape/leaf.yaml",
        taskId: "P1-T1",
        targetStatus: "done",
      });
      expect(result.kind).toBe("refused");
      if (result.kind !== "refused") return;
      expect(result.reason).toBe("symlink_escape");
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// applyPlannedWrite — actually writes to disk via atomicWriteText
// ---------------------------------------------------------------------------

describe("applyPlannedWrite", () => {
  it("flips the target task's status to the diff's `after` value", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    await applyPlannedWrite(cwd, {
      file: "design/phases/P1-foundation.yaml",
      task_id: "P1-T1",
      before: "planned",
      after: "done",
    });
    const raw = await readFile(
      join(cwd, "design/phases/P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(raw) as unknown);
    const t1 = phase.tasks?.find((t) => t.id === "P1-T1");
    expect(t1?.status).toBe("done");
  });

  it("does NOT touch other tasks in the same phase", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    await applyPlannedWrite(cwd, {
      file: "design/phases/P1-foundation.yaml",
      task_id: "P1-T1",
      before: "planned",
      after: "done",
    });
    const raw = await readFile(
      join(cwd, "design/phases/P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(raw) as unknown);
    const t2 = phase.tasks?.find((t) => t.id === "P1-T2");
    // Was already 'done' in the fixture.
    expect(t2?.status).toBe("done");
  });

  it("does NOT change the phase's own status field", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    await applyPlannedWrite(cwd, {
      file: "design/phases/P1-foundation.yaml",
      task_id: "P1-T1",
      before: "planned",
      after: "done",
    });
    const raw = await readFile(
      join(cwd, "design/phases/P1-foundation.yaml"),
      "utf8",
    );
    const phase = Phase.parse(parseYaml(raw) as unknown);
    expect(phase.status).toBe("planned"); // phase status unchanged
  });

  it("throws when the task vanished between classify and apply", async () => {
    await writePhase("design/phases/P1-foundation.yaml", validPhaseYaml);
    await expect(
      applyPlannedWrite(cwd, {
        file: "design/phases/P1-foundation.yaml",
        task_id: "P1-T99",
        before: "planned",
        after: "done",
      }),
    ).rejects.toThrow(/task "P1-T99" not found/);
  });
});

// ---------------------------------------------------------------------------
// applyPlannedWrite — the write is a source edit, not a re-serialization
//
// The phase file below carries what the strict Phase model does not: a
// top-level `evidence:` list, an unknown `x-custom:` key, an inline comment,
// and a folded block scalar. The previous writer serialized the parsed model
// and dropped all of it on every flip (issue #560).
// ---------------------------------------------------------------------------

const phaseWithEvidenceYaml = `id: P1
name: Foundation
weight: 10
confidence: medium
risk: low
status: in_progress
objective: >
  Establish the project foundation.
x-custom:
  nested: keep-me
definition_of_done:
  - All tasks done
verification:
  commands:
    - node --version
evidence:
  - "P1-T2 done event recorded in .code-pact/state/events/one.yaml"
  - "P1-T3 done event recorded in .code-pact/state/events/two.yaml"
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned # closeout pending
  - id: P1-T2
    type: docs
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: weak
    expected_duration: short
    status: done
`;

const phasePath = "design/phases/P1-foundation.yaml";

async function readPhaseSource(): Promise<string> {
  return readFile(join(cwd, phasePath), "utf8");
}

async function flipT1ToDone(): Promise<void> {
  await applyPlannedWrite(cwd, {
    file: phasePath,
    task_id: "P1-T1",
    before: "planned",
    after: "done",
  });
}

describe("applyPlannedWrite — preserves everything but the target status", () => {
  beforeEach(async () => {
    await writePhase(phasePath, phaseWithEvidenceYaml);
  });

  it("changes the target status token and nothing else", async () => {
    await flipT1ToDone();
    expect(await readPhaseSource()).toBe(
      phaseWithEvidenceYaml.replace(
        "status: planned # closeout pending",
        "status: done # closeout pending",
      ),
    );
  });

  it("keeps every top-level evidence entry", async () => {
    await flipT1ToDone();
    const parsed = parseYaml(await readPhaseSource()) as {
      evidence: string[];
    };
    expect(parsed.evidence).toEqual([
      "P1-T2 done event recorded in .code-pact/state/events/one.yaml",
      "P1-T3 done event recorded in .code-pact/state/events/two.yaml",
    ]);
  });

  it("keeps a top-level key the Phase schema does not model", async () => {
    await flipT1ToDone();
    const parsed = parseYaml(await readPhaseSource()) as {
      "x-custom": { nested: string };
    };
    expect(parsed["x-custom"]).toEqual({ nested: "keep-me" });
  });

  it("leaves the other task's status and the phase status alone", async () => {
    await flipT1ToDone();
    const phase = Phase.parse(parseYaml(await readPhaseSource()) as unknown);
    expect(phase.tasks?.find((t) => t.id === "P1-T1")?.status).toBe("done");
    expect(phase.tasks?.find((t) => t.id === "P1-T2")?.status).toBe("done");
    expect(phase.status).toBe("in_progress");
  });

  it("refuses when the task is no longer at the diff's `before` status", async () => {
    await expect(
      applyPlannedWrite(cwd, {
        file: phasePath,
        task_id: "P1-T1",
        before: "in_progress",
        after: "done",
      }),
    ).rejects.toThrow(/expected "in_progress"/);
    expect(await readPhaseSource()).toBe(phaseWithEvidenceYaml);
  });
});

describe("applyPlannedWrite — concurrent writer", () => {
  afterEach(() => __setAtomicWriteFailAfterOpenForTests(null));

  it("refuses the write and keeps the concurrent bytes when the source changed under it", async () => {
    await writePhase(phasePath, phaseWithEvidenceYaml);
    const concurrent = phaseWithEvidenceYaml.replace(
      '  - "P1-T3 done event recorded in .code-pact/state/events/two.yaml"\n',
      '  - "P1-T3 done event recorded in .code-pact/state/events/two.yaml"\n  - "P1-T4 done event recorded in .code-pact/state/events/three.yaml"\n',
    );

    // The seam runs once the temp file is open, i.e. after applyPlannedWrite
    // read the source and before the rename — exactly the window a concurrent
    // writer would land in. Returning no error lets the write continue into
    // the pre-rename drift re-check, which is what we want to observe.
    __setAtomicWriteFailAfterOpenForTests(() => {
      writeFileSync(join(cwd, phasePath), concurrent, "utf8");
      return undefined as unknown as Error;
    });

    await expect(flipT1ToDone()).rejects.toThrow(
      /destination changed before write/,
    );
    // The concurrent writer's bytes survive; the stale candidate is discarded.
    expect(await readPhaseSource()).toBe(concurrent);
  });
});
