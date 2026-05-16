import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTaskContext } from "../../../src/commands/task-context.ts";

const fixtureDir = new URL("../../../tests/fixtures/project-a", import.meta.url).pathname;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "code-pact-task-context-"));
  await cp(fixtureDir, workDir, { recursive: true });
  // Strip any stale .context/ that the gitignored fixture might carry.
  await rm(join(workDir, ".context"), { recursive: true, force: true });
});

afterEach(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("runTaskContext — happy path", () => {
  it("resolves task to phase and returns pack metadata", async () => {
    const pack = await runTaskContext({
      cwd: workDir,
      taskId: "P2-E1-T1",
      agent: "claude-code",
    });
    expect(pack.taskId).toBe("P2-E1-T1");
    expect(pack.phaseId).toBe("P2");
    expect(pack.agent).toBe("claude-code");
    expect(pack.charCount).toBeGreaterThan(0);
    expect(pack.content).toContain("P2-E1-T1");
  });

  it("uses default_agent when --agent is omitted", async () => {
    const pack = await runTaskContext({
      cwd: workDir,
      taskId: "P2-E1-T1",
    });
    expect(pack.agent).toBe("claude-code");
  });

  it("does NOT create .context/ as a side effect", async () => {
    await runTaskContext({
      cwd: workDir,
      taskId: "P2-E1-T1",
      agent: "claude-code",
    });
    const contextExists = await readFile(
      join(workDir, ".context", "claude-code", "P2-E1-T1.md"),
      "utf8",
    ).then(() => true, () => false);
    expect(contextExists).toBe(false);
  });
});

describe("runTaskContext — error codes", () => {
  it("TASK_NOT_FOUND when no phase has the task", async () => {
    await expect(
      runTaskContext({ cwd: workDir, taskId: "NOPE-T9", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("AMBIGUOUS_TASK_ID when two phases contain the same task id", async () => {
    // Append a duplicate task id as a new entry in P1's existing tasks list.
    // (P1 already has a `tasks:` field, so we cannot redeclare it.)
    const p1Path = join(workDir, "design", "phases", "P1-foundation.yaml");
    const p1Raw = await readFile(p1Path, "utf8");
    const additional = `  - id: P2-E1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: medium
    verification_strength: strong
    expected_duration: short
    status: planned
    description: dup
`;
    await writeFile(p1Path, p1Raw + additional, "utf8");

    await expect(
      runTaskContext({ cwd: workDir, taskId: "P2-E1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_TASK_ID" });
  });

  it("AGENT_NOT_FOUND when --agent is not in project.yaml", async () => {
    await expect(
      runTaskContext({ cwd: workDir, taskId: "P2-E1-T1", agent: "missing-agent" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("AGENT_NOT_ENABLED when agent has enabled: false", async () => {
    // Rewrite project.yaml with claude-code disabled
    const projectYaml = `name: project-alpha
version: 0.1.0
locale: ja-JP
default_agent: claude-code
agents:
  - name: claude-code
    profile: agent-profiles/claude-code.yaml
    enabled: false
`;
    await writeFile(join(workDir, ".code-pact", "project.yaml"), projectYaml, "utf8");

    await expect(
      runTaskContext({ cwd: workDir, taskId: "P2-E1-T1", agent: "claude-code" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_ENABLED" });
  });
});
