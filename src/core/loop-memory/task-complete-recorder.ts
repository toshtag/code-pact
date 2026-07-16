import type { CheckResult, VerifyResult } from "../../commands/verify.ts";
import { fingerprintFailure } from "../evidence/failure-fingerprint.ts";
import { recommendLifecycleMode } from "../recommend/lifecycle.ts";
import { recommendRepairPolicy } from "../recommend/repair-policy.ts";
import type { Phase } from "../schemas/phase.ts";
import type { Task } from "../schemas/task.ts";
import {
  MAX_FAILED_CHECK_BYTES,
  MAX_FAILED_COMMAND_BYTES,
  type LoopMemoryEpisode,
  type LoopMemoryFailureKind,
} from "./episode-schema.ts";
import { storeLoopMemoryEpisode } from "./episode-store.ts";
import { planLoopMemoryRetention, applyLoopMemoryRetention } from "./retention.ts";
import { scanLoopMemoryEpisodes } from "./episode-store.ts";
import { containsAbsolutePathLike } from "./path-safety.ts";

export type LoopMemoryWarning = {
  code: "LOCAL_MEMORY_WRITE_SKIPPED" | "LOCAL_MEMORY_PRUNE_SKIPPED";
  message:
    | "The local loop-memory episode was not recorded."
    | "The local loop-memory episode was recorded, but retention maintenance was skipped.";
  affects_exit: false;
};

export const LOCAL_MEMORY_WRITE_SKIPPED_WARNING: LoopMemoryWarning = {
  code: "LOCAL_MEMORY_WRITE_SKIPPED",
  message: "The local loop-memory episode was not recorded.",
  affects_exit: false,
};

export const LOCAL_MEMORY_PRUNE_SKIPPED_WARNING: LoopMemoryWarning = {
  code: "LOCAL_MEMORY_PRUNE_SKIPPED",
  message: "The local loop-memory episode was recorded, but retention maintenance was skipped.",
  affects_exit: false,
};

let recordFailureForTests: (() => Error) | null = null;
let pruneFailureForTests: (() => Error) | null = null;

export function __setLoopMemoryRecordFailureForTests(
  hook: (() => Error) | null,
): void {
  recordFailureForTests = hook;
}

export function __setLoopMemoryPruneFailureForTests(
  hook: (() => Error) | null,
): void {
  pruneFailureForTests = hook;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeBounded(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (utf8Bytes(value) > maxBytes) return undefined;
  if (containsAbsolutePathLike(value)) return undefined;
  return value;
}

function failedCommandFrom(check: CheckResult) {
  if (check.name !== "commands") return null;
  const failed = check.commands?.find(command => !command.ok);
  if (failed) return failed;
  if (check.command) {
    return {
      command: check.command,
      ok: false,
      exitCode: check.exitCode ?? null,
      timedOut: check.timedOut === true,
      aborted: check.aborted === true,
      elapsedMs: check.elapsedMs ?? 0,
      stdout: check.stdout ?? "",
      stderr: check.stderr ?? "",
      stdoutTruncated: check.stdoutTruncated,
      stderrTruncated: check.stderrTruncated,
    };
  }
  return null;
}

function failureKindFor(
  check: CheckResult | undefined,
  command: ReturnType<typeof failedCommandFrom>,
): LoopMemoryFailureKind {
  if (command?.aborted || check?.aborted) return "aborted";
  if (command?.timedOut || check?.timedOut) return "timed_out";
  if (check?.name === "decision") return "decision_required";
  if (check?.name === "commands") return "command_failed";
  if (check?.name === "progress_event" || check?.name === "task_status") {
    return "invalid_state";
  }
  return "unknown";
}

function executionFor(task: Task, phase: Phase): LoopMemoryEpisode["execution"] {
  const lifecycleMode = recommendLifecycleMode(task, {
    phaseRequiresDecision: phase.requires_decision === true,
  });
  const repairPolicy = recommendRepairPolicy(task, lifecycleMode);
  return {
    lifecycle_mode: lifecycleMode,
    repair_mode: repairPolicy.mode === "bounded" ? "bounded" : "disabled",
  };
}

export function buildLoopMemoryEpisodeForTaskComplete(opts: {
  cwd: string;
  phase: Phase;
  task: Task;
  verify: VerifyResult;
  recordedAt: Date;
}): LoopMemoryEpisode {
  const { cwd, phase, task, verify, recordedAt } = opts;
  const base = {
    schema_version: 1 as const,
    recorded_at: recordedAt.toISOString(),
    task: {
      phase_id: phase.id,
      task_id: task.id,
      task_type: task.type,
    },
    execution: executionFor(task, phase),
  };

  if (verify.ok) {
    return {
      ...base,
      kind: "verification_passed",
      verification: { ok: true },
    };
  }

  const firstFailure = verify.checks.find(check => !check.ok);
  const command = firstFailure ? failedCommandFrom(firstFailure) : null;
  return {
    ...base,
    kind: "verification_failed",
    verification: {
      ok: false,
      failure_kind: failureKindFor(firstFailure, command),
      ...(command
        ? { failure_fingerprint: fingerprintFailure(command, cwd) }
        : {}),
      ...(firstFailure
        ? { failed_check: safeBounded(firstFailure.name, MAX_FAILED_CHECK_BYTES) }
        : {}),
      ...(command
        ? { failed_command: safeBounded(command.command, MAX_FAILED_COMMAND_BYTES) }
        : {}),
    },
  };
}

export async function recordLoopMemoryEpisodeBestEffort(opts: {
  cwd: string;
  phase: Phase;
  task: Task;
  verify: VerifyResult;
  recordedAt: Date;
  episode?: LoopMemoryEpisode;
}): Promise<LoopMemoryWarning | undefined> {
  let stored: Awaited<ReturnType<typeof storeLoopMemoryEpisode>>;
  try {
    if (recordFailureForTests) throw recordFailureForTests();
    stored = await storeLoopMemoryEpisode(
      opts.cwd,
      opts.episode ?? buildLoopMemoryEpisodeForTaskComplete(opts),
    );
  } catch {
    return LOCAL_MEMORY_WRITE_SKIPPED_WARNING;
  }

  try {
    if (pruneFailureForTests) throw pruneFailureForTests();
    const scan = await scanLoopMemoryEpisodes(opts.cwd);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: opts.recordedAt,
      protectedFilename: stored.filename,
    });
    await applyLoopMemoryRetention(opts.cwd, plan);
    return undefined;
  } catch {
    return LOCAL_MEMORY_PRUNE_SKIPPED_WARNING;
  }
}
