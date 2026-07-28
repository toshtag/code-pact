import { strictParse, ConfigError } from "../../lib/argv.ts";
import { toParseOptions } from "../spec/render.ts";
import { TASK_SPECS } from "../spec/task.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { withWriteLock, emitOk, emitError } from "../util.ts";
import { runTaskLock } from "../../commands/task-lock.ts";
import { resolveEventAuthor } from "../../core/progress/author.ts";

export async function cmdTaskLock(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task lock",
      argv,
      toParseOptions(TASK_SPECS.lock!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    emitError(json, "CONFIG_ERROR", m.task.lock.missingTaskId);
    return 2;
  }

  const baseRef =
    typeof values["base-ref"] === "string"
      ? (values["base-ref"] as string)
      : undefined;
  const agent =
    typeof values.agent === "string" ? (values.agent as string) : undefined;
  const specFile =
    typeof values["spec-file"] === "string"
      ? (values["spec-file"] as string)
      : undefined;
  const cwd = process.cwd();

  return withWriteLock(
    cwd,
    `task lock ${taskId}`,
    json,
    async (): Promise<number> => {
      try {
        const author = await resolveEventAuthor(cwd);
        const result = await runTaskLock({
          cwd,
          taskId,
          baseRef,
          agent,
          author,
          actor: "agent",
          specFile,
        });
        if (json) {
          emitOk({
            task_id: result.task_id,
            phase_id: result.phase_id,
            phase_path: result.phase_path,
            base_ref: result.base_ref,
            base_sha: result.base_sha,
            phase_blob_sha: result.phase_blob_sha,
            contract_digest: result.contract_digest,
            path: result.path,
          });
        } else {
          process.stderr.write(
            m.task.lock.locked(result.task_id, result.phase_id, result.path),
          );
          process.stderr.write("\n");
        }
        return 0;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === "TASK_CANCELLED") {
          emitError(json, code, message);
          return 2;
        }
        if (
          code === "TASK_NOT_FOUND" ||
          code === "TASK_CONTRACT_LOCK_EXISTS" ||
          code === "AMBIGUOUS_TASK_ID" ||
          code === "WORKTREE_NOT_CLEAN" ||
          code === "INVALID_TASK_TRANSITION"
        ) {
          emitError(json, code, message);
          return 1;
        }
        // A supplied review contract that contradicts its task is a declaration
        // error the caller fixes in the phase YAML, so it exits 2 with the same
        // structured envelope every other refusal uses — never the top-level
        // internal-error path, which would leave an agent parsing `--json` with
        // nothing machine-readable to act on. No lock file exists at this point:
        // the check runs before the lock is written.
        if (code === "TASK_REVIEW_CONTRACT_INVALID") {
          const invalid = err as NodeJS.ErrnoException & {
            issues?: { message: string; path: string; details: unknown }[];
          };
          emitError(json, code, message, {
            data: { task_id: taskId, issues: invalid.issues ?? [] },
          });
          return 2;
        }
        // The project requires a review contract and this task declares none.
        // Same envelope shape and exit code as the invalid-contract refusal —
        // an agent should not need two parsers for "your review contract is
        // the problem". `data` names the policy so the message is actionable
        // without re-reading project.yaml. No lock file exists at this point.
        if (code === "TASK_REVIEW_CONTRACT_REQUIRED") {
          const required = err as NodeJS.ErrnoException & {
            review_contract_policy?: string;
          };
          emitError(json, code, message, {
            data: {
              task_id: taskId,
              review_contract_policy: required.review_contract_policy,
            },
          });
          return 2;
        }
        if (code === "TASK_REGISTRATION_SPEC_MISMATCH") {
          const mismatch = err as NodeJS.ErrnoException & {
            task_id?: string;
            expected_spec_digest?: string;
            actual_task_digest?: string;
            changed_fields?: string[];
          };
          emitError(json, code, message, {
            data: {
              task_id: mismatch.task_id,
              expected_spec_digest: mismatch.expected_spec_digest,
              actual_task_digest: mismatch.actual_task_digest,
              changed_fields: mismatch.changed_fields,
            },
          });
          return 2;
        }
        if (code === "CONFIG_ERROR") {
          emitError(json, "CONFIG_ERROR", message);
          return 2;
        }
        throw err;
      }
    },
  );
}

function emitParseConfigError(
  err: unknown,
  rawArgs: string[],
  useGlobalJson: boolean,
): number {
  if (!(err instanceof ConfigError)) throw err;
  emitError(
    useGlobalJson || rawArgs.includes("--json"),
    "CONFIG_ERROR",
    (err as Error).message,
  );
  return 2;
}
