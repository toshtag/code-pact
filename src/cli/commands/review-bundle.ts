import { parseArgs } from "node:util";
import { emitOk, emitError } from "../util.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { runReviewBundle } from "../../commands/review-bundle.ts";
import { resolveEventAuthor } from "../../core/progress/author.ts";

const VALID_CI_STATUS = new Set(["success", "failure", "pending"]);
const VALID_CLASSIFIER = new Set(["success", "failure", "pending"]);

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
      "ci-status": { type: "string" },
      "ci-run-url": { type: "string" },
      "classifier-result": { type: "string" },
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

  const ciStatusRaw = values["ci-status"] as string | undefined;
  if (ciStatusRaw !== undefined && !VALID_CI_STATUS.has(ciStatusRaw)) {
    emitError(
      json,
      "CONFIG_ERROR",
      m.reviewBundle.invalidCiStatus(ciStatusRaw),
    );
    return 2;
  }

  const classifierRaw = values["classifier-result"] as string | undefined;
  if (classifierRaw !== undefined && !VALID_CLASSIFIER.has(classifierRaw)) {
    emitError(
      json,
      "CONFIG_ERROR",
      m.reviewBundle.invalidClassifierResult(classifierRaw),
    );
    return 2;
  }

  const cwd = process.cwd();
  try {
    const author = await resolveEventAuthor(cwd);
    const result = await runReviewBundle({
      cwd,
      taskId,
      ciStatus: ciStatusRaw as "success" | "failure" | "pending" | undefined,
      ciRunUrl: values["ci-run-url"] as string | undefined,
      classifierResult: classifierRaw as
        | "success"
        | "failure"
        | "pending"
        | undefined,
      author,
      actor: "agent",
    });
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        path: result.path,
        tested_head: result.tested_head,
      });
    } else {
      process.stderr.write(
        m.reviewBundle.written(
          result.task_id,
          result.phase_id,
          result.path,
        ),
      );
      process.stderr.write("\n");
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "TASK_NOT_FOUND" || code === "TASK_NOT_DONE") {
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
