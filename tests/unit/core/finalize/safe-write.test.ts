import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPlannedWrite,
  classifyWriteRequest,
} from "../../../../src/core/finalize/safe-write.ts";
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
