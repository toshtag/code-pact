import type { CheckResult, CommandExecutionResult, VerifyResult } from "../../commands/verify.ts";
import { storeEvidenceArtifact } from "./evidence-store.ts";
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
  evidence_available?: boolean;
  evidence_error?: {
    code: string;
    cause_code?: string;
    system_code?: string;
    message?: string;
  };
  evidence_ref?: string;
  retrieve_command?: string;
  projection_truncated?: boolean;
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
  projection_truncated?: boolean;
};

export type AgentFailureProjection = {
  failure: FailureCapsule;
  verify: AgentVerifyProjection;
};

const MAX_AGENT_PROJECTION_BYTES = 20 * 1024;
export const MAX_AGENT_JSON_BYTES = 24 * 1024;
const MAX_AGENT_CHECKS = 8;
const MAX_AGENT_SUCCESSFUL_COMMANDS = 8;
const MAX_AGENT_COMMAND_BYTES = 512;
const MAX_AGENT_REASON_BYTES = 512;
const MAX_AGENT_EVIDENCE_ERROR_MESSAGE_BYTES = 256;
const MAX_AGENT_SYSTEM_CODE_BYTES = 64;
const MINIMAL_COMMAND_BYTES = 64;
const MINIMAL_STDERR_TAIL_BYTES = 512;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: excerptText(text, { headBytes: Math.max(0, maxBytes), tailBytes: 0 }).head,
    truncated: true,
  };
}

function truncateUtf8Suffix(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8");
  let start = Math.max(0, buffer.length - maxBytes);
  while (start < buffer.length && (buffer[start]! & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return { text: buffer.subarray(start).toString("utf8"), truncated: true };
}

function capText(text: string | undefined, maxBytes: number): { value: string | undefined; truncated: boolean } {
  if (text === undefined) return { value: undefined, truncated: false };
  const capped = truncateUtf8(text, maxBytes);
  return { value: capped.text, truncated: capped.truncated };
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
      stdoutTruncated: check.stdoutTruncated,
      stderrTruncated: check.stderrTruncated,
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
  return result.checks.slice(0, MAX_AGENT_CHECKS).map(check => {
    const reason = capText(check.reason ?? (check.ok ? undefined : "check failed"), MAX_AGENT_REASON_BYTES);
    return {
      name: check.name,
      ok: check.ok,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
    };
  });
}

export function summarizeSuccessfulAgentCommands(result: VerifyResult): AgentCommandSummary[] {
  const commands = result.checks.flatMap(check => check.commands ?? []);
  return commands
    .filter(command => command.ok)
    .slice(0, MAX_AGENT_SUCCESSFUL_COMMANDS)
    .map(command => ({
      command: truncateUtf8(command.command, MAX_AGENT_COMMAND_BYTES).text,
      exit_code: command.exitCode,
      elapsed_ms: command.elapsedMs,
    }));
}

function countCappedChecks(result: VerifyResult): boolean {
  if (result.checks.length > MAX_AGENT_CHECKS) return true;
  return result.checks.some(check => {
    const rawReason = check.reason ?? (check.ok ? undefined : "check failed");
    return rawReason !== undefined &&
      Buffer.byteLength(rawReason, "utf8") > MAX_AGENT_REASON_BYTES;
  });
}

function countCappedSuccessfulCommands(result: VerifyResult): boolean {
  const commands = result.checks.flatMap(check => check.commands ?? []).filter(command => command.ok);
  return commands.length > MAX_AGENT_SUCCESSFUL_COMMANDS ||
    commands.some(command => Buffer.byteLength(command.command, "utf8") > MAX_AGENT_COMMAND_BYTES);
}

function trimVerifySuccessfulCommands(projection: AgentVerifyProjection): boolean {
  if (projection.successful_commands.length === 0) return false;
  projection.successful_commands.pop();
  return true;
}

function trimVerifyChecks(projection: AgentVerifyProjection): boolean {
  if (projection.checks.length <= 1) return false;
  projection.checks.pop();
  return true;
}

function clearVerifyCheckReasons(projection: AgentVerifyProjection): boolean {
  let changed = false;
  for (const check of projection.checks) {
    if (check.reason !== undefined) {
      delete check.reason;
      changed = true;
    }
  }
  return changed;
}

function shrinkVerifySuccessfulCommand(projection: AgentVerifyProjection): boolean {
  for (const command of projection.successful_commands) {
    if (Buffer.byteLength(command.command, "utf8") > MINIMAL_COMMAND_BYTES) {
      command.command = shrinkString(command.command, MINIMAL_COMMAND_BYTES).value;
      return true;
    }
  }
  return false;
}

function minimalVerifyProjection(projection: AgentVerifyProjection): AgentVerifyProjection {
  return {
    ok: projection.ok,
    checks: projection.checks.slice(0, 1).map(check => ({
      name: check.name,
      ok: check.ok,
    })),
    successful_commands: [],
    projection_truncated: true,
  };
}

function enforceVerifyProjectionLimit(
  projection: AgentVerifyProjection,
): AgentVerifyProjection {
  const envelope = () => ({ verify: projection });
  if (jsonBytes(envelope()) <= MAX_AGENT_PROJECTION_BYTES) return projection;
  projection.projection_truncated = true;

  const shrinkers: Array<() => boolean> = [
    () => clearVerifyCheckReasons(projection),
    () => shrinkVerifySuccessfulCommand(projection),
    () => trimVerifySuccessfulCommands(projection),
    () => trimVerifyChecks(projection),
  ];

  while (jsonBytes(envelope()) > MAX_AGENT_PROJECTION_BYTES) {
    let changed = false;
    for (const shrink of shrinkers) {
      if (jsonBytes(envelope()) <= MAX_AGENT_PROJECTION_BYTES) break;
      changed = shrink() || changed;
    }
    if (!changed) return minimalVerifyProjection(projection);
  }
  return projection;
}

export function projectVerifySummaryForAgent(result: VerifyResult): AgentVerifyProjection {
  const projection: AgentVerifyProjection = {
    ok: result.ok,
    checks: summarizeAgentChecks(result),
    successful_commands: summarizeSuccessfulAgentCommands(result),
  };
  const truncated = countCappedChecks(result) || countCappedSuccessfulCommands(result);
  if (truncated) projection.projection_truncated = true;
  return enforceVerifyProjectionLimit(projection);
}

export function projectPreflightFailureForAgent(
  kind: FailureKind,
  reason?: string,
  check = "preflight",
): AgentFailureProjection {
  const cappedReason = capText(reason, MAX_AGENT_REASON_BYTES);
  const projection: AgentFailureProjection = {
    failure: {
      schema_version: 1,
      kind,
      check,
      ...(cappedReason.value !== undefined ? { reason: cappedReason.value } : {}),
      ...(cappedReason.truncated ? { projection_truncated: true } : {}),
    },
    verify: {
      ok: false,
      checks: [
        {
          name: check,
          ok: false,
          ...(cappedReason.value !== undefined ? { reason: cappedReason.value } : {}),
        },
      ],
      successful_commands: [],
      ...(cappedReason.truncated ? { projection_truncated: true } : {}),
    },
  };
  return enforceAgentProjectionLimit(projection);
}

function shrinkString(value: string, floorBytes = 0): { value: string; changed: boolean } {
  const currentBytes = Buffer.byteLength(value, "utf8");
  if (currentBytes <= floorBytes) return { value, changed: false };
  const nextBytes = Math.max(floorBytes, Math.floor(currentBytes / 2));
  return { value: truncateUtf8(value, nextBytes).text, changed: true };
}

function shrinkStringSuffix(value: string, floorBytes = 0): { value: string; changed: boolean } {
  const currentBytes = Buffer.byteLength(value, "utf8");
  if (currentBytes <= floorBytes) return { value, changed: false };
  const nextBytes = Math.max(floorBytes, Math.floor(currentBytes / 2));
  return { value: truncateUtf8Suffix(value, nextBytes).text, changed: true };
}

function shrinkExcerptField(
  excerpt: OutputExcerpt | undefined,
  field: "head" | "tail",
): boolean {
  if (!excerpt || excerpt[field].length === 0) return false;
  const beforeBytes = Buffer.byteLength(excerpt[field], "utf8");
  const next = field === "tail"
    ? shrinkStringSuffix(excerpt[field])
    : shrinkString(excerpt[field]);
  if (!next.changed) return false;
  excerpt[field] = next.value;
  const afterBytes = Buffer.byteLength(excerpt[field], "utf8");
  excerpt.omitted_bytes += Math.max(0, beforeBytes - afterBytes);
  excerpt.truncated = true;
  return true;
}

function trimSuccessfulCommands(projection: AgentFailureProjection): boolean {
  if (projection.verify.successful_commands.length === 0) return false;
  projection.verify.successful_commands.pop();
  return true;
}

function trimChecks(projection: AgentFailureProjection): boolean {
  if (projection.verify.checks.length <= 1) return false;
  projection.verify.checks.pop();
  return true;
}

function clearCheckReasons(projection: AgentFailureProjection): boolean {
  let changed = false;
  for (const check of projection.verify.checks) {
    if (check.reason !== undefined) {
      delete check.reason;
      changed = true;
    }
  }
  return changed;
}

function shrinkCapsuleText(projection: AgentFailureProjection): boolean {
  const failure = projection.failure;
  if (failure.command && Buffer.byteLength(failure.command, "utf8") > MINIMAL_COMMAND_BYTES) {
    failure.command = shrinkString(failure.command, MINIMAL_COMMAND_BYTES).value;
    return true;
  }
  if (failure.reason !== undefined) {
    delete failure.reason;
    return true;
  }
  return false;
}

function minimalProjection(projection: AgentFailureProjection): AgentFailureProjection {
  const stderrTail = projection.failure.stderr_excerpt
    ? truncateUtf8Suffix(
        projection.failure.stderr_excerpt.tail || projection.failure.stderr_excerpt.head,
        MINIMAL_STDERR_TAIL_BYTES,
      ).text
    : undefined;
  return {
    failure: {
      schema_version: 1,
      kind: projection.failure.kind,
      check: projection.failure.check,
      ...(projection.failure.fingerprint ? { fingerprint: projection.failure.fingerprint } : {}),
      ...(stderrTail
        ? {
            stderr_excerpt: {
              head: "",
              tail: stderrTail,
              captured_bytes: projection.failure.stderr_excerpt!.captured_bytes,
              omitted_bytes: Math.max(
                projection.failure.stderr_excerpt!.omitted_bytes,
                projection.failure.stderr_excerpt!.captured_bytes -
                  Buffer.byteLength(stderrTail, "utf8"),
              ),
              truncated: true,
            },
          }
        : {}),
      ...(projection.failure.evidence_ref ? { evidence_ref: projection.failure.evidence_ref } : {}),
      ...(projection.failure.retrieve_command
        ? { retrieve_command: projection.failure.retrieve_command }
        : {}),
      ...(projection.failure.evidence_available === false
        ? {
            evidence_available: false,
            ...(projection.failure.evidence_error
              ? { evidence_error: projection.failure.evidence_error }
              : {}),
          }
        : {}),
      projection_truncated: true,
    },
    verify: {
      ok: projection.verify.ok,
      checks: projection.verify.checks.slice(0, 1).map(check => ({
        name: check.name,
        ok: check.ok,
      })),
      successful_commands: [],
      projection_truncated: true,
    },
  };
}

export function minimizeAgentFailureProjection(
  projection: AgentFailureProjection,
): AgentFailureProjection {
  return minimalProjection(projection);
}

export function minimizeAgentVerifyProjection(
  projection: AgentVerifyProjection,
): AgentVerifyProjection {
  return minimalVerifyProjection(projection);
}

function enforceAgentProjectionLimit(
  projection: AgentFailureProjection,
): AgentFailureProjection {
  if (jsonBytes(projection) <= MAX_AGENT_PROJECTION_BYTES) return projection;
  projection.failure.projection_truncated = true;
  projection.verify.projection_truncated = true;

  const shrinkers: Array<() => boolean> = [
    () => shrinkExcerptField(projection.failure.stdout_excerpt, "head"),
    () => shrinkExcerptField(projection.failure.stdout_excerpt, "tail"),
    () => trimSuccessfulCommands(projection),
    () => trimChecks(projection),
    () => clearCheckReasons(projection),
    () => shrinkCapsuleText(projection),
    () => shrinkExcerptField(projection.failure.stderr_excerpt, "head"),
    () => shrinkExcerptField(projection.failure.stderr_excerpt, "tail"),
  ];

  while (jsonBytes(projection) > MAX_AGENT_PROJECTION_BYTES) {
    let changed = false;
    for (const shrink of shrinkers) {
      if (jsonBytes(projection) <= MAX_AGENT_PROJECTION_BYTES) break;
      changed = shrink() || changed;
    }
    if (!changed) return minimalProjection(projection);
  }
  return projection;
}

function evidenceError(error: unknown): {
  code: "EVIDENCE_UNAVAILABLE";
  cause_code: "EVIDENCE_CONFLICT" | "EVIDENCE_PATH_UNSAFE" | "EVIDENCE_WRITE_FAILED";
  system_code?: string;
  message?: string;
} {
  const systemCode = (error as NodeJS.ErrnoException).code;
  const causeCode =
    systemCode === "EVIDENCE_CONFLICT"
      ? "EVIDENCE_CONFLICT"
      : systemCode === "PATH_NOT_OWNED" ||
          systemCode === "PATH_OUTSIDE_PROJECT" ||
          systemCode === "FS_AUTHORITY_FAILURE"
        ? "EVIDENCE_PATH_UNSAFE"
        : "EVIDENCE_WRITE_FAILED";
  const message = error instanceof Error
    ? capText(error.message, MAX_AGENT_EVIDENCE_ERROR_MESSAGE_BYTES).value
    : undefined;
  return {
    code: "EVIDENCE_UNAVAILABLE",
    cause_code: causeCode,
    ...(systemCode !== undefined
      ? { system_code: truncateUtf8(systemCode, MAX_AGENT_SYSTEM_CODE_BYTES).text }
      : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

export type AgentJsonEnvelope =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      error: { code: string; cause_code?: string; message: string };
      data: Record<string, unknown>;
    };

function agentJsonLineBytes(envelope: AgentJsonEnvelope): number {
  return Buffer.byteLength(`${JSON.stringify(envelope)}\n`, "utf8");
}

function omitAgentDataField(data: Record<string, unknown>, field: string): boolean {
  if (!(field in data)) return false;
  delete data[field];
  data.projection_truncated = true;
  const omitted = Array.isArray(data.omitted_fields)
    ? data.omitted_fields.filter((value): value is string => typeof value === "string")
    : [];
  if (!omitted.includes(field)) omitted.push(field);
  data.omitted_fields = omitted;
  return true;
}

function stringifyAgentEnvelopeOrThrow(envelope: AgentJsonEnvelope): string {
  const line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line, "utf8") >= MAX_AGENT_JSON_BYTES) {
    throw new Error("agent JSON envelope could not be bounded below 24 KiB");
  }
  return line;
}

export function stringifyBoundedAgentEnvelope(envelope: AgentJsonEnvelope): string {
  const data = envelope.data as Record<string, unknown>;
  if (agentJsonLineBytes(envelope) < MAX_AGENT_JSON_BYTES) {
    return `${JSON.stringify(envelope)}\n`;
  }

  const omissionOrder = [
    "suggested_next_command",
    "would_append",
    "event",
    "phases",
    "task_id",
    "phase_id",
    "agent",
  ];
  for (const field of omissionOrder) {
    if (agentJsonLineBytes(envelope) < MAX_AGENT_JSON_BYTES) {
      return `${JSON.stringify(envelope)}\n`;
    }
    omitAgentDataField(data, field);
  }

  if ("failure" in data && "verify" in data) {
    const minimized = enforceAgentProjectionLimit({
      failure: data.failure as FailureCapsule,
      verify: data.verify as AgentVerifyProjection,
    });
    data.failure = minimized.failure;
    data.verify = minimized.verify;
    data.projection_truncated = true;
  } else if ("verify" in data) {
    data.verify = enforceVerifyProjectionLimit(data.verify as AgentVerifyProjection);
    data.projection_truncated = true;
  }

  if (agentJsonLineBytes(envelope) >= MAX_AGENT_JSON_BYTES && "failure" in data) {
    const minimized = minimalProjection({
      failure: data.failure as FailureCapsule,
      verify: (data.verify ?? {
        ok: false,
        checks: [],
        successful_commands: [],
      }) as AgentVerifyProjection,
    });
    data.failure = minimized.failure;
    if ("verify" in data) data.verify = minimized.verify;
    data.projection_truncated = true;
  }

  return stringifyAgentEnvelopeOrThrow(envelope);
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
  const reason = capText(firstFailure.reason, MAX_AGENT_REASON_BYTES);
  const capsule: FailureCapsule = {
    schema_version: 1,
    kind: kindForCheck(firstFailure, failedCommand),
    check: firstFailure.name,
    ...(reason.value ? { reason: reason.value } : {}),
    ...(reason.truncated ? { projection_truncated: true } : {}),
  };

  if (failedCommand !== null) {
    const command = truncateUtf8(failedCommand.command, MAX_AGENT_COMMAND_BYTES);
    const stdoutExcerpt = excerptText(failedCommand.stdout, STDOUT_EXCERPT_LIMITS);
    const stderrExcerpt = excerptText(failedCommand.stderr, STDERR_EXCERPT_LIMITS);

    capsule.command = command.text;
    capsule.exit_code = failedCommand.exitCode;
    capsule.timed_out = failedCommand.timedOut;
    capsule.aborted = failedCommand.aborted;
    capsule.elapsed_ms = failedCommand.elapsedMs;
    capsule.fingerprint = fingerprintFailure(failedCommand, cwd, {
      stdout: stdoutExcerpt,
      stderr: stderrExcerpt,
    });
    capsule.stdout_excerpt = stdoutExcerpt;
    capsule.stderr_excerpt = stderrExcerpt;
    if (command.truncated) capsule.projection_truncated = true;

    try {
      const stored = await storeEvidenceArtifact(cwd, {
        schema_version: 1,
        command: failedCommand.command,
        exit_code: failedCommand.exitCode,
        timed_out: failedCommand.timedOut,
        aborted: failedCommand.aborted,
        elapsed_ms: failedCommand.elapsedMs,
        stdout: failedCommand.stdout,
        stderr: failedCommand.stderr,
        stdout_capture_truncated: failedCommand.stdoutTruncated === true,
        stderr_capture_truncated: failedCommand.stderrTruncated === true,
      });
      capsule.evidence_available = true;
      capsule.evidence_ref = stored.ref;
      capsule.retrieve_command = `code-pact evidence show ${stored.ref} --json`;
    } catch (error) {
      capsule.evidence_available = false;
      capsule.evidence_error = evidenceError(error);
    }
  }

  return enforceAgentProjectionLimit({
    failure: capsule,
    verify: projectVerifySummaryForAgent(result),
  });
}
