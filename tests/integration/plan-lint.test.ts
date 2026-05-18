import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const cliPath = join(repoRoot, "dist", "cli.js");

let tmpDir: string;

type RunResult = { code: number; stdout: string; stderr: string };

function run(args: string[]): RunResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: tmpDir,
    encoding: "utf8",
    env: process.env,
  });
  return {
    code: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

beforeAll(() => {
  // Build once. Stale dist would mask real CLI regressions.
  const res = spawnSync("pnpm", ["build"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (res.status !== 0 || !existsSync(cliPath)) {
    throw new Error(
      `Failed to build CLI for tests. exit=${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
}, 60_000);

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-plan-lint-int-"));
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
});

afterAll(async () => {
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
    issues: Array<{ code: string; severity: string; message: string }>;
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
});
