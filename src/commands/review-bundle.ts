import {
  runReviewBundle as runCoreReviewBundle,
  type ReviewBundleResult,
} from "../core/review-bundle.ts";

export type ReviewBundleOptions = {
  cwd: string;
  taskId: string;
  outputPath?: string;
  agent?: string;
  author?: string;
  actor?: "agent" | "user";
};

export { type ReviewBundleResult };

export async function runReviewBundle(
  opts: ReviewBundleOptions,
): Promise<ReviewBundleResult> {
  return runCoreReviewBundle({
    cwd: opts.cwd,
    taskId: opts.taskId,
    outputPath: opts.outputPath,
    agent: opts.agent,
    author: opts.author,
    actor: opts.actor,
  });
}
