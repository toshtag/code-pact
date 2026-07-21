import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveTaskInRoadmap } from "../core/plan/resolve-task.ts";
import {
  readReviewManifest,
  type ReviewManifest,
} from "../core/review-bundle.ts";
import { assertTaskContractCurrent } from "../core/contract-lock.ts";
import {
  classifyVerification,
  runVerificationCommands,
} from "../core/verify/classify.ts";

const execFileAsync = promisify(execFile);

export type CiParityOptions = {
  cwd: string;
  taskId: string;
};

export type CiParityResult = {
  kind: "ok";
  task_id: string;
  phase_id: string;
  head_sha: string;
  tree_sha: string;
  local_verification_passed: boolean;
  remote_ci_status: string;
};

async function currentHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

async function currentTreeSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD^{tree}"],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

function manifestFieldChanged(
  manifest: ReviewManifest,
  currentHead: string,
  currentTree: string,
): void {
  if (manifest.head_sha !== currentHead || manifest.tree_sha !== currentTree) {
    const err = new Error(
      `ci-parity: HEAD/tree mismatch. Manifest head=${manifest.head_sha}, tree=${manifest.tree_sha}; current head=${currentHead}, tree=${currentTree}.`,
    );
    (err as NodeJS.ErrnoException).code = "CI_PARITY_HEAD_MISMATCH";
    throw err;
  }
}

export async function runCiParity(
  opts: CiParityOptions,
): Promise<CiParityResult> {
  const { cwd, taskId } = opts;
  const { phaseId } = await resolveTaskInRoadmap(cwd, taskId);

  const manifest = await readReviewManifest(cwd, taskId);
  if (manifest === null) {
    const err = new Error(
      `No review manifest found for "${taskId}". Run "code-pact task review-bundle ${taskId}" first.`,
    );
    (err as NodeJS.ErrnoException).code = "CI_PARITY_MANIFEST_MISSING";
    throw err;
  }

  await assertTaskContractCurrent({ cwd, taskId, requireLock: true });

  const currentHead = await currentHeadSha(cwd);
  const currentTree = await currentTreeSha(cwd);
  manifestFieldChanged(manifest, currentHead, currentTree);

  // Re-run the classifier-selected verification commands using the locked base.
  const classification = await classifyVerification(cwd, manifest.base_sha);
  const verification = await runVerificationCommands(
    cwd,
    classification.commands,
  );
  if (!verification.ok) {
    const failed = verification.results.find(r => r.exit_code !== 0);
    const err = new Error(
      `ci-parity: local verification failed (${failed?.command ?? "unknown"}).`,
    );
    (err as NodeJS.ErrnoException).code = "VERIFICATION_FAILED";
    throw err;
  }

  return {
    kind: "ok",
    task_id: taskId,
    phase_id: phaseId,
    head_sha: currentHead,
    tree_sha: currentTree,
    local_verification_passed: true,
    remote_ci_status: manifest.remote_ci.status,
  };
}
