import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildContextPack } from "../../../../src/core/pack/index.ts";

const fixtureDir = new URL(
  "../../../../tests/fixtures/project-a",
  import.meta.url,
).pathname;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "code-pact-pack-explain-"));
  await cp(fixtureDir, workDir, { recursive: true });
  await rm(join(workDir, ".context"), { recursive: true, force: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("buildContextPack — explain mode opt-in", () => {
  it("does not include sections/excluded when explain is false", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    expect(pack.sections).toBeUndefined();
    expect(pack.excluded).toBeUndefined();
    expect(pack.totalBytes).toBeGreaterThan(0);
  });

  it("includes sections/excluded when explain is true", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(Array.isArray(pack.sections)).toBe(true);
    expect(Array.isArray(pack.excluded)).toBe(true);
    expect((pack.sections ?? []).length).toBeGreaterThan(0);
  });

  it("produces byte-identical content regardless of the explain flag", async () => {
    const plain = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
    });
    const explained = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(explained.content).toBe(plain.content);
    expect(explained.totalBytes).toBe(plain.totalBytes);
  });
});

describe("buildContextPack — byte invariant", () => {
  it("sum(sections[].bytes) === totalBytes (acceptance invariant)", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const sum = (pack.sections ?? []).reduce((acc, s) => acc + s.bytes, 0);
    expect(sum).toBe(pack.totalBytes);
  });

  it("includes a synthetic format_overhead section capturing inter-section newlines", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const overhead = (pack.sections ?? []).find(
      (s) => s.name === "format_overhead",
    );
    expect(overhead).toBeDefined();
    expect(overhead?.reason_code).toBe("format_overhead");
    expect(overhead?.bytes).toBeGreaterThan(0);
  });

  it("totalBytes matches Buffer.byteLength(content, 'utf8')", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    expect(pack.totalBytes).toBe(Buffer.byteLength(pack.content, "utf8"));
  });
});

describe("buildContextPack — reason codes (closed enums)", () => {
  const VALID_SECTION_REASONS = new Set([
    "always_included",
    "declared_by_task",
    "referenced_decision",
    "glob_match",
    "write_surface_high",
    "context_size_large",
    "ambiguity_high",
    "format_overhead",
  ]);

  const VALID_EXCLUDED_REASONS = new Set([
    "context_size_small_and_ambiguity_low",
    "not_declared_by_task",
    "glob_no_match",
    "budget_reserved_for_later",
  ]);

  it("every section's reason_code is from the closed enum", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    for (const s of pack.sections ?? []) {
      expect(VALID_SECTION_REASONS.has(s.reason_code)).toBe(true);
    }
  });

  it("every excluded entry's reason_code is from the closed enum", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    for (const x of pack.excluded ?? []) {
      expect(VALID_EXCLUDED_REASONS.has(x.reason_code)).toBe(true);
    }
  });

  it("never emits budget_reserved_for_later in P21 (reserved for P24)", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const forbidden = (pack.excluded ?? []).filter(
      (x) => x.reason_code === "budget_reserved_for_later",
    );
    expect(forbidden).toHaveLength(0);
  });
});

describe("buildContextPack — section presence", () => {
  it("always emits header, phase_contract, task_definition, verification_commands, progress_event_schema", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P2",
      taskId: "P2-E1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const names = (pack.sections ?? []).map((s) => s.name);
    for (const required of [
      "header",
      "phase_contract",
      "task_definition",
      "verification_commands",
      "progress_event_schema",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("excluded list includes the not-declared P10 fields when task declares none", async () => {
    const pack = await buildContextPack({
      cwd: workDir,
      phaseId: "P1",
      taskId: "P1-T1",
      agentName: "claude-code",
      explain: true,
    });
    const excludedNames = (pack.excluded ?? []).map((x) => x.name);
    // P1-T1 in the project-a fixture does not declare P10 fields.
    expect(excludedNames).toContain("depends_on");
    expect(excludedNames).toContain("reads");
    expect(excludedNames).toContain("writes");
    expect(excludedNames).toContain("declared_decisions");
    expect(excludedNames).toContain("acceptance_refs");
  });
});
