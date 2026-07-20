import { emitOk, emitError } from "../util.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { runCiParity } from "../../commands/ci-parity.ts";

export async function cmdCiParity(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const json = globalJson || argv.includes("--json");

  const taskId = argv.find(a => !a.startsWith("-"));
  if (!taskId || taskId === "--json") {
    emitError(json, "CONFIG_ERROR", m.ciParity.missingTaskId);
    return 2;
  }

  const cwd = process.cwd();
  try {
    const result = await runCiParity({ cwd, taskId });
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        tested_head: result.tested_head,
        current_head: result.current_head,
        ci_status: result.ci_status,
        classifier_result: result.classifier_result,
      });
    } else {
      process.stderr.write(m.ciParity.ok(result.task_id));
      process.stderr.write("\n");
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if (
      code === "TASK_NOT_FOUND" ||
      code === "CI_PARITY_MANIFEST_MISSING" ||
      code === "CI_PARITY_HEAD_MISMATCH" ||
      code === "CI_PARITY_STATUS_MISMATCH" ||
      code === "CI_PARITY_CLASSIFIER_MISMATCH"
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
