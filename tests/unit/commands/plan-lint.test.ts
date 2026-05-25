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
