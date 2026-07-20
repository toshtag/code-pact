import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import { loadProgressLog } from "../core/progress/io.ts";
import {
  currentHeadSha,
  getReviewManifestPath,
  writeReviewManifest,
  type ReviewManifest,
} from "../core/review-bundle.ts";

export type ReviewBundleOptions = {
  cwd: string;
  taskId: string;
  ciStatus?: "success" | "failure" | "pending";
  ciRunUrl?: string;
  classifierResult?: "success" | "failure" | "pending";
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
};

export type ReviewBundleResult = {
  kind: "written";
  task_id: string;
  phase_id: string;
  path: string;
  tested_head: string;
};

export async function runReviewBundle(
  opts: ReviewBundleOptions,
): Promise<ReviewBundleResult> {
  const { cwd, taskId } = opts;
  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);
  const { log } = await loadProgressLog(cwd);

  const doneEvents = log.events.filter(
    e => e.task_id === taskId && e.status === "done",
  );
  if (doneEvents.length === 0) {
    const err = new Error(
      `Cannot create review bundle for "${taskId}": no done event found.`,
    );
    (err as NodeJS.ErrnoException).code = "TASK_NOT_DONE";
    throw err;
  }
  const latest = doneEvents[doneEvents.length - 1]!;

  const testedHead = await currentHeadSha(cwd);

  const manifest: ReviewManifest = {
    task_id: taskId,
    phase_id: phaseId,
    tested_head: testedHead,
    done_event: {
      at: latest.at,
      evidence: latest.evidence,
      source: latest.source,
    },
    ci_status: opts.ciStatus ?? "pending",
    ...(opts.ciRunUrl ? { ci_run_url: opts.ciRunUrl } : {}),
    ...(opts.classifierResult
      ? { classifier_result: opts.classifierResult }
      : {}),
    at: new Date().toISOString(),
    actor: opts.actor ?? "agent",
    agent: opts.agent,
    author: opts.author,
  };

  await writeReviewManifest(cwd, manifest);

  return {
    kind: "written",
    task_id: taskId,
    phase_id: phaseId,
    path: getReviewManifestPath(cwd, taskId),
    tested_head: testedHead,
  };
}
