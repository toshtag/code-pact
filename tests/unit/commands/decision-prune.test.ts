import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runDecisionPrune,
  serializeDecisionPrune,
  formatDecisionPruneHuman,
  notEligibleMessage,
} from "../../../src/commands/decision-prune.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-decprune-"));
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

const ACCEPTED = "# RFC\n\n**Status:** accepted\n\n## Decision\n\nbody";

async function writeDecision(name: string, content = ACCEPTED): Promise<void> {
  await writeFile(join(cwd, "design", "decisions", name), content, "utf8");
}

/** A valid, taskless plan so the artifact guard passes but nothing references the target. */
async function writeValidEmptyPlan(): Promise<void> {
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
confidence: high
risk: low
status: done
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - pnpm test
`,
    "utf8",
  );
}

async function writeDoneTaskPhase(decisionRef: string): Promise<void> {
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
confidence: high
risk: low
status: done
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
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
    status: done
    description: Implements the thing
    decision_refs:
      - ${decisionRef}
`,
    "utf8",
  );
}

describe("runDecisionPrune", () => {
  it("is eligible (with a plan, no warning) when referenced only by a done task", async () => {
    await writeDecision("foo-rfc.md");
    await writeDoneTaskPhase("design/decisions/foo-rfc.md");
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    expect(res.mode).toBe("dry-run");
    expect(res.eligible).toBe(true);
    expect(res.plan).toEqual({
      remove_file: "design/decisions/foo-rfc.md",
      append_ledger: true,
      link_rewrite_pending: true,
    });
    expect(res.warnings).toEqual([]);
    expect(res.evaluation.referencing_tasks).toHaveLength(1);
  });

  it("warns when eligible but no task references it (cannot prove it shipped)", async () => {
    await writeDecision("foo-rfc.md"); // accepted, no task references it
    await writeValidEmptyPlan();
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    expect(res.eligible).toBe(true);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/No task references this decision/);
  });

  it("is not eligible with no plan for a proposed target", async () => {
    await writeDecision("foo-rfc.md", "# RFC\n\n**Status:** proposed\n\nx");
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    expect(res.eligible).toBe(false);
    expect(res.plan).toBeNull();
    expect(res.evaluation.blocks.some((b) => b.gate === "target_not_accepted")).toBe(true);
  });

  it("returns decision:null for a non-decision target", async () => {
    const res = await runDecisionPrune(cwd, "docs/cli-contract.md");
    expect(res.decision).toBeNull();
    expect(res.eligible).toBe(false);
  });

  it("fail-closed: an unparseable roadmap blocks even an accepted, unreferenced target", async () => {
    await writeDecision("foo-rfc.md");
    await writeFile(join(cwd, "design", "roadmap.yaml"), ":\n  not: [valid", "utf8");
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    expect(res.eligible).toBe(false);
    expect(res.evaluation.blocks.some((b) => b.gate === "plan_artifacts_unreadable")).toBe(true);
  });

  it("fail-closed: a referenced phase YAML that is unparseable blocks (hidden not-done ref)", async () => {
    await writeDecision("foo-rfc.md");
    await writeFile(
      join(cwd, "design", "roadmap.yaml"),
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n  - id: P2\n    path: design/phases/P2.yaml\n    weight: 10\n`,
      "utf8",
    );
    // P1 valid; P2 unparseable — it could hide a not-done task referencing the target.
    await writeFile(
      join(cwd, "design", "phases", "P1.yaml"),
      `id: P1\nname: P1\nweight: 10\nconfidence: high\nrisk: low\nstatus: done\nobjective: An objective long enough\ndefinition_of_done:\n  - DoD that is clearly long enough\nverification:\n  commands:\n    - pnpm test\n`,
      "utf8",
    );
    await writeFile(join(cwd, "design", "phases", "P2.yaml"), "id: [broken", "utf8");
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    expect(res.eligible).toBe(false);
    expect(res.evaluation.blocks.some((b) => b.gate === "plan_artifacts_unreadable")).toBe(true);
  });

  it("fail-closed: a missing roadmap blocks", async () => {
    await writeDecision("foo-rfc.md");
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    expect(res.eligible).toBe(false);
    expect(res.evaluation.blocks.some((b) => b.gate === "plan_artifacts_unreadable")).toBe(true);
  });
});

describe("decision-prune renderers", () => {
  it("serialize exposes the contract fields", async () => {
    await writeDecision("foo-rfc.md");
    await writeValidEmptyPlan();
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    const data = serializeDecisionPrune(res);
    expect(data).toMatchObject({
      mode: "dry-run",
      decision: "design/decisions/foo-rfc.md",
      eligible: true,
    });
    expect(data).toHaveProperty("blocks");
    expect(data).toHaveProperty("referencing_tasks");
    expect(data).toHaveProperty("plan");
    expect(data).toHaveProperty("warnings");
  });

  it("human output names blocks when ineligible", async () => {
    await writeDecision("foo-rfc.md", "# RFC\n\n**Status:** proposed\n\nx");
    const res = await runDecisionPrune(cwd, "design/decisions/foo-rfc.md");
    const human = formatDecisionPruneHuman(res);
    expect(human).toContain("NOT ELIGIBLE");
    expect(human).toContain("not an accepted decision");
    expect(notEligibleMessage(res)).toContain("cannot be pruned");
  });
});
