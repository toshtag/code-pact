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
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === "TASK_NOT_FOUND" ||
      code === "TASK_NOT_DONE" ||
      code === "TASK_CONTRACT_LOCK_REQUIRED" ||
      code === "TASK_CONTRACT_DRIFT" ||
      code === "VERIFICATION_FAILED" ||
      code === "WORKTREE_NOT_CLEAN" ||
      code === "ARCHIVE_BUNDLE_WRITE_FAILED"
    ) {
      emitError(json, code, message);
      return 1;
    }
    if (code === "CONFIG_ERROR") {
      emitError(json, "CONFIG_ERROR", message);
      return 2;
    }
    throw err;
  }
}
