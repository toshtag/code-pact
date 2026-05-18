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
