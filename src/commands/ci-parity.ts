import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { currentHeadSha, readReviewManifest } from "../core/review-bundle.ts";

export type CiParityOptions = {
  cwd: string;
  taskId: string;
};

export type CiParityResult = {
  kind: "ok";
  task_id: string;
  phase_id: string;
  tested_head: string;
  current_head: string;
  ci_status: string;
  classifier_result?: string;
};

export async function runCiParity(
  opts: CiParityOptions,
): Promise<CiParityResult> {
  const { cwd, taskId } = opts;
  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);
  const manifest = await readReviewManifest(cwd, taskId);
  if (manifest === null) {
    const err = new Error(
      `No review manifest found for "${taskId}". Run "code-pact review-bundle ${taskId}" first.`,
    );
    (err as NodeJS.ErrnoException).code = "CI_PARITY_MANIFEST_MISSING";
    throw err;
  }

  const currentHead = await currentHeadSha(cwd);
  if (manifest.tested_head !== currentHead) {
    const err = new Error(
      `ci-parity: tested HEAD mismatch. Manifest: ${manifest.tested_head}, current: ${currentHead}.`,
    );
    (err as NodeJS.ErrnoException).code = "CI_PARITY_HEAD_MISMATCH";
    throw err;
  }

  if (manifest.ci_status !== "success") {
    const err = new Error(
      `ci-parity: CI status is "${manifest.ci_status}", expected "success".`,
    );
    (err as NodeJS.ErrnoException).code = "CI_PARITY_STATUS_MISMATCH";
    throw err;
  }

  if (
    manifest.classifier_result !== undefined &&
    manifest.classifier_result !== "success"
  ) {
    const err = new Error(
      `ci-parity: classifier result is "${manifest.classifier_result}", expected "success".`,
    );
    (err as NodeJS.ErrnoException).code = "CI_PARITY_CLASSIFIER_MISMATCH";
    throw err;
  }

  return {
    kind: "ok",
    task_id: taskId,
    phase_id: phaseId,
    tested_head: manifest.tested_head,
    current_head: currentHead,
    ci_status: manifest.ci_status,
    classifier_result: manifest.classifier_result,
  };
}
