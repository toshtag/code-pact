import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";

let tmpDir: string;

function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}

beforeAll(() => {
  ensureCliBuilt();
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-lint-int-"));
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
});

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

async function writeRoadmap(yaml: string): Promise<void> {
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), yaml, "utf8");
}

async function writePhase(filename: string, yaml: string): Promise<void> {
  await writeFile(join(tmpDir, "design", "phases", filename), yaml, "utf8");
}

const phaseYaml = (
  id: string,
  taskIds: string[],
  opts: { weakDod?: boolean } = {},
): string => {
  const dod = opts.weakDod ? "- tbd" : "- DoD long enough to read";
  return `id: ${id}
name: ${id}
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  ${dod}
verification:
  commands:
    - pnpm test
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
};

type LintJson = {
  ok: boolean;
  error?: { code: string; message: string };
  data?: {
    errors: number;
    warnings: number;
    include_quality: boolean;
    strict: boolean;
    skipped_checks: string[];
    advisories?: number;
    issues: Array<{
      code: string;
      severity: string;
      message: string;
      affects_exit?: boolean;
      file?: string;
      phase_id?: string;
      task_id?: string;
      details?: Record<string, unknown>;
      recovery?: Record<string, unknown>;
    }>;
  };
};

function parseLint(stdout: string): LintJson {
  return JSON.parse(stdout) as LintJson;
}

describe("plan lint --json", () => {
  it("returns ok=true and exit 0 on a clean project", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    const res = run(["plan", "lint", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseLint(res.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.errors).toBe(0);
    expect(parsed.data?.warnings).toBe(0);
    expect(parsed.data?.issues).toEqual([]);
  });

  it("returns ok=false, exit 1, PLAN_LINT_FAILED when an error is detected", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n  - id: P2\n    path: design/phases/P2.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["SHARED-T1"]));
    await writePhase("P2.yaml", phaseYaml("P2", ["SHARED-T1"]));

    const res = run(["plan", "lint", "--json"]);
    expect(res.code).toBe(1);
    const parsed = parseLint(res.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.code).toBe("PLAN_LINT_FAILED");
    expect(
      parsed.data?.issues.some((i) => i.code === "DUPLICATE_TASK_ID"),
    ).toBe(true);
  });

  it("warnings alone keep exit 0 but --strict promotes them to exit 1", async () => {
    // Orphan phase file is a warning.
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));
    await writePhase("P9-stray.yaml", phaseYaml("P9", ["P9-T1"]));

    const lenient = run(["plan", "lint", "--json"]);
    expect(lenient.code).toBe(0);
    const lenientParsed = parseLint(lenient.stdout);
    expect(lenientParsed.ok).toBe(true);
    expect(lenientParsed.data?.warnings).toBeGreaterThanOrEqual(1);

    const strict = run(["plan", "lint", "--strict", "--json"]);
    expect(strict.code).toBe(1);
    const strictParsed = parseLint(strict.stdout);
    expect(strictParsed.ok).toBe(false);
    expect(strictParsed.error?.code).toBe("PLAN_LINT_FAILED");
  });

  it("quality heuristics are off by default and surfaced with --include-quality", async () => {
    await writeRoadmap(
      `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
    );
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"], { weakDod: true }));

    const off = run(["plan", "lint", "--json"]);
    const offParsed = parseLint(off.stdout);
    expect(offParsed.data?.issues.some((i) => i.code === "WEAK_DOD")).toBe(
      false,
    );

    const on = run(["plan", "lint", "--include-quality", "--json"]);
    const onParsed = parseLint(on.stdout);
    expect(onParsed.data?.issues.some((i) => i.code === "WEAK_DOD")).toBe(
      true,
    );
    expect(onParsed.data?.include_quality).toBe(true);
  });

  it("surfaces skipped_checks when the roadmap itself is unparseable", async () => {
    await writeRoadmap("not: { valid yaml at all\n");
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));

    const res = run(["plan", "lint", "--json"]);
    expect(res.code).toBe(1);
    const parsed = parseLint(res.stdout);
    expect(parsed.data?.skipped_checks).toContain("MISSING_PHASE_FILE");
    expect(parsed.data?.skipped_checks).toContain("ORPHAN_PHASE_FILE");
    expect(
      parsed.data?.issues.some((i) => i.code === "INVALID_YAML"),
    ).toBe(true);
  });

  // A corrupt per-event file must report the SAME diagnostic code on `plan lint`
  // as on `doctor` — the two integrity surfaces must not disagree.
  async function writeCorruptEvent(body: string): Promise<void> {
    await writeRoadmap(`phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`);
    await writePhase("P1.yaml", phaseYaml("P1", ["P1-T1"]));
    const events = join(tmpDir, ".code-pact", "state", "events");
    await mkdir(events, { recursive: true });
    await writeFile(join(events, `20260518T100000000Z-${"a".repeat(64)}.yaml`), body, "utf8");
  }

  it("reports SCHEMA_ERROR (not INVALID_YAML) for a parseable-but-invalid event body", async () => {
    await writeCorruptEvent("status: not_a_status\n");
    const parsed = parseLint(run(["plan", "lint", "--json"]).stdout);
    expect(parsed.data?.issues.some((i) => i.code === "SCHEMA_ERROR")).toBe(true);
    expect(parsed.data?.issues.some((i) => i.code === "INVALID_YAML")).toBe(false);
  });

  it("reports INVALID_YAML for an unparseable event body", async () => {
    await writeCorruptEvent("{ unclosed flow mapping");
    const parsed = parseLint(run(["plan", "lint", "--json"]).stdout);
    expect(parsed.data?.issues.some((i) => i.code === "INVALID_YAML")).toBe(true);
  });
});

describe("plan lint — ADR_COMMITMENTS_EMPTY is advisory even under --strict (P43)", () => {
  const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;
  // A gated task; the filename scan matches an accepted ADR named P1-T1-*.md.
  const GATED_PHASE = `id: P1
name: P1
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  - DoD long enough to read
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
    requires_decision: true
    description: gated task
`;

  async function writeAdr(name: string, content: string): Promise<void> {
    await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
    await writeFile(join(tmpDir, "design", "decisions", name), content, "utf8");
  }

  it("fires the advisory but keeps exit 0 even with --strict", async () => {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", GATED_PHASE);
    // Accepted ADR resolving the gate, but with no commitments section.
    await writeAdr("P1-T1-rfc.md", "**Status:** accepted\n\n## Decision\n\nChose X.\n");

    const res = run(["plan", "lint", "--include-quality", "--strict", "--json"]);
    const parsed = parseLint(res.stdout);

    // Advisory is present...
    expect(
      parsed.data?.issues.some((i) => i.code === "ADR_COMMITMENTS_EMPTY"),
    ).toBe(true);
    // ...but it never promotes to a failure, even under --strict.
    expect(res.code).toBe(0);
    expect(parsed.ok).toBe(true);
  });
});

describe("plan lint — TASK_REGRESSION_EVIDENCE_MISSING is advisory even under --strict (P57)", () => {
  const ROADMAP =
    `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`;
  function bugfixPhase(
    taskLines: string[] = ["writes:", "  - src/session.ts"],
  ): string {
    return `id: P1
name: P1
weight: 10
confidence: medium
risk: low
status: planned
objective: An objective long enough
definition_of_done:
  - DoD long enough to read
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: bugfix
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: planned
    description: fixes a regression
${taskLines.map((line) => `    ${line}`).join("\n")}
`;
  }

  async function writeBugfixPlan(
    taskLines: string[] = ["writes:", "  - src/session.ts"],
  ): Promise<void> {
    await writeRoadmap(ROADMAP);
    await writePhase("P1.yaml", bugfixPhase(taskLines));
  }

  function regressionIssue(parsed: LintJson) {
    return parsed.data?.issues.find(
      (i) => i.code === "TASK_REGRESSION_EVIDENCE_MISSING",
    );
  }

  it("fires only with --include-quality and never promotes to failure", async () => {
    await writeBugfixPlan();

    const off = parseLint(run(["plan", "lint", "--strict", "--json"]).stdout);
    expect(regressionIssue(off)).toBeUndefined();

    const res = run(["plan", "lint", "--include-quality", "--strict", "--json"]);
    const parsed = parseLint(res.stdout);
    const issue = regressionIssue(parsed);

    expect(res.code).toBe(0);
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.advisories).toBe(1);
    expect(issue).toMatchObject({
      severity: "warning",
      affects_exit: false,
      file: "design/phases/P1.yaml",
      phase_id: "P1",
      task_id: "P1-T1",
      details: {
        accepted_sources: ["writes", "acceptance_refs"],
        accepted_forms: ["test", "fixture", "reproduction"],
        acceptance_refs_must_exist: true,
      },
      recovery: {
        manual_action:
          "Add a new test, fixture, or reproduction path to writes, or add an existing artifact path to acceptance_refs.",
        confirm: "code-pact plan lint --include-quality --json",
        reference:
          "docs/concepts/task-readiness-fields.md#regression-evidence-for-bugfix-tasks",
      },
    });
  });

  it("does not fire when writes names a regression artifact", async () => {
    await writeBugfixPlan(["writes:", "  - tests/session.test.ts"]);
    const parsed = parseLint(
      run(["plan", "lint", "--include-quality", "--strict", "--json"]).stdout,
    );
    expect(regressionIssue(parsed)).toBeUndefined();
  });

  it("does not fire when acceptance_refs names an existing regular file", async () => {
    await mkdir(join(tmpDir, "tests"), { recursive: true });
    await writeFile(join(tmpDir, "tests", "regression-case"), "", "utf8");
    await writeBugfixPlan([
      "writes:",
      "  - src/session.ts",
      "acceptance_refs:",
      "  - tests/regression-case",
    ]);

    const parsed = parseLint(
      run(["plan", "lint", "--include-quality", "--strict", "--json"]).stdout,
    );
    expect(regressionIssue(parsed)).toBeUndefined();
  });

  it("still fires when acceptance_refs names an existing directory", async () => {
    for (const ref of ["tests", "tests/unit"]) {
      await mkdir(join(tmpDir, ...ref.split("/")), { recursive: true });
      await writeBugfixPlan([
        "writes:",
        "  - src/session.ts",
        "acceptance_refs:",
        `  - ${ref}`,
      ]);

      const parsed = parseLint(
        run(["plan", "lint", "--include-quality", "--strict", "--json"]).stdout,
      );
      expect(regressionIssue(parsed), ref).toBeDefined();
    }
  });

  it("does not treat a passing verification command as evidence", async () => {
    await writeBugfixPlan([]);
    const parsed = parseLint(
      run(["plan", "lint", "--include-quality", "--strict", "--json"]).stdout,
    );
    expect(regressionIssue(parsed)).toBeDefined();
  });
});

describe("plan lint --include-quality — P50 context-fit advisories", () => {
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
  - A definition of done long enough to read
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
    await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
    const header = "# big\n\n**Status:** accepted\n\n";
    await writeFile(
      join(tmpDir, "design", "decisions", "big.md"),
      header + "x".repeat(42150 - header.length),
      "utf8",
    );
  }

  it("emits no P50 advisory without --include-quality", async () => {
    await writeBigDecisionPlan();
    const res = run(["plan", "lint", "--json"]);
    expect(res.code).toBe(0);
    const parsed = parseLint(res.stdout);
    expect(
      parsed.data?.issues.some((i) => i.code === "TASK_DECLARED_DECISION_LARGE"),
    ).toBe(false);
  });

  it("emits the advisory under --include-quality and keeps exit 0 even with --strict", async () => {
    await writeBigDecisionPlan();
    const res = run(["plan", "lint", "--include-quality", "--strict", "--json"]);
    const parsed = parseLint(res.stdout);

    const fired = parsed.data?.issues.find(
      (i) => i.code === "TASK_DECLARED_DECISION_LARGE",
    );
    expect(fired).toBeDefined();
    expect(fired?.affects_exit).toBe(false);
    expect(fired?.details).toMatchObject({
      path: "design/decisions/big.md",
      bytes: 42150,
      threshold_bytes: 30000,
    });
    // affects_exit:false → --strict never promotes it to a failure.
    expect(res.code).toBe(0);
    expect(parsed.ok).toBe(true);
  });
});
