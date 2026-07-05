// Step 5 — retired-decision resolution (A3). An active decision gate whose
// `decision_refs` is retired (the .md deleted) resolves from a valid ACCEPTED
// `.code-pact/state` decision-state record; a non-accepted record / no record
// fails closed. `acceptance_refs` stays strict for non-decision targets.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempProject, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { writeDecisionRecord } from "../../src/core/archive/decision-record.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const NOW = new Date("2026-06-10T00:00:00.000Z");
const XREF = "design/decisions/x-rfc.md";
const ACCEPTED = "# RFC: X\n\n**Status:** accepted (P9, 2026-06)\n\n## Decision\n\nSettled body here.\n";
const BLOCKED = "# RFC: X\n\n**Status:** proposed\n\n## Decision\n\nNot yet settled.\n";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;
const PHASE = (refField: "decision_refs" | "acceptance_refs", refPath: string) => `id: P1
name: P1
weight: 10
confidence: high
risk: low
status: in_progress
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: in_progress
    description: Implements the thing
    requires_decision: true
    ${refField}:
      - ${refPath}
`;

/** Scaffold a project, write the ADR + its decision-state record, then retire it. */
async function scaffoldRetired(adr: string, refField: "decision_refs" | "acceptance_refs" = "decision_refs", refPath = XREF) {
  const p = await createTempProject({ init: true, prefix: "step5-int-" });
  cleanups.push(p.cleanup);
  await mkdir(join(p.dir, "design", "decisions"), { recursive: true });
  await mkdir(join(p.dir, "design", "phases"), { recursive: true });
  await writeFile(join(p.dir, "design", "roadmap.yaml"), ROADMAP);
  await writeFile(join(p.dir, "design", "phases", "P1.yaml"), PHASE(refField, refPath));
  await writeFile(join(p.dir, XREF), adr);
  const o = await writeDecisionRecord(p.dir, XREF, { now: NOW });
  expect(o.kind).toBe("written");
  await rm(join(p.dir, XREF)); // retire: delete the live decision file
  return p;
}

const issues = (r: RunResult): { code: string; severity: string }[] => {
  try {
    return (JSON.parse(r.stdout) as { data?: { issues?: { code: string; severity: string }[] } }).data?.issues ?? [];
  } catch {
    return [];
  }
};
const hasErr = (r: RunResult, code: string) =>
  issues(r).some((i) => i.code === code && i.severity === "error");

/** The `decision` check verdict from a `verify --json` envelope (ok=true means the
 *  gate resolved). verify itself may still exit 1 for unrelated checks (task not
 *  done / no progress event), so we assert the DECISION check, not the exit code. */
const decisionCheckOk = (r: RunResult): boolean => {
  const checks = (JSON.parse(r.stdout) as { data?: { checks?: { name: string; ok: boolean }[] } }).data?.checks ?? [];
  return checks.find((c) => c.name === "decision")?.ok === true;
};

describe("A3: active decision gate survives a retired decision via an accepted record", () => {
  it("retired + ACCEPTED record → verify DECISION check green, task prepare not blocked, plan lint --strict green", async () => {
    const p = await scaffoldRetired(ACCEPTED);
    // The decision GATE resolves from the accepted record (verify may still exit 1
    // for unrelated checks like 'task not done' — we assert the decision check only).
    expect(decisionCheckOk(p.run(["verify", "--phase", "P1", "--task", "P1-T1", "--json"]))).toBe(true);
    const prep = p.run(["task", "prepare", "P1-T1", "--agent", "claude-code", "--json"]);
    expect(JSON.parse(prep.stdout).ok).toBe(true);
    const lint = p.run(["plan", "lint", "--strict", "--json"]);
    expect(JSON.parse(lint.stdout).ok).toBe(true);
    expect(hasErr(lint, "TASK_DECISION_REF_NOT_FOUND")).toBe(false);
  });

  it("retired + BLOCKED record → verify DECISION check fails closed; plan lint --strict red", async () => {
    const p = await scaffoldRetired(BLOCKED);
    expect(decisionCheckOk(p.run(["verify", "--phase", "P1", "--task", "P1-T1", "--json"]))).toBe(false);
    const lint = p.run(["plan", "lint", "--strict", "--json"]);
    expect(JSON.parse(lint.stdout).ok).toBe(false);
    expect(hasErr(lint, "TASK_DECISION_REF_NOT_FOUND")).toBe(true);
  });

  it("retired + NO record → verify DECISION check fails closed; plan lint --strict red", async () => {
    const p = await createTempProject({ init: true, prefix: "step5-int-" });
    cleanups.push(p.cleanup);
    await mkdir(join(p.dir, "design", "decisions"), { recursive: true });
    await mkdir(join(p.dir, "design", "phases"), { recursive: true });
    await writeFile(join(p.dir, "design", "roadmap.yaml"), ROADMAP);
    await writeFile(join(p.dir, "design", "phases", "P1.yaml"), PHASE("decision_refs", XREF));
    // No decision file, no record written at all.
    expect(decisionCheckOk(p.run(["verify", "--phase", "P1", "--task", "P1-T1", "--json"]))).toBe(false);
    expect(hasErr(p.run(["plan", "lint", "--strict", "--json"]), "TASK_DECISION_REF_NOT_FOUND")).toBe(true);
  });
});

describe("acceptance_refs stays strict for non-decision targets", () => {
  it("not-done task + acceptance_refs:[design/decisions/X.md] retired + valid record → advisory (no error)", async () => {
    const p = await scaffoldRetired(BLOCKED, "acceptance_refs", XREF);
    const lint = p.run(["plan", "lint", "--strict", "--json"]);
    // The acceptance_ref softens (any valid record); no acceptance-ref ERROR.
    expect(hasErr(lint, "TASK_ACCEPTANCE_REF_NOT_FOUND")).toBe(false);
  });

  it("not-done task + acceptance_refs:[docs/cli-contract.md] missing → error (never softened)", async () => {
    // Reuse a retired-X record but point acceptance_refs at a non-existent docs path.
    const p = await scaffoldRetired(ACCEPTED, "acceptance_refs", "docs/does-not-exist.md");
    const lint = p.run(["plan", "lint", "--strict", "--json"]);
    expect(JSON.parse(lint.stdout).ok).toBe(false);
    expect(hasErr(lint, "TASK_ACCEPTANCE_REF_NOT_FOUND")).toBe(true);
  });
});
