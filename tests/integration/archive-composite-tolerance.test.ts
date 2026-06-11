import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { writePhaseSnapshot } from "../../src/core/archive/phase-snapshot.ts";
import { writeDecisionRecord } from "../../src/core/archive/decision-record.ts";

// design-docs-ephemeral STEP 6 — "Tolerance, scoped". This pins the A2 + A3
// *composite* state across the five consumer surfaces (validate / doctor /
// plan lint / task context / task prepare). It adds NO new runtime reader
// behavior: it locks the tolerance already landed by steps 4a / 4b (phase
// snapshots) and step 5 (decision-state records), proving they do not regress
// each other when BOTH a completed phase YAML AND the whole design/decisions
// directory are hand-deleted at once.
//
// A2 (step 4a): hand-`rm` a completed phase whose roadmap ref stays + valid
//   snapshot → control plane green.
// A3 (step 5): hand-`rm -rf design/decisions` is tolerated ONLY when every
//   active gate's decision is a valid ACCEPTED decision-state record; a
//   non-accepted / missing record fails the gate closed.
//
// SURFACE RESPONSIBILITY BOUNDARY (asserted by the test names, per the design):
//   - `verify` (the `decision` check) is the gate ENFORCEMENT point. A retired
//     decision releases the gate iff its record is accepted; otherwise closed.
//   - `plan lint --strict` is the lint enforcement point for decision_refs.
//   - `task prepare` is ADVISORY: for a requires_decision task it always reports
//     lifecycleMode `decision_loop` (independent of ADR acceptance), so its
//     envelope stays ok:true whether or not the gate is released — it is NOT a
//     gate-enforcement surface and must not be asserted as one.
//   - `doctor` / `validate` do NOT inspect decision gates at all; a deleted
//     design/decisions is outside their remit, so they stay green on A3. This is
//     the intended responsibility split, NOT a gap to "fix".

let tmpDir: string;
const NOW = new Date("2026-06-10T00:00:00.000Z");
const XREF = "design/decisions/x-rfc.md";
const ACCEPTED = "# RFC: X\n\n**Status:** accepted (P9, 2026-06)\n\n## Decision\n\nSettled body here.\n";
const BLOCKED = "# RFC: X\n\n**Status:** proposed\n\n## Decision\n\nNot yet settled.\n";

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

const ROADMAP = `phases:
  - id: P1
    path: design/phases/P1-x.yaml
    weight: 2
  - id: P2
    path: design/phases/P2-y.yaml
    weight: 1
`;

// P1-T1 (done) carries a STALE `reads` glob that matches no file on disk. While
// P1 is live this fires TASK_READS_NO_MATCH (a real lint warning); after P1's YAML
// is hand-deleted + tolerated by its snapshot, P1 never enters PlanState.phases, so
// detectTaskReadsNoMatch (which only walks live phases) cannot reach it. The
// composite tests assert the warning is GONE post-delete — the direct proof of the
// directive's "audit false-positive" claim (a stale read WAS firing pre-delete).
const STALE_READ = "src/archived-phase-only-stale.ts";

const P1_DONE = `id: P1
name: Foundations
weight: 2
confidence: high
risk: low
status: done
objective: Build the base
definition_of_done:
  - it works
verification:
  commands:
    - "true"
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: done
    reads:
      - ${STALE_READ}
`;

// P2-T1 (active) BOTH depends_on the deleted P1-T1 (A2 path) AND gates on the
// retired decision X via explicit decision_refs (A3 path) — the composite.
const P2_DEP_DECISION = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment of work
definition_of_done:
  - The next increment is implemented and its tests pass
verification:
  commands:
    - "true"
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    requires_decision: true
    decision_refs:
      - ${XREF}
    depends_on:
      - P1-T1
`;

// Same composite but the active task relies on a FILENAME SCAN (no explicit
// decision_refs) — a record can NEVER release a filename-scan gate (no canonical
// key to look up), so A3 must fail this closed even with an accepted record.
const P2_FILENAME_SCAN = `id: P2
name: Next
weight: 1
confidence: high
risk: low
status: in_progress
objective: Build the next increment of work
definition_of_done:
  - The next increment is implemented and its tests pass
verification:
  commands:
    - "true"
tasks:
  - id: P2-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    requires_decision: true
    depends_on:
      - P1-T1
`;

const PROGRESS = `events:
  - task_id: P1-T1
    status: done
    at: 2026-06-01T00:00:00.000Z
    actor: agent
  - task_id: P2-T1
    status: started
    at: 2026-06-02T00:00:00.000Z
    actor: agent
`;

function jsonOk(r: RunResult): boolean {
  try {
    return (JSON.parse(r.stdout) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** The `decision` check verdict from a `verify --json` envelope — the real gate
 *  enforcement point. verify itself may exit 1 for unrelated checks (task not
 *  done / no progress event), so we read the DECISION check, not the exit code. */
function decisionCheckOk(r: RunResult): boolean {
  const checks = (JSON.parse(r.stdout) as { data?: { checks?: { name: string; ok: boolean }[] } })
    .data?.checks ?? [];
  return checks.find((c) => c.name === "decision")?.ok === true;
}

function hasDecisionRefError(r: RunResult): boolean {
  const issues = (JSON.parse(r.stdout) as { data?: { issues?: { code: string; severity: string }[] } })
    .data?.issues ?? [];
  return issues.some((i) => i.code === "TASK_DECISION_REF_NOT_FOUND" && i.severity === "error");
}

// `init` scaffolds a complete project so validate/doctor have no unrelated
// failures; then overlay the roadmap + phases + progress + the live decision.
async function scaffold(adr: string, p2: string = P2_DEP_DECISION): Promise<void> {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1-x.yaml"), P1_DONE, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P2-y.yaml"), p2, "utf8");
  await mkdir(join(tmpDir, ".code-pact", "state"), { recursive: true });
  await writeFile(join(tmpDir, ".code-pact", "state", "progress.yaml"), PROGRESS, "utf8");
  await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
  await writeFile(join(tmpDir, XREF), adr, "utf8");
}

/** Apply the composite hand-delete: rm the completed phase YAML AND rm -rf the
 *  whole design/decisions directory. */
async function handDeleteComposite(): Promise<void> {
  await rm(join(tmpDir, "design", "phases", "P1-x.yaml"));
  await rm(join(tmpDir, "design", "decisions"), { recursive: true });
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-archive-composite-int-"));
});

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("Step 6 — A2+A3 composite tolerance across the five surfaces", () => {
  it("POSITIVE: completed phase YAML + design/decisions both hand-deleted, ACCEPTED record → all five surfaces tolerant, gate released", async () => {
    await scaffold(ACCEPTED);
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    expect((await writeDecisionRecord(tmpDir, XREF, { now: NOW })).kind).toBe("written");
    await handDeleteComposite();

    // validate / doctor: green (A2 via snapshot; decisions are outside their remit).
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    expect(jsonOk(run(["doctor", "--json"]))).toBe(true);

    // plan lint --strict: green — the accepted record softens the missing decision_ref
    // AND the snapshot tolerates the deleted phase. No decision-ref error.
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(true);
    expect(hasDecisionRefError(lint)).toBe(false);
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    // AUDIT FALSE-POSITIVE PROOF: P1-T1's stale `reads` glob (STALE_READ) fired
    // TASK_READS_NO_MATCH while P1 was live; now that P1's YAML is hand-deleted and
    // tolerated by its snapshot, P1 is not in PlanState.phases, so the reads detector
    // never reaches it. The warning is gone — plan-lint needs no archive-aware reads
    // detector for the missing-archived-docs scope (it would for a LIVE phase, which
    // is the separate `plan sync-paths` concern, out of this directive's scope).
    expect(lint.stdout).not.toContain("TASK_READS_NO_MATCH");

    // task context / task prepare on the live active task: not blocked.
    expect(jsonOk(run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
    const prep = run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]);
    expect(jsonOk(prep)).toBe(true);
    expect(prep.stdout).not.toContain("wait_for_dependencies");

    // The GATE enforcement point: verify's decision check is RELEASED by the record.
    const verify = run(["verify", "--phase", "P2", "--task", "P2-T1", "--json"]);
    expect(decisionCheckOk(verify)).toBe(true);
  });

  it("NEGATIVE (gate): same composite but NON-ACCEPTED record → verify gate + plan lint fail closed; validate/doctor stay green (decisions outside their remit)", async () => {
    await scaffold(BLOCKED);
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    expect((await writeDecisionRecord(tmpDir, XREF, { now: NOW })).kind).toBe("written");
    await handDeleteComposite();

    // The gate enforcement point fails closed: a non-accepted record never releases.
    const verify = run(["verify", "--phase", "P2", "--task", "P2-T1", "--json"]);
    expect(decisionCheckOk(verify)).toBe(false);

    // plan lint --strict fails closed with the decision-ref error.
    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(false);
    expect(hasDecisionRefError(lint)).toBe(true);

    // A2 (phase) is still tolerated → no phase-side failure leaks in.
    expect(lint.stdout).not.toContain("PHASE_SNAPSHOT_INVALID");
    expect(lint.stdout).not.toContain("TASK_DEPENDS_ON_UNRESOLVED");
    // The decision-ref ERROR is the only failure — the deleted phase's stale `reads`
    // does NOT leak a TASK_READS_NO_MATCH warning into the (already-red) envelope.
    // (exit is red regardless here, so assert the issue's absence directly.)
    expect(lint.stdout).not.toContain("TASK_READS_NO_MATCH");

    // RESPONSIBILITY BOUNDARY: validate / doctor never inspect decision gates, so a
    // deleted design/decisions does NOT make them red. This is intended, not a gap.
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    expect(jsonOk(run(["doctor", "--json"]))).toBe(true);

    // ADVISORY (closed-gate half): task context / task prepare are NOT gate
    // enforcement surfaces — their envelope stays ok:true even though the gate is
    // CLOSED. (The positive test pins the open-gate half; this pins the closed-gate
    // half, so a future change that made prepare/context fail on a non-accepted
    // record would be caught here, not pass silently.)
    expect(jsonOk(run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
    expect(jsonOk(run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
  });

  it("NEGATIVE (gate): same composite with NO record at all → verify gate + plan lint fail closed", async () => {
    await scaffold(ACCEPTED);
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    // Deliberately write NO decision record before deleting the directory.
    await handDeleteComposite();

    const verify = run(["verify", "--phase", "P2", "--task", "P2-T1", "--json"]);
    expect(decisionCheckOk(verify)).toBe(false);

    const lint = run(["plan", "lint", "--strict", "--json"]);
    expect(jsonOk(lint)).toBe(false);
    expect(hasDecisionRefError(lint)).toBe(true);

    // Phase tolerance still holds.
    expect(lint.stdout).not.toContain("PHASE_SNAPSHOT_INVALID");

    // ADVISORY (closed-gate half): the non-enforcement surfaces stay green.
    expect(jsonOk(run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
    expect(jsonOk(run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
  });

  it("NEGATIVE (filename-scan): composite + accepted record but NO explicit decision_refs → gate fails closed (a record cannot release a filename-scan gate)", async () => {
    await scaffold(ACCEPTED, P2_FILENAME_SCAN);
    await writePhaseSnapshot(tmpDir, "P1", { now: NOW });
    // An accepted record EXISTS, but the active gate has no decision_refs — there is
    // no canonical key to look up, so the record can never release it.
    expect((await writeDecisionRecord(tmpDir, XREF, { now: NOW })).kind).toBe("written");
    await handDeleteComposite();

    // The gate fails closed: filename-scan resolution finds no live ADR and is never
    // record-backed.
    const verify = run(["verify", "--phase", "P2", "--task", "P2-T1", "--json"]);
    expect(decisionCheckOk(verify)).toBe(false);

    // A2 (phase) is unaffected — validate/doctor green, no phase-snapshot error.
    expect(jsonOk(run(["validate", "--json"]))).toBe(true);
    expect(jsonOk(run(["doctor", "--json"]))).toBe(true);

    // ADVISORY (closed-gate half): a filename-scan task has NO decision_refs — a
    // distinct surface shape from the explicit-refs cases above — yet the advisory
    // surfaces still stay green with the gate closed.
    expect(jsonOk(run(["task", "context", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
    expect(jsonOk(run(["task", "prepare", "P2-T1", "--agent", "claude-code", "--json"]))).toBe(true);
  });
});
