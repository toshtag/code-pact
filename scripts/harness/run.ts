#!/usr/bin/env -S node --import tsx
// Evidence harness orchestrator — internal maintainer tool (P20-T2).
//
// Invocation:
//   pnpm harness --corpus . [--write] [--json]
//
// NOT a product feature. Not registered in package.json bin. Walks the
// dogfood corpus (or any path with a design/ directory), computes the
// four metric sets locked in the P20-T1 RFC, and emits CSV files under
// design/measurements/ on --write (or prints them to stdout on default
// --check).

import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { loadPlanState } from "../../src/core/plan/state.ts";
import { runPlanLint } from "../../src/commands/plan-lint.ts";
import { buildContextPack } from "../../src/core/pack/index.ts";
import { readPackageVersion } from "../../src/lib/package-version.ts";

import {
  buildEventDensityRow,
  buildLintHistogram,
  buildPackSizeRow,
  buildVerifySuccessRow,
  rowsToCsv,
  type EventDensityRow,
  type LintIssueRow,
  type PackSizeRow,
  type VerifySuccessRow,
} from "./metrics.ts";

const HARNESS_VERSION = "0.1.0";

interface HarnessOptions {
  corpus: string;
  write: boolean;
  json: boolean;
}

interface HarnessOutput {
  packSizeRows: PackSizeRow[];
  verifySuccessRows: VerifySuccessRow[];
  eventDensityRows: EventDensityRow[];
  lintIssueRows: LintIssueRow[];
  manifest: {
    harness_version: string;
    input_git_sha: string;
    code_pact_cli_version: string;
    generated_at: string;
    csv_files: string[];
  };
}

function readGitSha(cwd: string): string {
  // spawnSync with explicit argv (no shell) — safe against argument
  // injection regardless of cwd value.
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    return result.stdout.trim();
  }
  return "unknown";
}

async function buildHarnessOutput(opts: HarnessOptions): Promise<HarnessOutput> {
  const cwd = resolve(opts.corpus);
  const state = await loadPlanState(cwd);
  const events = state.progress?.events ?? [];

  const packSizeRows: PackSizeRow[] = [];
  const verifySuccessRows: VerifySuccessRow[] = [];
  const eventDensityRows: EventDensityRow[] = [];

  const phaseEntries = [...state.phases].sort((a, b) =>
    a.phase.id.localeCompare(b.phase.id),
  );

  for (const entry of phaseEntries) {
    const phase = entry.phase;
    const tasks = [...(phase.tasks ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const task of tasks) {
      try {
        const pack = await buildContextPack({
          cwd,
          phaseId: phase.id,
          taskId: task.id,
          agentName: "generic",
        });
        packSizeRows.push(buildPackSizeRow(phase, task, pack.content));
      } catch {
        // Skip tasks where the pack builder fails (e.g. unresolvable refs).
      }

      const verifyRow = buildVerifySuccessRow(phase.id, task.id, events);
      if (verifyRow) verifySuccessRows.push(verifyRow);

      const densityRow = buildEventDensityRow(phase.id, task.id, events);
      if (densityRow.total_events > 0) {
        eventDensityRows.push(densityRow);
      }
    }
  }

  const lintResult = await runPlanLint({
    cwd,
    strict: false,
    includeQuality: true,
  });
  const lintIssueRows = buildLintHistogram(lintResult.issues);

  const inputGitSha = readGitSha(cwd);
  const cliPackageJsonPath = join(import.meta.dirname, "..", "..", "package.json");
  const codePactCliVersion = await readPackageVersion(cliPackageJsonPath);

  const today = new Date();
  const generatedAt = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

  return {
    packSizeRows,
    verifySuccessRows,
    eventDensityRows,
    lintIssueRows,
    manifest: {
      harness_version: HARNESS_VERSION,
      input_git_sha: inputGitSha,
      code_pact_cli_version: codePactCliVersion,
      generated_at: generatedAt,
      csv_files: [
        "pack-size-by-task.csv",
        "verify-success-rate.csv",
        "task-event-density.csv",
        "lint-issue-histogram.csv",
      ],
    },
  };
}

function serializeOutputs(output: HarnessOutput): Record<string, string> {
  return {
    "pack-size-by-task.csv": rowsToCsv(output.packSizeRows, [
      "phase_id",
      "task_id",
      "pack_bytes",
      "pack_lines",
      "pack_sections",
      "reads_glob_count",
      "writes_glob_count",
      "decision_refs_count",
      "acceptance_refs_count",
    ]),
    "verify-success-rate.csv": rowsToCsv(output.verifySuccessRows, [
      "phase_id",
      "task_id",
      "first_pass",
      "retries",
      "verify_runs_total",
    ]),
    "task-event-density.csv": rowsToCsv(output.eventDensityRows, [
      "phase_id",
      "task_id",
      "started",
      "blocked",
      "resumed",
      "done",
      "failed",
      "total_events",
      "event_span_days",
    ]),
    "lint-issue-histogram.csv": rowsToCsv(output.lintIssueRows, [
      "phase_id",
      "code",
      "severity",
      "count",
    ]),
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      corpus: { type: "string" },
      write: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: false,
  });

  const corpus = typeof values.corpus === "string" ? values.corpus : ".";
  const write = values.write === true;
  const json = values.json === true;

  const output = await buildHarnessOutput({ corpus, write, json });
  const serialized = serializeOutputs(output);

  if (write) {
    const outDir = join(resolve(corpus), "design", "measurements");
    await mkdir(outDir, { recursive: true });
    for (const [name, content] of Object.entries(serialized)) {
      await writeFile(join(outDir, name), content, "utf8");
    }
    await writeFile(
      join(outDir, "measurements.manifest.json"),
      JSON.stringify(output.manifest, null, 2) + "\n",
      "utf8",
    );
    if (!json) {
      process.stderr.write(
        `Wrote ${Object.keys(serialized).length} CSV(s) + manifest to ${outDir}\n`,
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          data: {
            output_dir: outDir,
            files: [...Object.keys(serialized), "measurements.manifest.json"],
            manifest: output.manifest,
          },
        }) + "\n",
      );
    }
    return 0;
  }

  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        data: {
          manifest: output.manifest,
          csv: serialized,
        },
      }) + "\n",
    );
    return 0;
  }

  for (const [name, content] of Object.entries(serialized)) {
    process.stdout.write(`# ${name}\n${content}\n`);
  }
  process.stderr.write(
    `Generated ${Object.keys(serialized).length} CSV(s). Re-run with --write to persist.\n`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`harness error: ${msg}\n`);
    process.exit(2);
  },
);
