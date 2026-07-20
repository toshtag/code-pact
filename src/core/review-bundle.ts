import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  readOwnedText,
  mkdirOwned,
  writeOwnedText,
  resolveReviewManifestDirWritePath,
  resolveReviewManifestReadPath,
  resolveReviewManifestWritePath,
} from "./project-fs/index.ts";

const execFileAsync = promisify(execFile);

export const DoneEventRef = z.object({
  at: z.string().datetime(),
  evidence: z.array(z.string()).optional(),
  source: z.enum(["loop", "external"]).optional(),
});

export const ReviewManifest = z.object({
  task_id: z.string(),
  phase_id: z.string(),
  tested_head: z.string(),
  done_event: DoneEventRef.optional(),
  ci_status: z.enum(["success", "failure", "pending"]).default("pending"),
  ci_run_url: z.string().optional(),
  classifier_result: z.enum(["success", "failure", "pending"]).optional(),
  at: z.string().datetime(),
  actor: z.enum(["agent", "user"]),
  agent: z.string().optional(),
  author: z.string().optional(),
});

export type ReviewManifest = z.infer<typeof ReviewManifest>;

export function getReviewManifestPath(cwd: string, taskId: string): string {
  return join(cwd, ".code-pact", "state", "reviews", `${taskId}.yaml`);
}

export async function currentHeadSha(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    { cwd, encoding: "utf8" },
  );
  return stdout.trim();
}

export async function readReviewManifest(
  cwd: string,
  taskId: string,
): Promise<ReviewManifest | null> {
  try {
    const path = await resolveReviewManifestReadPath(cwd, `${taskId}.yaml`);
    const raw = await readOwnedText(path);
    return ReviewManifest.parse(parseYaml(raw) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeReviewManifest(
  cwd: string,
  manifest: ReviewManifest,
): Promise<void> {
  const dir = await resolveReviewManifestDirWritePath(cwd);
  await mkdirOwned(dir, { recursive: true });
  const path = await resolveReviewManifestWritePath(
    cwd,
    `${manifest.task_id}.yaml`,
  );
  await writeOwnedText(path, stringifyYaml(manifest));
}
