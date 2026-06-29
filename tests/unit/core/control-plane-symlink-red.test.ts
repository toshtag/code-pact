import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml } from "yaml";
import { runInit } from "../../../src/commands/init.ts";
import { runAdapterInstall } from "../../../src/commands/adapter-install.ts";
import { runAdapterDoctor } from "../../../src/commands/adapter-doctor.ts";
import { planPhaseSnapshot } from "../../../src/core/archive/phase-snapshot.ts";
import { planEventPack } from "../../../src/core/archive/event-pack.ts";
import { planDecisionRecord } from "../../../src/core/archive/decision-record.ts";
import { planArchiveRetention } from "../../../src/core/archive/archive-retention.ts";
import { evaluateRetire } from "../../../src/core/decisions/retire.ts";
import { evaluatePrune } from "../../../src/core/decisions/prune.ts";
import { collectInboundLinks } from "../../../src/core/decisions/link-collector.ts";
import { collectPlanArtifacts } from "../../../src/core/plan/state.ts";
import type { PhaseEntry } from "../../../src/core/plan/state.ts";

// ---------------------------------------------------------------------------
// Red tests: these MUST fail on the current HEAD and pass after the fixes.
//
// Tests:
//   2.1 phase snapshot in-project symlink → target not read
//   2.2 event pack phase symlink → target not read
//   2.3 decision record in-project symlink → target not read
//   2.4 task-prepare / plan lint ADR symlink → target not read
//   2.5 link collector docs root symlink → target not read
//   2.6 adapter doctor model profile symlink → structured issue, not empty
//   2.7 check:fs-authority fixture test
// ---------------------------------------------------------------------------

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-cp-symlink-red-"));
  await runInit({
    cwd: dir,
    locale: "en-US",
    agents: ["claude-code"],
    force: false,
    json: false,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 1\n`;
const TF = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;
const TASK_BODY = `  - id: P1-T1
    type: feature
${TF}
    status: in_progress
    description: Implements the thing
    requires_decision: true
    decision_refs:
      - design/decisions/D1.md
`;
const SYMLINK_TASK_BODY = `  - id: PRIVATE-TASK-MARKER
    type: feature
${TF}
    status: done
    description: Symlink target task
    requires_decision: false
`;
function phaseYaml(body: string): string {
  return `id: P1
name: P1
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
${body}`;
}
const ACCEPTED_ADR =
  "# RFC: D1\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\nSettled.\n\n## Commitments\n\n- [x] Done thing\n";

async function scaffoldPlan(cwd: string): Promise<void> {
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
  await mkdir(join(cwd, "design", "decisions"), { recursive: true });
  await writeFile(join(cwd, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(
    join(cwd, "design", "phases", "P1.yaml"),
    phaseYaml(TASK_BODY),
    "utf8",
  );
  await writeFile(
    join(cwd, "design", "decisions", "D1.md"),
    ACCEPTED_ADR,
    "utf8",
  );
}

async function makeSymlink(
  cwd: string,
  linkRel: string,
  targetContent: string,
  marker: string,
): Promise<string> {
  const linkAbs = join(cwd, linkRel);
  const targetAbs = join(
    cwd,
    `.symlink-target-${linkRel.replaceAll("/", "-")}`,
  );
  await mkdir(dirname(targetAbs), { recursive: true });
  await writeFile(targetAbs, targetContent.replace("MARKER", marker), "utf8");
  if (linkAbs !== join(cwd, linkRel)) {
    // no-op
  }
  await mkdir(dirname(linkAbs), { recursive: true });
  await rm(linkAbs, { recursive: true, force: true });
  await symlink(targetAbs, linkAbs, "file");
  return targetAbs;
}

async function makeSymlinkDir(
  cwd: string,
  linkRel: string,
  files: { name: string; content: string }[],
): Promise<string> {
  const linkAbs = join(cwd, linkRel);
  const targetAbs = join(
    cwd,
    `.symlink-target-${linkRel.replaceAll("/", "-")}`,
  );
  await mkdir(targetAbs, { recursive: true });
  for (const f of files) {
    await writeFile(join(targetAbs, f.name), f.content, "utf8");
  }
  await mkdir(dirname(linkAbs), { recursive: true });
  await rm(linkAbs, { recursive: true, force: true });
  await symlink(targetAbs, linkAbs, "dir");
  return targetAbs;
}

// ---------------------------------------------------------------------------
// 2.1 phase snapshot in-project symlink
// ---------------------------------------------------------------------------

describe("2.1 phase snapshot — in-project symlink target not read", () => {
  it("planPhaseSnapshot rejects symlinked phase, marker not in output", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-TASK-MARKER";
    const privatePhase = `id: P1
name: P1
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
${SYMLINK_TASK_BODY}`;
    await makeSymlink(dir, "design/phases/P1.yaml", privatePhase, marker);

    const plan = await planPhaseSnapshot(dir, "P1", {
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    // If the symlink target was read, the PRIVATE-TASK-MARKER task id would
    // appear in the snapshot's task list. It must NOT.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// 2.2 event pack phase symlink
// ---------------------------------------------------------------------------

describe("2.2 event pack — in-project symlink phase target not read", () => {
  it("planEventPack does not read symlinked phase target", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-TASK-MARKER";
    const privatePhase = `id: P1
name: P1
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
${SYMLINK_TASK_BODY}`;
    await makeSymlink(dir, "design/phases/P1.yaml", privatePhase, marker);

    const plan = await planEventPack(dir, "P1");

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// 2.3 decision record in-project symlink
// ---------------------------------------------------------------------------

describe("2.3 decision record — in-project symlink target not read", () => {
  it("planDecisionRecord does not read symlinked decision target", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-DECISION-MARKER";
    const privateDecision = `# RFC: D1\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\n${marker}\n`;
    await makeSymlink(dir, "design/decisions/D1.md", privateDecision, marker);

    const plan = await planDecisionRecord(dir, "design/decisions/D1.md", {
      now: new Date("2026-06-10T00:00:00.000Z"),
    });

    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// 2.4 decision commitment re-read (retire/prune)
// ---------------------------------------------------------------------------

describe("2.4 retire/prune — in-project symlink decision target not read", () => {
  it("evaluateRetire does not read symlinked decision marker", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-RETIRE-MARKER";
    const privateDecision = `# RFC: D1\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\n${marker}\n`;
    await makeSymlink(dir, "design/decisions/D1.md", privateDecision, marker);

    const { state, fallbackPhases } = await collectPlanArtifacts(dir);
    const phases: PhaseEntry[] = state?.phases ?? fallbackPhases;
    const result = await evaluateRetire(dir, "design/decisions/D1.md", phases);

    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("evaluatePrune does not read symlinked decision marker", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-PRUNE-MARKER";
    const privateDecision = `# RFC: D1\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\n${marker}\n`;
    await makeSymlink(dir, "design/decisions/D1.md", privateDecision, marker);

    const { state, fallbackPhases } = await collectPlanArtifacts(dir);
    const phases: PhaseEntry[] = state?.phases ?? fallbackPhases;
    const result = await evaluatePrune(dir, "design/decisions/D1.md", phases);

    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// 2.5 link collector docs root symlink
// ---------------------------------------------------------------------------

describe("2.5 link collector — docs root symlink not traversed", () => {
  it("collectInboundLinks does not read through symlinked docs directory", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-DOCS-MARKER";
    await makeSymlinkDir(dir, "docs", [
      {
        name: "private.md",
        content: `# Private\n\n${marker}\n\nSee [D1](../design/decisions/D1.md).\n`,
      },
    ]);

    const result = await collectInboundLinks(dir, "design/decisions/D1.md");

    // The marker must not appear in any item or issue
    expect(JSON.stringify(result)).not.toContain(marker);

    // The symlinked docs directory must not contribute any items
    // (items from a symlinked docs dir would contain "docs/private.md" as source_file)
    const symlinkItems = result.items.filter(i =>
      i.source_file.startsWith("docs/"),
    );
    expect(symlinkItems).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2.6 adapter doctor model profile symlink
// ---------------------------------------------------------------------------

describe("2.6 adapter doctor — model profile directory symlink is not silently skipped", () => {
  it("adapter doctor reports an issue for symlinked model-profiles directory", async () => {
    await runAdapterInstall({
      cwd: dir,
      agentName: "claude-code",
      force: false,
      locale: "en-US",
      generatorVersionOverride: "test",
    });

    // Replace model-profiles with a symlink to a private directory
    const targetAbs = join(dir, ".symlink-target-model-profiles");
    await mkdir(targetAbs, { recursive: true });
    await writeFile(
      join(targetAbs, "private.yaml"),
      stringifyYaml({ model: "private-model", context_budget: 999 }),
      "utf8",
    );
    await rm(join(dir, ".code-pact", "model-profiles"), {
      recursive: true,
      force: true,
    });
    await symlink(targetAbs, join(dir, ".code-pact", "model-profiles"), "dir");

    const result = await runAdapterDoctor({ cwd: dir, locale: "en-US" });

    // The result must NOT be silently clean — there must be an issue about the
    // unsafe model-profiles directory
    const codes = result.issues.map(i => i.code);
    expect(codes).toContain("MODEL_PROFILES_UNSAFE");

    // The private model must not appear in any issue or result
    expect(JSON.stringify(result)).not.toContain("private-model");
  });
});

// ---------------------------------------------------------------------------
// 2.7 archive retention phase symlink
// ---------------------------------------------------------------------------

describe("2.7 archive retention — in-project symlink phase target not read", () => {
  it("planArchiveRetention does not read symlinked phase marker", async () => {
    await scaffoldPlan(dir);
    const marker = "PRIVATE-TASK-MARKER";
    const privatePhase = `id: P1
name: P1
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
${SYMLINK_TASK_BODY}`;
    await makeSymlink(dir, "design/phases/P1.yaml", privatePhase, marker);

    const plans = await planArchiveRetention(dir, { keepLatest: 1 });

    expect(JSON.stringify(plans)).not.toContain(marker);
  });
});
