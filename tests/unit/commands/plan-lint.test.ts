import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runPlanLint,
  serializePlanLintData,
  summarizePlanLint,
  formatPlanLintHuman,
} from "../../../src/commands/plan-lint.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-plan-lint-cmd-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

// A clean phase except confidence: low, which fires exactly one advisory
// (PHASE_CONFIDENCE_LOW) under --include-quality.
async function writeLowConfidenceProject(): Promise<void> {
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "phases", "P1.yaml"),
    `id: P1
name: P1
weight: 10
confidence: low
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough to read
verification:
  commands:
    - pnpm test
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
    description: Implements the thing
`,
    "utf8",
  );
}

// Two roadmap entries claim the same phase id (the post-merge collision the
// control-plane v2 incident describes): two branches each mint P1 in a separate
// file, git auto-merges, and DUPLICATE_PHASE_ID fires.
async function writeDuplicatePhaseProject(): Promise<void> {
  await writeFile(
    join(cwd, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n  - id: P1\n    path: design/phases/P1b.yaml\n    weight: 10\n`,
    "utf8",
  );
  const body = (file: string) => `id: P1
name: ${file}
weight: 10
confidence: high
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough to read
verification:
  commands:
    - pnpm test
`;
  await writeFile(join(cwd, "design", "phases", "P1.yaml"), body("P1"), "utf8");
  await writeFile(join(cwd, "design", "phases", "P1b.yaml"), body("P1b"), "utf8");
}

describe("runPlanLint — conflict recovery (control-plane v2 PR1b re-scope)", () => {
  it("attaches structured recovery to DUPLICATE_PHASE_ID and serializes it", async () => {
    await writeDuplicatePhaseProject();
    const result = await runPlanLint({ cwd });
    const data = serializePlanLintData(result);
    const issues = data.issues as Array<Record<string, unknown>>;
    const dup = issues.find((i) => i.code === "DUPLICATE_PHASE_ID");
    expect(dup).toBeDefined();
    const recovery = dup?.recovery as
      | { manual_action?: string; confirm?: string; reference?: string }
      | undefined;
    expect(recovery?.manual_action).toContain("design/roadmap.yaml");
    expect(recovery?.confirm).toBe("code-pact plan lint");
    expect(recovery?.reference).toContain("DUPLICATE_PHASE_ID");
  });

  it("adds NO new noise to a clean current project (no recovery, no new warnings)", async () => {
    // A valid P<N> / inline-tasks project — the current canonical layout — must
    // gain zero new issues from the recovery work, even under --strict.
    await writeLowConfidenceProject();
    const result = await runPlanLint({ cwd, strict: true });
    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    // No conflict diagnostics, and no recovery field leaks onto a clean tree.
    const data = serializePlanLintData(result);
    const issues = data.issues as Array<Record<string, unknown>>;
    expect(
      issues.some((i) =>
        ["DUPLICATE_PHASE_ID", "DUPLICATE_TASK_ID", "PHASE_ID_MISMATCH"].includes(
          i.code as string,
        ),
      ),
    ).toBe(false);
    expect(issues.every((i) => i.recovery === undefined)).toBe(true);
  });
});

describe("runPlanLint — advisory contract", () => {
  it("counts advisories separately and stays ok even under --strict", async () => {
    await writeLowConfidenceProject();
    const result = await runPlanLint({ cwd, includeQuality: true, strict: true });

    expect(result.errors).toBe(0);
    expect(result.warnings).toBe(0);
    expect(result.advisories).toBeGreaterThanOrEqual(1);
    // Advisory issues never affect the exit code, even with --strict.
    expect(result.ok).toBe(true);
  });

  it("serializes affects_exit on advisory issues and a top-level advisories count", async () => {
    await writeLowConfidenceProject();
    const result = await runPlanLint({ cwd, includeQuality: true });
    const data = serializePlanLintData(result);

    expect(data.advisories).toBe(result.advisories);
    const issues = data.issues as Array<Record<string, unknown>>;
    const advisory = issues.find((i) => i.code === "PHASE_CONFIDENCE_LOW");
    expect(advisory).toBeDefined();
    expect(advisory?.affects_exit).toBe(false);
  });

  it("human summary names advisories and renders advisory lines as [advisory]", async () => {
    await writeLowConfidenceProject();
    const result = await runPlanLint({ cwd, includeQuality: true });

    expect(summarizePlanLint(result)).toContain("advisor");
    const human = formatPlanLintHuman(result);
    expect(human).toContain("[advisory]");
    expect(human).toContain("PHASE_CONFIDENCE_LOW");
  });
});
