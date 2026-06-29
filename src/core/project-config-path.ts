import { resolveSymlinkFreeProjectPath } from "./path-safety.ts";

/**
 * Single source of truth for the project config path. Uses
 * {@link resolveSymlinkFreeProjectPath} so an in-project symlink alias
 * (e.g. `.code-pact/project.yaml -> ../alt/project.yaml`) is rejected
 * before any read. Containment is not ownership.
 */
export async function resolveProjectConfigPath(
  cwd: string,
): Promise<string> {
  return resolveSymlinkFreeProjectPath(cwd, ".code-pact/project.yaml");
}
