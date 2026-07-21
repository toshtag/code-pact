import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { emitOk, emitError } from "../util.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { runReviewBundle } from "../../commands/review-bundle.ts";
import { resolveEventAuthor } from "../../core/progress/author.ts";

export async function cmdReviewBundle(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const json = globalJson || argv.includes("--json");

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      output: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });

  const taskId = positionals[0];
  if (!taskId) {
    emitError(json, "CONFIG_ERROR", m.reviewBundle.missingTaskId);
    return 2;
  }

  const outputPath =
    typeof values.output === "string" && values.output.length > 0
      ? resolve(process.cwd(), values.output)
      : undefined;

  const cwd = process.cwd();
  try {
    const author = await resolveEventAuthor(cwd);
    const result = await runReviewBundle({
      cwd,
      taskId,
      outputPath,
      author,
      actor: "agent",
    });
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        phase_path: result.phase_path,
        manifest_path: result.manifest_path,
        bundle_path: result.bundle_path,
        head_sha: result.head_sha,
        tree_sha: result.tree_sha,
        contract_digest: result.contract_digest,
      });
    } else {
      process.stderr.write(
        m.reviewBundle.written(
          result.task_id,
          result.phase_id,
          result.bundle_path,
        ),
      );
      process.stderr.write("\n");
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const taskId =
      (err as NodeJS.ErrnoException & { task_id?: string }).task_id ??
      positionals[0] ??
      "";
    const rawMessage = err instanceof Error ? err.message : String(err);
    if (
      code === "TASK_NOT_FOUND" ||
      code === "TASK_NOT_DONE" ||
      code === "TASK_CONTRACT_LOCK_REQUIRED" ||
      code === "TASK_CONTRACT_DRIFT" ||
      code === "VERIFICATION_FAILED" ||
      code === "WORKTREE_NOT_CLEAN" ||
      code === "ARCHIVE_BUNDLE_WRITE_FAILED" ||
      code === "REVIEW_EVIDENCE_STATE_MISMATCH" ||
      code === "REVIEW_EVIDENCE_VERIFICATION_MISSING" ||
      code === "REVIEW_EVIDENCE_SCOPE_IMPRECISE"
    ) {
      const declaredUnused =
        (err as NodeJS.ErrnoException & { declared_unused?: string[] })
          .declared_unused ?? [];
      const message =
        code === "REVIEW_EVIDENCE_STATE_MISMATCH"
          ? m.reviewBundle.stateMismatch(taskId)
          : code === "REVIEW_EVIDENCE_VERIFICATION_MISSING"
            ? m.reviewBundle.verificationMissing(taskId)
            : code === "REVIEW_EVIDENCE_SCOPE_IMPRECISE"
              ? m.reviewBundle.scopeImprecise(declaredUnused)
              : rawMessage;
      const data: Record<string, unknown> | undefined =
        code === "REVIEW_EVIDENCE_STATE_MISMATCH"
          ? {
              phase_status: (
                err as NodeJS.ErrnoException & { phase_status?: string }
              ).phase_status,
              derived_phase_status: (
                err as NodeJS.ErrnoException & { derived_phase_status?: string }
              ).derived_phase_status,
              task_status: (
                err as NodeJS.ErrnoException & { task_status?: string }
              ).task_status,
              derived_task_status: (
                err as NodeJS.ErrnoException & { derived_task_status?: string }
              ).derived_task_status,
            }
          : code === "REVIEW_EVIDENCE_SCOPE_IMPRECISE"
            ? { declared_unused: declaredUnused }
            : undefined;
      if (data !== undefined && Object.keys(data).length > 0) {
        emitError(json, code, message, { data });
      } else {
        emitError(json, code, message);
      }
      return 1;
    }
    if (code === "CONFIG_ERROR") {
      emitError(json, "CONFIG_ERROR", rawMessage);
      return 2;
    }
    throw err;
  }
}
