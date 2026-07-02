import {
  resolveProfileContextOutputWritePath,
  type OwnedWritePath,
} from "../project-fs/authorities/context-output-authority.ts";
import { ContextOutputDir } from "../schemas/agent-profile.ts";
import { PlanId } from "../schemas/plan-id.ts";

/**
 * Resolve the full output path for a context pack written under a
 * profile-derived `context_dir`. The path is constrained to the reserved
 * `.context/**` generated namespace and symlink-free project containment is
 * enforced on the FULL path (directory + filename), not just the directory.
 *
 * This is the OWNED-NAMESPACE companion to the generic containment check:
 * `resolveSymlinkFreeProjectPath` proves the path stays inside the project and
 * traverses no symlink, but it does NOT prove the path belongs to a generated
 * namespace. This helper adds that domain authority: `contextDir` must pass
 * `ContextOutputDir` (`.context` or `.context/**`) before any filesystem
 * resolution.
 *
 * Errors are normalised to `CONFIG_ERROR` so the CLI layer maps them to a
 * structured envelope (exit 2) instead of an internal error / exit 3.
 */
export async function resolveProfileContextOutputPath(
  cwd: string,
  contextDir: string,
  taskId: string,
): Promise<OwnedWritePath> {
  // 1. Schema-validate the context_dir namespace.
  try {
    ContextOutputDir.parse(contextDir);
  } catch {
    const e = new Error(
      `context_dir "${contextDir}" is not a valid context pack output directory — must be .context or a directory below .context/`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

  // 2. Validate task id (same charset as PlanId).
  try {
    PlanId.parse(taskId);
  } catch {
    const e = new Error(`task id "${taskId}" is not a valid plan identifier`);
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }

  // 3. Build the full output path and resolve through symlink-free containment.
  const relPath = `${contextDir}/${taskId}.md`;
  try {
    return await resolveProfileContextOutputWritePath(cwd, relPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PATH_OUTSIDE_PROJECT" || code === "PATH_NOT_OWNED") {
      const e = new Error(
        `context pack output path "${relPath}" is not a safe project-contained path: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}
