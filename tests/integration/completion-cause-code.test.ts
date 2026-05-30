// P39 — Root-cause-first completion errors.
//
// task complete must name the real cause on the PRIMARY error face: an
// additive `error.cause_code` plus an actionable `error.message`, while
// `error.code` stays VERIFICATION_FAILED (exit 1) and the P32 `data` fields
// are left where they are (not duplicated into `error`). These tests spawn the
// built CLI and exercise the decision-gate path (no ADR / proposed ADR) and the
// command-failure path. See design/decisions/root-cause-completion-errors-rfc.md.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { cliPath, ensureCliBuilt } from "../helpers/cli.ts";

let tmpDir: string;

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    env: process.env,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

type Envelope = {
  ok: boolean;
  error: { code: string; message: string; cause_code?: string };
  data: {
    failed_checks: string[];
    first_failure: { name: string; reason: string } | null;
    verify: { ok: boolean; checks: { name: string; ok: boolean }[] };
  };
};

/** Resolve the on-disk path of phase P1 (the slug suffix depends on --name). */
async function phaseP1Path(): Promise<string> {
  const dir = join(tmpDir, "design", "phases");
  const entries = await readdir(dir);
  const file = entries.find((e) => e === "P1.yaml" || e.startsWith("P1-"));
  if (!file) throw new Error(`P1 phase file not found in ${entries.join(", ")}`);
  return join(dir, file);
}

/**
 * Add phase P1 with a single task P1-T1 (full schema, status planned),
 * a passing verify command, then apply `patch` to the task before writing.
 */
async function setupTask(
  patch: (task: Record<string, unknown>) => void,
  commands: string[] = ["true"],
): Promise<void> {
  expect(
    run([
      "init",
      "--non-interactive",
      "--locale",
      "en-US",
      "--agent",
      "claude-code",
      "--json",
    ]).code,
  ).toBe(0);
  expect(
    run([
      "phase",
      "add",
      "--id",
      "P1",
      "--name",
      "Foundation",
      "--objective",
      "Foundation",
      "--weight",
      "10",
      "--json",
    ]).code,
  ).toBe(0);

  const phasePath = await phaseP1Path();
  const doc = parseYaml(await readFile(phasePath, "utf8")) as Record<string, unknown>;
  doc.verification = { commands };
  const task: Record<string, unknown> = {
    id: "P1-T1",
    type: "feature",
    ambiguity: "low",
    risk: "low",
    context_size: "small",
    write_surface: "low",
    verification_strength: "weak",
    expected_duration: "short",
    status: "planned",
    description: "integration test task",
  };
  patch(task);
  doc.tasks = [task];
  await writeFile(phasePath, stringifyYaml(doc), "utf8");
}

async function writeAdr(filename: string, body: string): Promise<void> {
  const dir = join(tmpDir, "design", "decisions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), body, "utf8");
}

const GENERIC = `Verification failed for "P1-T1". progress.yaml was not modified.`;

describe("P39: task complete cause_code", () => {
  beforeAll(() => {
    ensureCliBuilt();
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "p39-cause-"));
  });

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("decision gate with no ADR -> cause_code DECISION_REQUIRED; progress.yaml unchanged", async () => {
    await setupTask((t) => {
      t.requires_decision = true;
    });

    const progressPath = join(tmpDir, ".code-pact", "state", "progress.yaml");
    const before = await readFile(progressPath, "utf8");

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
      "--dry-run",
    ]);
    expect(res.code).toBe(1);
    const env = JSON.parse(res.stdout) as Envelope;

    expect(env.ok).toBe(false);
    // error.code unchanged (v1-stable); cause is additive.
    expect(env.error.code).toBe("VERIFICATION_FAILED");
    expect(env.error.cause_code).toBe("DECISION_REQUIRED");
    expect(env.error.message).toMatch(/accepted ADR/i);
    expect(env.error.message).not.toBe(GENERIC);

    // No error-side duplication of P32 data fields and no structured block.
    expect(env.error).not.toHaveProperty("failed_checks");
    expect(env.error).not.toHaveProperty("first_failure");
    expect(env.error).not.toHaveProperty("considered");
    expect(env.error).not.toHaveProperty("decision_check");

    // P32 detail still present in data.
    expect(env.data.failed_checks).toContain("decision");
    expect(env.data.first_failure?.name).toBe("decision");
    expect(
      env.data.verify.checks.some((c) => c.name === "decision" && !c.ok),
    ).toBe(true);

    const after = await readFile(progressPath, "utf8");
    expect(after).toBe(before);
  });

  it("decision gate with a proposed (not accepted) ADR -> same cause_code, accepted required", async () => {
    await setupTask((t) => {
      t.requires_decision = true;
    });
    await writeAdr(
      "P1-T1-proposal.md",
      "# RFC: P1-T1 decision\n\n**Status:** proposed\n\n## Decision\n\nNot yet accepted.\n",
    );

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
      "--dry-run",
    ]);
    expect(res.code).toBe(1);
    const env = JSON.parse(res.stdout) as Envelope;
    expect(env.error.code).toBe("VERIFICATION_FAILED");
    expect(env.error.cause_code).toBe("DECISION_REQUIRED");
    expect(env.error.message).toMatch(/accepted ADR/i);
  });

  it("command failure -> cause_code COMMANDS_FAILED; data backward-compatible", async () => {
    // No decision gate; the verify command fails.
    await setupTask(() => {}, ["false"]);

    const res = run([
      "task",
      "complete",
      "P1-T1",
      "--agent",
      "claude-code",
      "--json",
      "--dry-run",
    ]);
    expect(res.code).toBe(1);
    const env = JSON.parse(res.stdout) as Envelope;
    expect(env.error.code).toBe("VERIFICATION_FAILED");
    expect(env.error.cause_code).toBe("COMMANDS_FAILED");
    expect(env.data.failed_checks).toContain("commands");
    expect(env.data.first_failure?.name).toBe("commands");
  });

  // P39-T2: human (non-JSON) parity. The plain-text path must also name the
  // cause and the rerun-after-fixing line for BOTH failure causes, so an agent
  // reading stderr is not left with only the generic message. The command-cause
  // human case is covered in cli.test.ts; this pins the decision cause.
  it("human output (decision failure): actionable headline + cause + rerun line", async () => {
    await setupTask((t) => {
      t.requires_decision = true;
    });

    const res = run(["task", "complete", "P1-T1", "--agent", "claude-code"]);
    expect(res.code).toBe(1);
    // Headline is the actionable cause message, not the generic string.
    expect(res.stderr).toMatch(/requires an accepted ADR/i);
    expect(res.stderr).not.toBe(GENERIC);
    // The shared failure-summary lines below it.
    expect(res.stderr).toMatch(/cause: decision —/);
    expect(res.stderr).toMatch(/rerun after fixing: code-pact task complete P1-T1/);
  });

  it("human output (command failure): actionable headline + cause + rerun line", async () => {
    await setupTask(() => {}, ["false"]);

    const res = run(["task", "complete", "P1-T1", "--agent", "claude-code"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/a verification command failed/i);
    expect(res.stderr).toMatch(/cause: commands —/);
    expect(res.stderr).toMatch(/rerun after fixing: code-pact task complete P1-T1/);
  });
});
