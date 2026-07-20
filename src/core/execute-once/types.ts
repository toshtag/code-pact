import type { FailureCapsule } from "../evidence/failure-capsule.ts";

export const MAX_SOURCE_BYTES = 8192;
export const MAX_SOURCE_LINES = 120;
export const MAX_REASON_BYTES = 512;
export const MAX_EXECUTOR_FAILED_REASON_BYTES = 2048;
export const MAX_NEW_TEXT_BYTES = 8192;
export const MAX_EXECUTOR_INPUT_BYTES = 12_288;
export const MAX_EXECUTOR_OUTPUT_BYTES = 24_576;
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 120_000;

export function truncateExecuteReason(
  text: string,
  maxBytes = MAX_EXECUTOR_FAILED_REASON_BYTES,
): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  const prefix = "[truncated] ";
  const max = Math.max(0, maxBytes - Buffer.byteLength(prefix, "utf8"));
  let cut = max;
  const buffer = Buffer.from(text, "utf8");
  while (cut > 0 && (buffer[cut]! & 0b1100_0000) === 0b1000_0000) {
    cut -= 1;
  }
  return prefix + buffer.subarray(0, cut).toString("utf8");
}

export type OneShotEligibility =
  | {
      eligible: true;
      sourcePath: string;
      verificationCommand: string;
    }
  | {
      eligible: false;
      reasons: string[];
    };

export type OneShotExecutorInputTask = {
  id: string;
  goal: string;
  source_path: string;
  done_when: string[];
  verification_command: string;
};

export type OneShotExecutorInput = {
  schema_version: 1;
  task: OneShotExecutorInputTask;
  source: {
    content: string;
    sha256: string;
  };
  response_contract: {
    allowed_kinds: ["replace_exact", "blocked"];
  };
};

export type OneShotExecutorOutputReplaceExact = {
  kind: "replace_exact";
  expected_file_sha256: string;
  old_text: string;
  new_text: string;
};

export type OneShotExecutorOutputBlocked = {
  kind: "blocked";
  reason: string;
};

export type OneShotExecutorOutput =
  | OneShotExecutorOutputReplaceExact
  | OneShotExecutorOutputBlocked;

export interface OneShotExecutor {
  /** Adapters return an untrusted value; the controller validates it. */
  invoke(input: OneShotExecutorInput): Promise<unknown>;
}

export type ExactReplacement = {
  path: string;
  expected_file_sha256: string;
  old_text: string;
  new_text: string;
};

export type ApplyExactReplacementResult =
  | {
      kind: "applied";
      originalContent: string;
      appliedContent: string;
    }
  | {
      kind: "rejected";
      reason: string;
    };

export type BoundedFailureCapsule = FailureCapsule;

export type BoundedPathSummary = {
  changed_path_count: number;
  changed_paths: string[];
  paths_truncated: boolean;
};

export type TaskExecuteOnceResult =
  | {
      kind: "done";
      task_id: string;
      changed_file: string;
      verification: "passed";
    }
  | {
      kind: "ineligible";
      reasons: string[];
    }
  | {
      kind: "worktree_not_clean";
      paths: BoundedPathSummary;
    }
  | {
      kind: "blocked";
      reason: string;
    }
  | {
      kind: "executor_failed";
      reason: string;
    }
  | {
      kind: "edit_rejected";
      reason: string;
    }
  | {
      kind: "executor_mutated_worktree";
      paths: BoundedPathSummary;
      rollback: "complete" | "incomplete" | "stale" | "not_attempted";
      rollback_reason?: string;
      head_changed: boolean;
      index_changed: boolean;
    }
  | {
      kind: "execution_scope_violation";
      paths: BoundedPathSummary;
      rollback: "complete" | "incomplete" | "stale";
      head_changed: boolean;
      index_changed: boolean;
    }
  | {
      kind: "git_state_unavailable";
      reason: string;
      source_rollback: "complete" | "stale" | "failed" | "not_needed";
    }
  | {
      kind: "verification_failed";
      rolled_back: true;
      failure: BoundedFailureCapsule;
    }
  | {
      kind: "rollback_failed";
      reason: string;
      failure?: BoundedFailureCapsule;
    }
  | {
      kind: "rollback_stale_file";
      reason: string;
      applied_sha?: string;
    }
  | {
      kind: "rollback_incomplete";
      paths: BoundedPathSummary;
      failure?: BoundedFailureCapsule;
    };
