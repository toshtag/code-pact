import {
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
import {
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";
export { unbrand } from "../branded-paths.ts";
export type { OwnedReadPath, OwnedWritePath } from "../branded-paths.ts";

function isAgentProfilePath(path: string): boolean {
  return path.startsWith(".code-pact/agent-profiles/") && path.endsWith(".yaml");
}

export async function resolveProfileReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(cwd, relPath, isAgentProfilePath);
}

export async function resolveProfileWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(cwd, relPath, isAgentProfilePath);
}
