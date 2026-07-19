import { isDecisionRequiredForTask } from "../decisions/adr.ts";
import {
  readOwnedTextBounded,
  resolveExecuteSourceReadPath,
} from "../project-fs/index.ts";
import { deriveTaskState } from "../progress/task-state.ts";
import { RelativePosixPath } from "../schemas/relative-path.ts";
import type { Phase } from "../schemas/phase.ts";
import type { ProgressEvent } from "../schemas/progress-event.ts";
import type { Task } from "../schemas/task.ts";
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_LINES,
  type OneShotEligibility,
} from "./types.ts";

export const INELIGIBLE_REASONS = {
  TASK_STATE_NOT_ALLOWED: "TASK_STATE_NOT_ALLOWED",
  DECISION_REQUIRED: "DECISION_REQUIRED",
  DEPENDENCY_INCOMPLETE: "DEPENDENCY_INCOMPLETE",
  READ_SCOPE_EMPTY: "READ_SCOPE_EMPTY",
  MULTIPLE_READ_PATHS: "MULTIPLE_READ_PATHS",
  WRITE_SCOPE_EMPTY: "WRITE_SCOPE_EMPTY",
  MULTIPLE_WRITE_PATHS: "MULTIPLE_WRITE_PATHS",
  READ_WRITE_PATH_MISMATCH: "READ_WRITE_PATH_MISMATCH",
  INVALID_SOURCE_PATH: "INVALID_SOURCE_PATH",
  GLOB_SCOPE_UNSUPPORTED: "GLOB_SCOPE_UNSUPPORTED",
  GOAL_EMPTY: "GOAL_EMPTY",
  NO_DONE_CRITERIA: "NO_DONE_CRITERIA",
  NO_VERIFICATION_COMMAND: "NO_VERIFICATION_COMMAND",
  MULTIPLE_VERIFICATION_COMMANDS: "MULTIPLE_VERIFICATION_COMMANDS",
  SOURCE_NOT_FOUND: "SOURCE_NOT_FOUND",
  SOURCE_IS_SYMLINK: "SOURCE_IS_SYMLINK",
  SOURCE_OUTSIDE_REPOSITORY: "SOURCE_OUTSIDE_REPOSITORY",
  SOURCE_NOT_REGULAR_FILE: "SOURCE_NOT_REGULAR_FILE",
  SOURCE_NOT_VALID_TEXT: "SOURCE_NOT_VALID_TEXT",
  SOURCE_TOO_LARGE: "SOURCE_TOO_LARGE",
  LINE_COUNT_EXCEEDS_LIMIT: "LINE_COUNT_EXCEEDS_LIMIT",
} as const;

type IneligibleState = "planned" | "started" | "resumed";
const ELIGIBLE_STATES: ReadonlySet<TaskCurrentState> = new Set([
  "planned",
  "started",
  "resumed",
]);

export type OneShotEligibilityInput = {
  cwd: string;
  phase: Phase;
  task: Task;
  events: readonly ProgressEvent[];
};

import type { TaskCurrentState } from "../progress/task-state.ts";

function isEligibleState(state: TaskCurrentState): state is IneligibleState {
  return ELIGIBLE_STATES.has(state);
}

function goalText(task: Task, phase: Phase): string {
  return (task.description ?? phase.objective ?? "").trim();
}

const GLOB_METACHARACTERS = /[\\*?[{\]}]/;

function isGlobPattern(path: string): boolean {
  return GLOB_METACHARACTERS.test(path);
}

export async function resolveOneShotEligibility(
  input: OneShotEligibilityInput,
): Promise<OneShotEligibility> {
  const { cwd, phase, task, events } = input;
  const reasons: string[] = [];

  const { current: state } = deriveTaskState(events, task.id);
  if (!isEligibleState(state)) {
    reasons.push(INELIGIBLE_REASONS.TASK_STATE_NOT_ALLOWED);
  }

  if (isDecisionRequiredForTask(phase, task)) {
    reasons.push(INELIGIBLE_REASONS.DECISION_REQUIRED);
  }

  for (const depId of task.depends_on ?? []) {
    const depState = deriveTaskState(events, depId).current;
    if (depState !== "done") {
      reasons.push(INELIGIBLE_REASONS.DEPENDENCY_INCOMPLETE);
    }
  }

  const reads = task.reads ?? [];
  const writes = task.writes ?? [];

  if (reads.length === 0) {
    reasons.push(INELIGIBLE_REASONS.READ_SCOPE_EMPTY);
  } else if (reads.length > 1) {
    reasons.push(INELIGIBLE_REASONS.MULTIPLE_READ_PATHS);
  }

  if (writes.length === 0) {
    reasons.push(INELIGIBLE_REASONS.WRITE_SCOPE_EMPTY);
  } else if (writes.length > 1) {
    reasons.push(INELIGIBLE_REASONS.MULTIPLE_WRITE_PATHS);
  }

  let sourcePath: string | undefined;
  let pathStructuralReason = false;

  if (reads.length === 1 && writes.length === 1) {
    const readPath = reads[0]!;
    const writePath = writes[0]!;
    if (readPath !== writePath) {
      reasons.push(INELIGIBLE_REASONS.READ_WRITE_PATH_MISMATCH);
    } else {
      sourcePath = readPath;
      const parsed = RelativePosixPath.safeParse(sourcePath);
      if (!parsed.success) {
        reasons.push(INELIGIBLE_REASONS.INVALID_SOURCE_PATH);
        pathStructuralReason = true;
      } else if (isGlobPattern(sourcePath)) {
        reasons.push(INELIGIBLE_REASONS.GLOB_SCOPE_UNSUPPORTED);
        pathStructuralReason = true;
      }
    }
  }

  if (goalText(task, phase).length === 0) {
    reasons.push(INELIGIBLE_REASONS.GOAL_EMPTY);
  }

  const doneWhen = phase.definition_of_done ?? [];
  if (doneWhen.length === 0) {
    reasons.push(INELIGIBLE_REASONS.NO_DONE_CRITERIA);
  }

  const verificationCommands = phase.verification?.commands ?? [];
  if (verificationCommands.length === 0) {
    reasons.push(INELIGIBLE_REASONS.NO_VERIFICATION_COMMAND);
  } else if (verificationCommands.length > 1) {
    reasons.push(INELIGIBLE_REASONS.MULTIPLE_VERIFICATION_COMMANDS);
  }

  if (reasons.length > 0 || sourcePath === undefined || pathStructuralReason) {
    return { eligible: false, reasons };
  }

  const verificationCommand = verificationCommands[0]!;

  try {
    const readPath = await resolveExecuteSourceReadPath(cwd, sourcePath);
    const content = await readOwnedTextBounded(readPath, MAX_SOURCE_BYTES);
    const lineCount = countLogicalLines(content);
    if (lineCount > MAX_SOURCE_LINES) {
      reasons.push(INELIGIBLE_REASONS.LINE_COUNT_EXCEEDS_LIMIT);
    }
    if (reasons.length > 0) {
      return { eligible: false, reasons };
    }
    return {
      eligible: true,
      sourcePath,
      verificationCommand,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED") {
      reasons.push(INELIGIBLE_REASONS.SOURCE_IS_SYMLINK);
    } else if (code === "PATH_OUTSIDE_PROJECT") {
      reasons.push(INELIGIBLE_REASONS.SOURCE_OUTSIDE_REPOSITORY);
    } else if (code === "ENOENT") {
      reasons.push(INELIGIBLE_REASONS.SOURCE_NOT_FOUND);
    } else if (code === "ENOTFILE") {
      reasons.push(INELIGIBLE_REASONS.SOURCE_NOT_REGULAR_FILE);
    } else if (code === "OWNED_TEXT_TOO_LARGE") {
      reasons.push(INELIGIBLE_REASONS.SOURCE_TOO_LARGE);
    } else if (code === "OWNED_TEXT_INVALID_UTF8") {
      reasons.push(INELIGIBLE_REASONS.SOURCE_NOT_VALID_TEXT);
    } else {
      reasons.push(
        `${INELIGIBLE_REASONS.SOURCE_NOT_FOUND}:${code ?? (error as Error).message}`,
      );
    }
    return { eligible: false, reasons };
  }
}

export function countLogicalLines(content: string): number {
  if (content.length === 0) return 0;
  const normalized = content.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  if (parts[parts.length - 1] === "") {
    return parts.length - 1;
  }
  return parts.length;
}
