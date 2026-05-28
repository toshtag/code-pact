import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLint } from "../../../../src/core/plan/lint.ts";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "code-pact-plan-lint-"));
  await mkdir(join(cwd, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function writeRoadmap(content: string): Promise<void> {
  await writeFile(join(cwd, "design", "roadmap.yaml"), content, "utf8");
}

async function writePhase(filename: string, content: string): Promise<void> {
  await writeFile(join(cwd, "design", "phases", filename), content, "utf8");
}

type PhaseOptions = {
  weakDod?: boolean;
  placeholderVerification?: boolean;
  badTaskId?: boolean;
};

function phaseYaml(
  id: string,
  taskIds: string[] = [],
  options: PhaseOptions = {},
): string {
  const dod = options.weakDod
    ? ["tbd"]
    : ["DoD that is clearly long enough to read"];
  const verify = options.placeholderVerification
    ? ["echo placeholder"]
    : ["pnpm test"];
  return `id: ${id}
name: ${id}
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough
definition_of_done:
${dod.map((b) => `  - ${b}`).join("\n")}
verification:
  commands:
${verify.map((c) => `    - ${c}`).join("\n")}
tasks:
${taskIds
  .map(
    (t) => `  - id: ${t}
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned`,
  )
  .join("\n")}
`;
}

describe("runLint — clean project", () => {
  it("reports no issues when everything is consistent", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    const result = await runLint({ cwd });
    expect(result.issues).toEqual([]);
    expect(result.skippedChecks).toEqual([]);
    expect(result.includeQuality).toBe(false);
  });
});

describe("runLint — structural failures", () => {
  it("flags duplicate task ids across phases", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n  - id: P2\n    path: design/phases/P2.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["SHARED-T1"]));
    await writePhase("P2.yaml", phaseYaml("P2", ["SHARED-T1"]));

    const result = await runLint({ cwd });
    const dup = result.issues.find((i) => i.code === "DUPLICATE_TASK_ID");
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe("error");
  });

  it("flags orphan phase files in design/phases/", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));
    await writePhase("P9-stray.yaml", phaseYaml("P9", ["P9-T1"]));

    const result = await runLint({ cwd });
    const orphan = result.issues.find(
      (i) => i.code === "ORPHAN_PHASE_FILE" && i.severity === "warning",
    );
    expect(orphan).toBeDefined();
  });

  it("flags missing phase files referenced by roadmap", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n  - id: P9\n    path: design/phases/P9-missing.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    const result = await runLint({ cwd });
    const missing = result.issues.find((i) => i.code === "MISSING_PHASE_FILE");
    expect(missing).toBeDefined();
    expect(missing?.severity).toBe("error");
  });
});

describe("runLint — naming heuristics", () => {
  it("warns when a task id does not start with its phase prefix", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["WRONG-T1"]));

    const result = await runLint({ cwd });
    const naming = result.issues.find(
      (i) => i.code === "TASK_ID_PHASE_PREFIX",
    );
    expect(naming).toBeDefined();
    expect(naming?.severity).toBe("warning");
  });
});

describe("runLint — broken roadmap", () => {
  it("reports the roadmap parse error and surfaces skipped checks", async () => {
    await writeRoadmap("not: { valid yaml at all\n");
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    const result = await runLint({ cwd });
    expect(result.issues.some((i) => i.code === "INVALID_YAML")).toBe(true);
    expect(result.skippedChecks).toContain("MISSING_PHASE_FILE");
    expect(result.skippedChecks).toContain("ORPHAN_PHASE_FILE");
  });
});

describe("runLint — quality heuristics", () => {
  it("does NOT report quality issues by default", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"], { weakDod: true }));

    const result = await runLint({ cwd });
    expect(result.issues.some((i) => i.code === "WEAK_DOD")).toBe(false);
  });

  it("reports WEAK_DOD when DoD bullets are placeholders and --include-quality is set", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"], { weakDod: true }));

    const result = await runLint({ cwd, includeQuality: true });
    const weak = result.issues.find((i) => i.code === "WEAK_DOD");
    expect(weak).toBeDefined();
    expect(weak?.severity).toBe("warning");
  });

  it("reports PLACEHOLDER_VERIFICATION when commands look fake and --include-quality is set", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase(
      "P1.yaml",
      phaseYaml("P1", ["P1-T1"], { placeholderVerification: true }),
    );

    const result = await runLint({ cwd, includeQuality: true });
    const placeholder = result.issues.find(
      (i) => i.code === "PLACEHOLDER_VERIFICATION",
    );
    expect(placeholder).toBeDefined();
    expect(placeholder?.severity).toBe("warning");
  });
});

describe("runLint — P31 clarify advisories", () => {
  const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;

  // A phase whose single task carries the given extra YAML lines. Phase-level
  // fields (confidence, requires_decision) are templated via `phaseExtra`.
  function phaseDoc(opts: {
    confidence?: string;
    phaseRequiresDecision?: boolean;
    taskLines?: string[];
  }): string {
    const taskLines = opts.taskLines ?? [
      "description: Implements the thing",
    ];
    return `id: P1
name: P1
weight: 10
confidence: ${opts.confidence ?? "medium"}
risk: low
status: planned
objective: An objective long enough
${opts.phaseRequiresDecision ? "requires_decision: true\n" : ""}definition_of_done:
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
${taskLines.map((l) => `    ${l}`).join("\n")}
`;
  }

  async function writeAdr(name: string): Promise<void> {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", name), "x", "utf8");
  }

  it("reports TASK_DECISION_UNRESOLVED (source task) when requires_decision and no ADR", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ taskLines: ["description: x", "requires_decision: true"] }),
    );

    const result = await runLint({ cwd, includeQuality: true });
    const issue = result.issues.find((i) => i.code === "TASK_DECISION_UNRESOLVED");
    expect(issue).toBeDefined();
    expect(issue?.affects_exit).toBe(false);
    expect(issue?.task_id).toBe("P1-T1");
    expect(issue?.details?.source).toBe("task");
  });

  it("does NOT report TASK_DECISION_UNRESOLVED once a matching ADR exists", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ taskLines: ["description: x", "requires_decision: true"] }),
    );
    await writeAdr("P1-T1-decision.md");

    const result = await runLint({ cwd, includeQuality: true });
    expect(
      result.issues.some((i) => i.code === "TASK_DECISION_UNRESOLVED"),
    ).toBe(false);
  });

  it("still reports TASK_DECISION_UNRESOLVED when the ADR exists but is `proposed` (status-aware)", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ taskLines: ["description: x", "requires_decision: true"] }),
    );
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(
      join(cwd, "design", "decisions", "P1-T1-decision.md"),
      "**Status:** proposed (unscheduled, 2026-05)\n",
      "utf8",
    );

    const result = await runLint({ cwd, includeQuality: true });
    const issue = result.issues.find((i) => i.code === "TASK_DECISION_UNRESOLVED");
    expect(issue).toBeDefined();
    expect(issue?.affects_exit).toBe(false);
    expect(issue?.message).toContain('is "proposed"');
    const details = issue?.details as { via?: string; reason?: string } | undefined;
    expect(details?.via).toBe("filename-scan");
    expect(details?.reason).toContain('is "proposed"');
  });

  it("reports TASK_DECISION_UNRESOLVED (source phase) for a phase-level requires_decision", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ phaseRequiresDecision: true, taskLines: ["description: x"] }),
    );

    const result = await runLint({ cwd, includeQuality: true });
    const issue = result.issues.find((i) => i.code === "TASK_DECISION_UNRESOLVED");
    expect(issue).toBeDefined();
    expect(issue?.details?.source).toBe("phase");
  });

  async function writeAdrContent(name: string, content: string): Promise<void> {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", name), content, "utf8");
  }

  it("reports ADR_STATUS_UNRECOGNIZED for a typo'd bold-line status", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({}));
    await writeAdrContent("some-adr.md", "**Status:** acceptd\n");

    const result = await runLint({ cwd, includeQuality: true });
    const issue = result.issues.find((i) => i.code === "ADR_STATUS_UNRECOGNIZED");
    expect(issue).toBeDefined();
    expect(issue?.affects_exit).toBe(false);
    expect(issue?.file).toBe("design/decisions/some-adr.md");
    expect(issue?.details?.status).toBe("acceptd");
    expect(issue?.details?.status_source).toBe("bold-line");
  });

  it("reports ADR_STATUS_UNRECOGNIZED with status_source frontmatter (frontmatter wins)", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({}));
    await writeAdrContent("fm-adr.md", "---\nstatus: acceptd\n---\n\n**Status:** accepted\n");

    const result = await runLint({ cwd, includeQuality: true });
    const issue = result.issues.find((i) => i.code === "ADR_STATUS_UNRECOGNIZED");
    expect(issue?.details?.status).toBe("acceptd");
    expect(issue?.details?.status_source).toBe("frontmatter");
  });

  it("does NOT report ADR_STATUS_UNRECOGNIZED for accepted / proposed / no-status / empty ADRs", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({}));
    await writeAdrContent("a.md", "**Status:** accepted\n");
    await writeAdrContent("b.md", "**Status:** proposed\n");
    await writeAdrContent("c.md", "# Decision\nbody\n");
    await writeAdrContent("d.md", "\n");

    const result = await runLint({ cwd, includeQuality: true });
    expect(result.issues.some((i) => i.code === "ADR_STATUS_UNRECOGNIZED")).toBe(false);
  });

  it("does NOT report ADR_STATUS_UNRECOGNIZED when includeQuality is off", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({}));
    await writeAdrContent("some-adr.md", "**Status:** acceptd\n");

    const result = await runLint({ cwd });
    expect(result.issues.some((i) => i.code === "ADR_STATUS_UNRECOGNIZED")).toBe(false);
  });

  it("a gated task pointing at a typo'd ADR fires BOTH TASK_DECISION_UNRESOLVED and ADR_STATUS_UNRECOGNIZED", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ taskLines: ["description: x", "requires_decision: true"] }),
    );
    await writeAdrContent("P1-T1-rfc.md", "**Status:** acceptd\n");

    const codes = (await runLint({ cwd, includeQuality: true })).issues.map((i) => i.code);
    expect(codes).toContain("TASK_DECISION_UNRESOLVED");
    expect(codes).toContain("ADR_STATUS_UNRECOGNIZED");
  });

  it("reports PHASE_CONFIDENCE_LOW for confidence: low, not for medium", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ confidence: "low" }));
    let result = await runLint({ cwd, includeQuality: true });
    const low = result.issues.find((i) => i.code === "PHASE_CONFIDENCE_LOW");
    expect(low).toBeDefined();
    expect(low?.affects_exit).toBe(false);

    await writePhase("P1.yaml", phaseDoc({ confidence: "high" }));
    result = await runLint({ cwd, includeQuality: true });
    expect(result.issues.some((i) => i.code === "PHASE_CONFIDENCE_LOW")).toBe(
      false,
    );
  });

  it("reports TASK_DESCRIPTION_MISSING when description is absent, not when present", async () => {
    await writeRoadmap(ROADMAP);
    // No extra task lines → description absent.
    await writePhase("P1.yaml", phaseDoc({ taskLines: [] }));
    let result = await runLint({ cwd, includeQuality: true });
    const missing = result.issues.find(
      (i) => i.code === "TASK_DESCRIPTION_MISSING",
    );
    expect(missing).toBeDefined();
    expect(missing?.affects_exit).toBe(false);

    await writePhase("P1.yaml", phaseDoc({ taskLines: ["description: present"] }));
    result = await runLint({ cwd, includeQuality: true });
    expect(
      result.issues.some((i) => i.code === "TASK_DESCRIPTION_MISSING"),
    ).toBe(false);
  });

  it("does NOT report any P31 advisory without --include-quality", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ confidence: "low", taskLines: ["requires_decision: true"] }),
    );
    const result = await runLint({ cwd });
    const codes = result.issues.map((i) => i.code);
    expect(codes).not.toContain("TASK_DECISION_UNRESOLVED");
    expect(codes).not.toContain("PHASE_CONFIDENCE_LOW");
    expect(codes).not.toContain("TASK_DESCRIPTION_MISSING");
  });
});
