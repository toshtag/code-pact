#!/usr/bin/env -S node --import tsx
// Evidence harness orchestrator — internal maintainer tool (P20-T2).
//
// Invocation:
//   pnpm harness --corpus . [--write] [--json]
//
// NOT a product feature. Not registered in package.json bin. Walks the
// dogfood corpus (or any path with a design/ directory), computes the
// four metric sets locked in the P20-T1 RFC, and emits CSV files under
// docs/maintainers/measurements/ on --write (or prints them to stdout on default
// --check).

import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

import { loadPlanState } from "../../src/core/plan/state.ts";
import { runPlanLint } from "../../src/commands/plan-lint.ts";
import { buildContextPack } from "../../src/core/pack/index.ts";
import { readPackageVersion } from "../../src/lib/package-version.ts";
import { runAdapterDoctor } from "../../src/commands/adapter-doctor.ts";
import { Project } from "../../src/core/schemas/project.ts";

import {
  buildAdapterDriftRow,
  buildEventDensityRow,
  buildLifecycleAdherenceRow,
  buildLintHistogram,
  buildPackSizeRow,
  buildSummary,
  buildVerifySuccessRow,
  rowsToCsv,
  type AdapterDriftRow,
  type EventDensityRow,
  type LifecycleAdherenceRow,
  type LintIssueRow,
  type PackSizeRow,
  type Summary,
  type VerifySuccessRow,
} from "./metrics.ts";

const HARNESS_VERSION = "0.2.0";
const SUMMARY_SCHEMA_VERSION = 2;

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
  lifecycleAdherenceRows: LifecycleAdherenceRow[];
  adapterDriftRows: AdapterDriftRow[];
  summary: Summary;
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
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return "unknown";
  }
  const sha = result.stdout.trim();
  // Mark a dirty working tree: the snapshot was generated against uncommitted
  // changes (e.g. a release version bump made alongside the refresh), so this
  // exact commit does NOT reproduce the snapshot. Honest evidence > a clean-looking
  // SHA that points at the wrong tree.
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
  });
  const dirty =
    status.status === 0 &&
    typeof status.stdout === "string" &&
    status.stdout.trim().length > 0;
  return dirty ? `${sha}-dirty` : sha;
}

// P28: the declared enabled-agent set, read from .code-pact/project.yaml.
// This is the denominator for adapter_drift_rate_percent — it must be the
// declared source of truth, not inferred from observed doctor issues or
// progress events. Mirrors adapter-doctor's loadProjectSafe + enabled
// filter. Returns [] when project.yaml is absent or unparseable.
async function loadEnabledAgents(cwd: string): Promise<string[]> {
  try {
    const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
    const project = Project.parse(parseYaml(raw) as unknown);
    return project.agents
      .filter((a) => a.enabled !== false)
      .map((a) => a.name);
  } catch {
    return [];
  }
}

async function buildHarnessOutput(opts: HarnessOptions): Promise<HarnessOutput> {
  const cwd = resolve(opts.corpus);
  const state = await loadPlanState(cwd);
  const events = state.progress?.events ?? [];

  const packSizeRows: PackSizeRow[] = [];
  const verifySuccessRows: VerifySuccessRow[] = [];
  const eventDensityRows: EventDensityRow[] = [];
  const lifecycleAdherenceRows: LifecycleAdherenceRow[] = [];
  let tasksTotal = 0;

  const phaseEntries = [...state.phases].sort((a, b) =>
    a.phase.id.localeCompare(b.phase.id),
  );

  for (const entry of phaseEntries) {
    const phase = entry.phase;
    const tasks = [...(phase.tasks ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const task of tasks) {
      tasksTotal++;
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

      const adherenceRow = buildLifecycleAdherenceRow(phase.id, task.id, events);
      if (adherenceRow !== null) {
        lifecycleAdherenceRows.push(adherenceRow);
      }
    }
  }

  const lintResult = await runPlanLint({
    cwd,
    strict: false,
    includeQuality: true,
  });
  const lintIssueRows = buildLintHistogram(lintResult.issues);

  // P26-T1: adapter drift aggregation. Invoke runAdapterDoctor against
  // every enabled agent (omit --agent → doctor walks the project.yaml
  // agents:list itself) and bucket the resulting issues by agent.
  let adapterDriftRows: AdapterDriftRow[] = [];
  try {
    const doctorResult = await runAdapterDoctor({ cwd, locale: "en-US" });
    const issuesByAgent = new Map<string, typeof doctorResult.issues>();
    for (const issue of doctorResult.issues) {
      const bucket = issuesByAgent.get(issue.agent) ?? [];
      bucket.push(issue);
      issuesByAgent.set(issue.agent, bucket);
    }
    // P28: the enabled-agent set is the denominator of
    // adapter_drift_rate_percent, so it MUST come from the declared
    // source of truth (.code-pact/project.yaml agents[] with enabled
    // != false) — not from observed signals. Deriving it from doctor
    // issues + progress events silently drops any enabled agent that
    // happens to have zero issues and zero events, corrupting the rate.
    // Every enabled agent gets exactly one row, including a clean one.
    const enabledAgents = await loadEnabledAgents(cwd);
    const sortedAgents = [...enabledAgents].sort((a, b) => a.localeCompare(b));
    adapterDriftRows = sortedAgents.map((agent) =>
      buildAdapterDriftRow(agent, issuesByAgent.get(agent) ?? []),
    );
  } catch {
    // No project.yaml or no enabled agents → empty drift CSV.
    adapterDriftRows = [];
  }

  const inputGitSha = readGitSha(cwd);
  const cliPackageJsonPath = join(import.meta.dirname, "..", "..", "package.json");
  const codePactCliVersion = await readPackageVersion(cliPackageJsonPath);

  const today = new Date();
  const generatedAt = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;

  const summary = buildSummary({
    harnessVersion: HARNESS_VERSION,
    summarySchemaVersion: SUMMARY_SCHEMA_VERSION,
    inputGitSha,
    codePactCliVersion,
    generatedAt,
    packSizeRows,
    verifySuccessRows,
    lifecycleAdherenceRows,
    adapterDriftRows,
    tasksTotal,
  });

  return {
    packSizeRows,
    verifySuccessRows,
    eventDensityRows,
    lintIssueRows,
    lifecycleAdherenceRows,
    adapterDriftRows,
    summary,
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
        "lifecycle-adherence-by-task.csv",
        "adapter-drift-by-agent.csv",
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
    "lifecycle-adherence-by-task.csv": rowsToCsv(
      output.lifecycleAdherenceRows,
      [
        "phase_id",
        "task_id",
        "started_before_done",
        "had_retry",
        "had_block",
        "legacy_planned_to_done_shortcut",
        "event_count",
      ],
    ),
    "adapter-drift-by-agent.csv": rowsToCsv(output.adapterDriftRows, [
      "agent",
      "doctor_ok",
      "issue_count",
      "manifest_missing",
      "manifest_invalid",
      "generator_stale",
      "schema_drift",
      "profile_drift",
      "file_missing",
      "file_drift",
      "desired_stale",
      "contract_drift",
      "unmanaged_file",
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

  const summaryJsonText = JSON.stringify(output.summary, null, 2) + "\n";

  if (write) {
    const outDir = join(resolve(corpus), "docs", "maintainers", "measurements");
    await mkdir(outDir, { recursive: true });
    for (const [name, content] of Object.entries(serialized)) {
      await writeFile(join(outDir, name), content, "utf8");
    }
    await writeFile(
      join(outDir, "measurements.manifest.json"),
      JSON.stringify(output.manifest, null, 2) + "\n",
      "utf8",
    );
    await writeFile(join(outDir, "summary.json"), summaryJsonText, "utf8");
    if (!json) {
      process.stderr.write(
        `Wrote ${Object.keys(serialized).length} CSV(s) + manifest + summary.json to ${outDir}\n`,
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          data: {
            output_dir: outDir,
            files: [
              ...Object.keys(serialized),
              "measurements.manifest.json",
              "summary.json",
            ],
            manifest: output.manifest,
            summary: output.summary,
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
          summary: output.summary,
          csv: serialized,
        },
      }) + "\n",
    );
    return 0;
  }

  for (const [name, content] of Object.entries(serialized)) {
    process.stdout.write(`# ${name}\n${content}\n`);
  }
  process.stdout.write(`# summary.json\n${summaryJsonText}\n`);
  process.stderr.write(
    `Generated ${Object.keys(serialized).length} CSV(s) + summary.json. Re-run with --write to persist.\n`,
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
