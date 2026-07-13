import type {
  LifecycleMode,
  RepairDisabledReasonCode,
  RepairPolicy,
} from "../schemas/recommend-result.ts";
import type { Task } from "../schemas/task.ts";

function disabled(
  reasonCode: RepairDisabledReasonCode,
): RepairPolicy {
  return {
    mode: "disabled",
    reasonCode,
  };
}

export function recommendRepairPolicy(
  task: Task,
  lifecycleMode: LifecycleMode,
): RepairPolicy {
  if (lifecycleMode === "decision_loop") {
    return disabled("decision_loop");
  }

  if (lifecycleMode === "record_only") {
    return disabled("record_only");
  }

  if (task.type === "architecture") {
    return disabled("architecture");
  }

  if (task.ambiguity === "high") {
    return disabled("high_ambiguity");
  }

  if (task.risk === "high") {
    return disabled("high_risk");
  }

  if (task.write_surface === "high") {
    return disabled("high_write_surface");
  }

  if (task.verification_strength === "weak") {
    return disabled("weak_verification");
  }

  return {
    mode: "bounded",
    maxRepairAttempts: 1,
    retryableFailureKinds: ["command_failed"],
    nonRetryableFailureKinds: [
      "timed_out",
      "aborted",
      "decision_required",
      "unsafe_write",
      "invalid_state",
      "unknown",
    ],
    retryContext: "failure_delta",
    firstRetry: "same_model_same_effort_same_context",
    stopOnRepeatedFingerprint: true,
    afterExhaustion: "use_allowed_escalation",
  };
}

export function formatRepairPolicySummary(
  policy: RepairPolicy,
): string {
  if (policy.mode === "disabled") {
    return `disabled (${policy.reasonCode})`;
  }

  return "bounded (max 1; command_failed only; same model/effort/context)";
}
