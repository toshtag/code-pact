import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLint, detectAdrAcceptedBodyThin } from "../../../../src/core/plan/lint.ts";

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

describe("runLint — ADR_ACCEPTED_BODY_THIN (P36)", () => {
  // A minimal, lint-clean plan so the run reaches the quality block.
  const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;
  const PHASE = `id: P1
name: P1
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough to read
verification:
  commands:
    - pnpm test
`;

  async function writeAdr(name: string, content: string): Promise<void> {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", name), content, "utf8");
  }

  async function run(): Promise<string[]> {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", PHASE);
    const result = await runLint({ cwd, includeQuality: true });
    return result.issues
      .filter((i) => i.code === "ADR_ACCEPTED_BODY_THIN")
      .map((i) => i.file ?? "");
  }

  // A body long enough to clear the threshold (~80 chars × several lines).
  const FAT = Array.from(
    { length: 8 },
    (_, i) => `Sentence number ${i} that adds a fair amount of substantive prose here.`,
  ).join("\n\n");

  it("fires for an accepted ADR that is just a status line (the target stub)", async () => {
    await writeAdr("stub.md", "**Status:** accepted\n");
    expect(await run()).toContain("design/decisions/stub.md");
  });

  it("fires for an accepted ADR with a title + status line but no real body", async () => {
    await writeAdr("thin.md", "# Decision X\n\n**Status:** accepted\n");
    expect(await run()).toContain("design/decisions/thin.md");
  });

  it("does NOT fire when the accepted ADR has substantive prose (no headings)", async () => {
    await writeAdr("prose.md", `**Status:** accepted\n\n${FAT}\n`);
    expect(await run()).not.toContain("design/decisions/prose.md");
  });

  it("does NOT fire when a short accepted ADR has at least one h2 heading", async () => {
    await writeAdr(
      "structured.md",
      "**Status:** accepted\n\n## Decision\n\nShort.\n",
    );
    expect(await run()).not.toContain("design/decisions/structured.md");
  });

  it("does NOT fire for a thin proposed ADR (only accepted is in scope)", async () => {
    await writeAdr("proposed.md", "**Status:** proposed\n");
    expect(await run()).not.toContain("design/decisions/proposed.md");
  });

  it("does NOT fire for a 0-byte empty file (acceptance: empty)", async () => {
    await writeAdr("empty.md", "");
    expect(await run()).not.toContain("design/decisions/empty.md");
  });

  it("strips a `- Status:` list-format line too (still fires when thin)", async () => {
    await writeAdr("list.md", "# T\n\n- Status: accepted\n");
    expect(await run()).toContain("design/decisions/list.md");
  });

  it("does not run without --include-quality", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", PHASE);
    await writeAdr("stub.md", "**Status:** accepted\n");
    const result = await runLint({ cwd });
    expect(result.issues.map((i) => i.code)).not.toContain(
      "ADR_ACCEPTED_BODY_THIN",
    );
  });

  // Regression pin: this repo's own ADRs are all real (the smallest is several
  // KB with multiple h2 sections), so the advisory must NEVER fire against the
  // live corpus. If someone lands a genuine accepted-but-empty stub under
  // design/decisions/, this test SHOULD fail — that is the intended signal.
  // Calls the detector directly (not full runLint) so it only reads the ADR
  // corpus, staying fast and deterministic.
  it("produces zero ADR_ACCEPTED_BODY_THIN against this repo's real ADRs", async () => {
    const repoRoot = new URL("../../../../", import.meta.url).pathname;
    const issues = await detectAdrAcceptedBodyThin(repoRoot);
    expect(issues.map((i) => i.file)).toEqual([]);
  });
});

describe("runLint — ADR_COMMITMENTS_EMPTY (P43)", () => {
  const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;

  // A lint-clean phase whose single task carries the given extra YAML lines.
  function phaseDoc(opts: { phaseRequiresDecision?: boolean; taskLines?: string[] }): string {
    const taskLines = opts.taskLines ?? ["description: Implements the thing"];
    return `id: P1
name: P1
weight: 10
confidence: medium
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

  async function writeAdr(name: string, content: string): Promise<void> {
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    await writeFile(join(cwd, "design", "decisions", name), content, "utf8");
  }

  /** Run with a gated task (filename-scan matches `P1-T1-*.md`) + the given ADR. */
  async function runGated(adrName: string, adrContent: string, includeQuality = true) {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ taskLines: ["description: x", "requires_decision: true"] }));
    await writeAdr(adrName, adrContent);
    return runLint({ cwd, ...(includeQuality ? { includeQuality: true } : {}) });
  }

  function commitmentsIssues(result: Awaited<ReturnType<typeof runLint>>) {
    return result.issues.filter((i) => i.code === "ADR_COMMITMENTS_EMPTY");
  }

  it("does NOT fire when the accepted ADR has commitment items", async () => {
    const result = await runGated(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [ ] Do the work\n",
    );
    expect(commitmentsIssues(result)).toEqual([]);
  });

  it("fires when the referenced accepted ADR has NO commitments section", async () => {
    const result = await runGated("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nChose X.\n");
    const issues = commitmentsIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.affects_exit).toBe(false);
    expect(issues[0]?.file).toBe("design/decisions/P1-T1-rfc.md");
    expect(issues[0]?.task_id).toBe("P1-T1");
    expect(issues[0]?.details?.has_section).toBe(false);
  });

  it("fires when the section is present but has zero checkbox items", async () => {
    const result = await runGated(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\nTBD, prose only.\n",
    );
    const issues = commitmentsIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.details?.has_section).toBe(true);
    expect(issues[0]?.details?.item_count).toBe(0);
  });

  it("does NOT fire for a PROPOSED ADR (only accepted is in scope)", async () => {
    const result = await runGated("P1-T1-rfc.md", "**Status:** proposed\n\n## Decision\n\nX.\n");
    expect(commitmentsIssues(result)).toEqual([]);
  });

  it("does NOT fire for an accepted ADR that no gated task references", async () => {
    await writeRoadmap(ROADMAP);
    // Task is NOT requires_decision → the ADR is not gated-task-referenced.
    await writePhase("P1.yaml", phaseDoc({ taskLines: ["description: x"] }));
    await writeAdr("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nX.\n");
    const result = await runLint({ cwd, includeQuality: true });
    expect(commitmentsIssues(result)).toEqual([]);
  });

  it("does not run without --include-quality", async () => {
    const result = await runGated("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nX.\n", false);
    expect(commitmentsIssues(result)).toEqual([]);
  });

  it("does NOT fire when the only item is a checked no-work statement", async () => {
    const result = await runGated(
      "P1-T1-rfc.md",
      "**Status:** accepted\n\n## Implementation commitments\n\n- [x] No downstream implementation work.\n",
    );
    expect(commitmentsIssues(result)).toEqual([]);
  });

  it("emits exactly one issue when one ADR is referenced by two gated tasks", async () => {
    await writeRoadmap(ROADMAP);
    // Two gated tasks both pointing at the same ADR via explicit decision_refs.
    await writePhase(
      "P1.yaml",
      `id: P1
name: P1
weight: 10
confidence: medium
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
    description: x
    requires_decision: true
    decision_refs:
      - design/decisions/shared-rfc.md
  - id: P1-T2
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned
    description: y
    requires_decision: true
    decision_refs:
      - design/decisions/shared-rfc.md
`,
    );
    await writeAdr("shared-rfc.md", "**Status:** accepted\n\n## Decision\n\nX.\n");
    const issues = commitmentsIssues(await runLint({ cwd, includeQuality: true }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toBe("design/decisions/shared-rfc.md");
  });

  it("fires for a phase-level requires_decision task", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ phaseRequiresDecision: true, taskLines: ["description: x"] }));
    await writeAdr("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nX.\n");
    const issues = commitmentsIssues(await runLint({ cwd, includeQuality: true }));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.task_id).toBe("P1-T1");
  });

  it("never changes the exit code (affects_exit:false), even under --strict", async () => {
    const result = await runGated("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nX.\n");
    const issue = commitmentsIssues(result)[0];
    expect(issue).toBeDefined();
    expect(issue?.affects_exit).toBe(false);
  });

  it("omits the `path` field (the subject is ADR content, not a plan-YAML field)", async () => {
    const result = await runGated("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nX.\n");
    const issue = commitmentsIssues(result)[0];
    expect(issue).toBeDefined();
    expect(issue?.path).toBeUndefined();
  });

  it("does NOT fire when explicit decision_refs are only partially accepted (gate unresolved)", async () => {
    // all-must-be-accepted: one proposed ref leaves the gate UNRESOLVED, so the
    // one accepted ref must not fire (the message claims the ADR "resolves" the
    // gate — it does not). TASK_DECISION_UNRESOLVED covers the unresolved case.
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({
        taskLines: [
          "description: x",
          "requires_decision: true",
          "decision_refs:",
          "  - design/decisions/a.md",
          "  - design/decisions/b.md",
        ],
      }),
    );
    await writeAdr("a.md", "**Status:** accepted\n\n## Decision\n\nX (no commitments).\n");
    await writeAdr("b.md", "**Status:** proposed\n\n## Decision\n\nY.\n");
    const result = await runLint({ cwd, includeQuality: true });
    expect(commitmentsIssues(result)).toEqual([]);
    // sanity: the gate really is unresolved here
    expect(result.issues.some((i) => i.code === "TASK_DECISION_UNRESOLVED")).toBe(true);
  });
});

describe("runLint — PHASE_DOCS_WRITE_NO_DOC_CHECK (P43 docs-drift guard)", () => {
  const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;

  // A phase with the given status, verification commands, and a single task
  // whose `writes` is `taskWrites`.
  function phaseDoc(opts: {
    status?: string;
    commands?: string[];
    taskWrites?: string[];
  }): string {
    const commands = opts.commands ?? ["pnpm test"];
    const writes = opts.taskWrites ?? [];
    return `id: P1
name: P1
weight: 10
confidence: medium
risk: low
status: ${opts.status ?? "planned"}
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough to read
verification:
  commands:
${commands.map((c) => `    - ${c}`).join("\n")}
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
    description: a task long enough to read
${writes.length > 0 ? `    writes:\n${writes.map((w) => `      - ${w}`).join("\n")}\n` : ""}`;
  }

  function fired(result: Awaited<ReturnType<typeof runLint>>): boolean {
    return result.issues.some((i) => i.code === "PHASE_DOCS_WRITE_NO_DOC_CHECK");
  }

  it("fires for a not-done phase that writes a docs/ file but runs no doc check", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ taskWrites: ["docs/cli-contract.md"] }));
    const result = await runLint({ cwd, includeQuality: true });
    const issue = result.issues.find((i) => i.code === "PHASE_DOCS_WRITE_NO_DOC_CHECK");
    expect(issue).toBeDefined();
    expect(issue?.affects_exit).toBe(false);
    expect(issue?.phase_id).toBe("P1");
    expect(issue?.details?.doc_write).toBe("docs/cli-contract.md");
  });

  it("does NOT fire when the phase verification includes a doc check", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase(
      "P1.yaml",
      phaseDoc({ commands: ["pnpm test", "pnpm check:docs"], taskWrites: ["docs/cli-contract.md"] }),
    );
    expect(fired(await runLint({ cwd, includeQuality: true }))).toBe(false);
  });

  it("does NOT fire for a CHANGELOG.md write (check:docs does not scan it)", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ taskWrites: ["CHANGELOG.md"] }));
    expect(fired(await runLint({ cwd, includeQuality: true }))).toBe(false);
  });

  it("does NOT fire for a design/ write (validated elsewhere, not by check:docs)", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ taskWrites: ["design/decisions/some-rfc.md"] }));
    expect(fired(await runLint({ cwd, includeQuality: true }))).toBe(false);
  });

  it("does NOT fire for a done phase (forward-looking guard only)", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ status: "done", taskWrites: ["docs/cli-contract.md"] }));
    expect(fired(await runLint({ cwd, includeQuality: true }))).toBe(false);
  });

  it("fires on a root-level public .md (e.g. README.md) too", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ taskWrites: ["README.md"] }));
    expect(fired(await runLint({ cwd, includeQuality: true }))).toBe(true);
  });

  it("does not run without --include-quality", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", phaseDoc({ taskWrites: ["docs/cli-contract.md"] }));
    expect(fired(await runLint({ cwd }))).toBe(false);
  });
});

// P50 — Context Fit advisories gate. Uses TASK_DECLARED_DECISION_LARGE because
// it does not need an agent/pack build, so the gating contract is exercised
// without coupling to context-pack byte sizes (those are covered in
// tests/unit/core/context-fit/advisories.test.ts).
describe("runLint — P50 context-fit advisories (--include-quality gate)", () => {
  const P50_CODES = new Set([
    "TASK_CONTEXT_PACK_LARGE",
    "TASK_CONTEXT_BUDGET_UNACHIEVABLE",
    "TASK_DECLARED_DECISION_LARGE",
    "TASK_READS_MATCH_TOO_MANY",
  ]);

  async function writeBigDecisionPlan(): Promise<void> {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase(
      "P1.yaml",
      `id: P1
name: P1
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  - A definition of done that is long enough
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
    decision_refs:
      - design/decisions/big.md
`,
    );
    await mkdir(join(cwd, "design", "decisions"), { recursive: true });
    const header = "# big\n\n**Status:** accepted\n\n";
    await writeFile(
      join(cwd, "design", "decisions", "big.md"),
      header + "x".repeat(42150 - header.length),
      "utf8",
    );
  }

  it("emits no P50 advisory without --include-quality", async () => {
    await writeBigDecisionPlan();
    const result = await runLint({ cwd });
    expect(result.issues.filter((i) => P50_CODES.has(i.code))).toEqual([]);
  });

  it("emits a P50 advisory under --include-quality, always affects_exit:false", async () => {
    await writeBigDecisionPlan();
    const result = await runLint({ cwd, includeQuality: true });
    const p50 = result.issues.filter((i) => P50_CODES.has(i.code));
    expect(p50.length).toBeGreaterThan(0);
    for (const issue of p50) expect(issue.affects_exit).toBe(false);
    expect(
      p50.some((i) => i.code === "TASK_DECLARED_DECISION_LARGE"),
    ).toBe(true);
  });
});
