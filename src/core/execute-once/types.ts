import type { FailureCapsule } from "../evidence/failure-capsule.ts";

export const MAX_SOURCE_BYTES = 8192;
export const MAX_SOURCE_LINES = 120;
export const MAX_REASON_BYTES = 512;
export const MAX_NEW_TEXT_BYTES = 8192;
export const MAX_EXECUTOR_INPUT_BYTES = 12_288;
export const MAX_EXECUTOR_OUTPUT_BYTES = 16_384;
export const DEFAULT_EXECUTOR_TIMEOUT_MS = 120_000;

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
  invoke(input: OneShotExecutorInput): Promise<OneShotExecutorOutput>;
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
    }
  | {
      kind: "rejected";
      reason: string;
    };

export type BoundedFailureCapsule = FailureCapsule;

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
      kind: "verification_failed";
      rolled_back: true;
      failure: BoundedFailureCapsule;
    }
  | {
      kind: "rollback_failed";
      reason: string;
      failure?: BoundedFailureCapsule;
    };
