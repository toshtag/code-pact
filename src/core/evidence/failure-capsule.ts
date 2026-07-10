import type { CheckResult, CommandExecutionResult, VerifyResult } from "../../commands/verify.ts";
import {
  storeEvidenceArtifact,
  type StoredEvidence,
} from "./evidence-store.ts";
import {
  excerptText,
  STDERR_EXCERPT_LIMITS,
  STDOUT_EXCERPT_LIMITS,
  type OutputExcerpt,
} from "./excerpt.ts";
import { fingerprintFailure } from "./failure-fingerprint.ts";

export type FailureKind =
  | "command_failed"
  | "timed_out"
  | "aborted"
  | "decision_required"
  | "unsafe_write"
  | "invalid_state"
  | "unknown";

export type FailureCapsule = {
  schema_version: 1;
  kind: FailureKind;
  check: string;
  command?: string;
  exit_code?: number | null;
  timed_out?: boolean;
  aborted?: boolean;
  elapsed_ms?: number;
  reason?: string;
  fingerprint?: string;
  stdout_excerpt?: OutputExcerpt;
  stderr_excerpt?: OutputExcerpt;
  evidence_ref?: string;
  retrieve_command?: string;
};

export type AgentCommandSummary = {
  command: string;
  exit_code: number | null;
  elapsed_ms: number;
};

export type AgentCheckSummary = {
  name: string;
  ok: boolean;
  reason?: string;
};

export type AgentVerifyProjection = {
  ok: boolean;
  checks: AgentCheckSummary[];
  successful_commands: AgentCommandSummary[];
};

export type AgentFailureProjection = {
  failure: FailureCapsule;
  verify: AgentVerifyProjection;
};

function isCaptureTruncated(text: string): boolean {
  return text.includes("[code-pact: output truncated after ");
}

function failedCommandFrom(check: CheckResult): CommandExecutionResult | null {
  if (check.name !== "commands") return null;
  if (check.commands) {
    const failed = check.commands.find(command => !command.ok);
    if (failed) return failed;
  }
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
    };
  }
  return null;
}

function kindForCheck(check: CheckResult, command: CommandExecutionResult | null): FailureKind {
  if (command?.aborted || check.aborted) return "aborted";
  if (command?.timedOut || check.timedOut) return "timed_out";
  if (check.name === "decision") return "decision_required";
  if (check.name === "commands") return "command_failed";
  if (check.name === "progress_event" || check.name === "task_status") {
    return "invalid_state";
  }
  return "unknown";
}

export function summarizeAgentChecks(result: VerifyResult): AgentCheckSummary[] {
  return result.checks.map(check => ({
    name: check.name,
    ok: check.ok,
    ...(check.ok ? {} : { reason: check.reason ?? "check failed" }),
  }));
}

export function summarizeSuccessfulAgentCommands(result: VerifyResult): AgentCommandSummary[] {
  const commands = result.checks.flatMap(check => check.commands ?? []);
  return commands
    .filter(command => command.ok)
    .map(command => ({
      command: command.command,
      exit_code: command.exitCode,
      elapsed_ms: command.elapsedMs,
    }));
}

export function projectVerifySummaryForAgent(result: VerifyResult): AgentVerifyProjection {
  return {
    ok: result.ok,
    checks: summarizeAgentChecks(result),
    successful_commands: summarizeSuccessfulAgentCommands(result),
  };
}

export async function projectVerifyForAgent(
  cwd: string,
  result: VerifyResult,
): Promise<AgentFailureProjection> {
  const firstFailure = result.checks.find(check => !check.ok);
  if (!firstFailure) {
    return {
      failure: {
        schema_version: 1,
        kind: "unknown",
        check: "none",
        reason: "verification passed",
      },
      verify: {
        ok: result.ok,
        checks: summarizeAgentChecks(result),
        successful_commands: summarizeSuccessfulAgentCommands(result),
      },
    };
  }

  const failedCommand = failedCommandFrom(firstFailure);
  const capsule: FailureCapsule = {
    schema_version: 1,
    kind: kindForCheck(firstFailure, failedCommand),
    check: firstFailure.name,
    ...(firstFailure.reason ? { reason: firstFailure.reason } : {}),
  };

  let stored: StoredEvidence | null = null;
  if (failedCommand !== null) {
    stored = await storeEvidenceArtifact(cwd, {
      schema_version: 1,
      command: failedCommand.command,
      exit_code: failedCommand.exitCode,
      timed_out: failedCommand.timedOut,
      aborted: failedCommand.aborted,
      elapsed_ms: failedCommand.elapsedMs,
      stdout: failedCommand.stdout,
      stderr: failedCommand.stderr,
      stdout_capture_truncated: isCaptureTruncated(failedCommand.stdout),
      stderr_capture_truncated: isCaptureTruncated(failedCommand.stderr),
    });

    capsule.command = failedCommand.command;
    capsule.exit_code = failedCommand.exitCode;
    capsule.timed_out = failedCommand.timedOut;
    capsule.aborted = failedCommand.aborted;
    capsule.elapsed_ms = failedCommand.elapsedMs;
    capsule.fingerprint = fingerprintFailure(failedCommand, cwd);
    capsule.stdout_excerpt = excerptText(failedCommand.stdout, STDOUT_EXCERPT_LIMITS);
    capsule.stderr_excerpt = excerptText(failedCommand.stderr, STDERR_EXCERPT_LIMITS);
    capsule.evidence_ref = stored.ref;
    capsule.retrieve_command = `code-pact evidence show ${stored.ref} --json`;
  }

  return {
    failure: capsule,
    verify: {
      ok: result.ok,
      checks: summarizeAgentChecks(result),
      successful_commands: summarizeSuccessfulAgentCommands(result),
    },
  };
}
