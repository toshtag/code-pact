// Evidence harness integration tests — v1.10 P20-T2.
//
// Verifies:
//   * Byte-determinism: two consecutive runs against the same corpus
//     produce identical CSV outputs (excluding the manifest's
//     `code_pact_cli_version` which is read at runtime — that field
//     stays stable across runs in a single CI session anyway).
//   * --check (default) prints CSVs to stdout AND does NOT touch
//     docs/maintainers/measurements/.
//   * --write persists the four CSVs + manifest under docs/maintainers/measurements/.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { createTempProject } from "../helpers/cli.ts";

type Project = Awaited<ReturnType<typeof createTempProject>>;

let cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  // No CLI build needed — the harness runs through tsx against ts source.
});

afterEach(async () => {
  await Promise.all(cleanups.map((c) => c()));
  cleanups = [];
});

async function setupCorpus(prefix: string): Promise<Project> {
  const p = await createTempProject({ prefix: `code-pact-harness-${prefix}-` });
  cleanups.push(p.cleanup);

  const designDir = join(p.dir, "design");
  const phasesDir = join(designDir, "phases");
  await mkdir(phasesDir, { recursive: true });

  const roadmap = {
    phases: [
      { id: "P1", path: "design/phases/P1.yaml", weight: 10 },
    ],
  };
  await writeFile(join(designDir, "roadmap.yaml"), stringifyYaml(roadmap), "utf8");

  const phase = {
    id: "P1",
    name: "P1",
    weight: 10,
    confidence: "medium",
    risk: "medium",
    status: "in_progress",
    objective: "test",
    definition_of_done: ["x"],
    verification: { commands: ["pnpm test"] },
    tasks: [
      {
        id: "P1-T1",
        type: "feature",
        ambiguity: "medium",
        risk: "medium",
        context_size: "medium",
        write_surface: "medium",
        verification_strength: "medium",
        expected_duration: "medium",
        status: "planned",
        description: "first task",
      },
    ],
  };
  await writeFile(join(phasesDir, "P1.yaml"), stringifyYaml(phase), "utf8");

  await writeFile(
    join(p.dir, ".code-pact", "project.yaml"),
    stringifyYaml({
      project_name: "test",
      default_locale: "en-US",
      enabled_agents: ["generic"],
      default_agent: "generic",
    }),
    "utf8",
  );

  return p;
}

function runHarness(corpusDir: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const harnessScript = resolve(
    process.cwd(),
    "scripts",
    "harness",
    "run.ts",
  );
  const result = spawnSync(
    "node",
    ["--import", "tsx", harnessScript, "--corpus", corpusDir, ...args],
    { encoding: "utf8" },
  );
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("harness --write (persistence)", () => {
  it("writes six CSVs + manifest + summary.json under docs/maintainers/measurements/", async () => {
    const p = await setupCorpus("write");
    const result = runHarness(p.dir, ["--write", "--json"]);
    expect(result.code).toBe(0);

    const outDir = join(p.dir, "docs", "maintainers", "measurements");
    for (const f of [
      "pack-size-by-task.csv",
      "verify-success-rate.csv",
      "task-event-density.csv",
      "lint-issue-histogram.csv",
      "lifecycle-adherence-by-task.csv",
      "adapter-drift-by-agent.csv",
      "measurements.manifest.json",
      "summary.json",
    ]) {
      const stats = await stat(join(outDir, f));
      expect(stats.isFile()).toBe(true);
    }

    const manifest = JSON.parse(
      await readFile(join(outDir, "measurements.manifest.json"), "utf8"),
    );
    expect(manifest.harness_version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.csv_files).toEqual([
      "pack-size-by-task.csv",
      "verify-success-rate.csv",
      "task-event-density.csv",
      "lint-issue-histogram.csv",
      "lifecycle-adherence-by-task.csv",
      "adapter-drift-by-agent.csv",
    ]);
    // generated_at is a date only (YYYY-MM-DD), no clock time
    expect(manifest.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("writes summary.json with every metric field defined in the v2 RFC", async () => {
    const p = await setupCorpus("write-summary");
    const result = runHarness(p.dir, ["--write", "--json"]);
    expect(result.code).toBe(0);

    const summary = JSON.parse(
      await readFile(
        join(p.dir, "docs", "maintainers", "measurements", "summary.json"),
        "utf8",
      ),
    );
    expect(summary.summary_schema_version).toBe(2);
    expect(summary.harness_version).toBe("0.2.0");
    expect(["measured", "no_live_tasks"]).toContain(summary.corpus_status);
    expect(typeof summary.corpus_note).toBe("string");
    expect(summary.metrics).toMatchObject({
      pack_size_p50_bytes: expect.any(Number),
      pack_size_p90_bytes: expect.any(Number),
      pack_size_max_bytes: expect.any(Number),
      first_pass_verify_rate_percent: expect.any(Number),
      lifecycle_adherence_rate_percent: expect.any(Number),
      adapter_drift_rate_percent: expect.any(Number),
      undeclared_write_rate_status: "deferred",
      undeclared_write_rate_note: expect.any(String),
    });
    expect(summary.metrics.undeclared_write_rate_note.length).toBeGreaterThan(
      0,
    );
    expect(summary.denominators).toMatchObject({
      tasks_done: expect.any(Number),
      tasks_total: expect.any(Number),
      agents_enabled: expect.any(Number),
    });
  });
});

describe("harness (default --check)", () => {
  it("prints CSVs to stdout WITHOUT writing any file", async () => {
    const p = await setupCorpus("check");
    const result = runHarness(p.dir, []);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("# pack-size-by-task.csv");
    expect(result.stdout).toContain("# verify-success-rate.csv");
    expect(result.stdout).toContain("# task-event-density.csv");
    expect(result.stdout).toContain("# lint-issue-histogram.csv");
    expect(result.stdout).toContain("# lifecycle-adherence-by-task.csv");
    expect(result.stdout).toContain("# adapter-drift-by-agent.csv");
    expect(result.stdout).toContain("# summary.json");

    let measurementsExists = false;
    try {
      await stat(join(p.dir, "docs", "maintainers", "measurements"));
      measurementsExists = true;
    } catch {
      measurementsExists = false;
    }
    expect(measurementsExists).toBe(false);
  });
});

describe("harness byte-determinism", () => {
  it("two consecutive --write runs produce identical CSVs + summary.json", async () => {
    const p = await setupCorpus("determinism");

    const first = runHarness(p.dir, ["--write"]);
    expect(first.code).toBe(0);
    const outDir = join(p.dir, "docs", "maintainers", "measurements");

    const firstSnapshot = new Map<string, string>();
    for (const f of [
      "pack-size-by-task.csv",
      "verify-success-rate.csv",
      "task-event-density.csv",
      "lint-issue-histogram.csv",
      "lifecycle-adherence-by-task.csv",
      "adapter-drift-by-agent.csv",
      "summary.json",
    ]) {
      firstSnapshot.set(f, await readFile(join(outDir, f), "utf8"));
    }

    const second = runHarness(p.dir, ["--write"]);
    expect(second.code).toBe(0);

    for (const [f, content] of firstSnapshot) {
      const after = await readFile(join(outDir, f), "utf8");
      expect(after).toBe(content);
    }
  });
});
