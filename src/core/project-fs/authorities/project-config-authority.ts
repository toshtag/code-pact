import {
  brandProjectPresence,
  brandProjectTreeList,
  type OwnedDeletePath,
  type OwnedListPath,
  type OwnedReadPath,
  type OwnedWritePath,
  type ProjectTreeListPath,
  type ProjectPresencePath,
} from "../branded-paths-internal.ts";
import { basename, dirname } from "node:path";
import {
  assertSafeRelativePath,
  resolveSymlinkFreeProjectPathSync,
} from "../../path-safety.ts";
import {
  resolveAndBrandDeleteForAuthority,
  resolveAndBrandListForAuthority,
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";

const PROJECT_SCAFFOLD_PATHS = new Set([
  ".gitignore",
  ".code-pact",
  ".code-pact/project.yaml",
  ".code-pact/agent-profiles",
  ".code-pact/model-profiles",
  ".code-pact/state",
  ".code-pact/state/baselines",
  ".code-pact/state/progress.yaml",
  ".code-pact/state/baselines/initial.json",
  "design",
  "design/rules",
  "design/phases",
  "design/decisions",
  "design/constitution.md",
  "design/brief.md",
  "design/rules/coding-style.md",
  "design/roadmap.yaml",
]);

function isProjectScaffoldPath(path: string): boolean {
  return (
    PROJECT_SCAFFOLD_PATHS.has(path) ||
    (path.startsWith(".code-pact/agent-profiles/") &&
      path.endsWith(".yaml")) ||
    (path.startsWith(".code-pact/model-profiles/") && path.endsWith(".yaml"))
  );
}
export { unbrand } from "../branded-paths.ts";
export type {
  OwnedDeletePath,
  OwnedListPath,
  OwnedReadPath,
  OwnedWritePath,
  ProjectTreeListPath,
  ProjectPresencePath,
} from "../branded-paths.ts";

function isProjectRuntimeLockDir(path: string): boolean {
  return path === ".code-pact/locks";
}

function isProjectRuntimeLockFile(path: string): boolean {
  return path === ".code-pact/locks/write.lock";
}

function isProgressEventsDir(path: string): boolean {
  return path === ".code-pact/state/events";
}

function isProgressEventPath(path: string): boolean {
  return (
    path.startsWith(".code-pact/state/events/") &&
    !path.slice(".code-pact/state/events/".length).includes("/")
  );
}

function mapProjectRuntimeConfigError(err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === "PATH_OUTSIDE_PROJECT" ||
    code === "PATH_NOT_OWNED" ||
    code === "ENOTDIR" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ELOOP" ||
    code === "FS_AUTHORITY_FAILURE"
  ) {
    const wrapped = new Error((err as Error).message);
    (wrapped as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw wrapped;
  }
  throw err;
}

export async function resolveProjectTreeListPath(
  cwd: string,
  relPath: string,
): Promise<ProjectTreeListPath> {
  const path = await resolveAndBrandListForAuthority(cwd, relPath, () => true);
  return brandProjectTreeList(path);
}

export async function resolveProjectScaffoldReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(cwd, relPath, isProjectScaffoldPath);
}

export async function resolveProjectPresenceReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(
    cwd,
    relPath,
    p =>
      p === ".code-pact/project.yaml" ||
      p === "design/brief.md" ||
      p === "design/constitution.md" ||
      (!p.includes("/") && p.endsWith(".md")),
  );
}

export async function resolveProjectScaffoldWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(cwd, relPath, isProjectScaffoldPath);
}

export async function resolveProjectRuntimeLockReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  try {
    return await resolveAndBrandReadForAuthority(
      cwd,
      ".code-pact/locks/write.lock",
      isProjectRuntimeLockFile,
    );
  } catch (err) {
    mapProjectRuntimeConfigError(err);
  }
}

export async function resolveProjectRuntimeLockWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  try {
    return await resolveAndBrandWriteForAuthority(
      cwd,
      ".code-pact/locks/write.lock",
      isProjectRuntimeLockFile,
    );
  } catch (err) {
    mapProjectRuntimeConfigError(err);
  }
}

export async function resolveProjectRuntimeLockDeletePath(
  cwd: string,
): Promise<OwnedDeletePath> {
  try {
    return await resolveAndBrandDeleteForAuthority(
      cwd,
      ".code-pact/locks/write.lock",
      isProjectRuntimeLockFile,
    );
  } catch (err) {
    mapProjectRuntimeConfigError(err);
  }
}

export async function resolveProjectRuntimeLockDirWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  try {
    return await resolveAndBrandWriteForAuthority(
      cwd,
      ".code-pact/locks",
      isProjectRuntimeLockDir,
    );
  } catch (err) {
    mapProjectRuntimeConfigError(err);
  }
}

export async function resolveProgressEventsDirWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(
    cwd,
    ".code-pact/state/events",
    isProgressEventsDir,
  );
}

export async function resolveProgressEventsDirListPath(
  cwd: string,
): Promise<OwnedListPath> {
  return resolveAndBrandListForAuthority(
    cwd,
    ".code-pact/state/events",
    isProgressEventsDir,
  );
}

export async function resolveProgressEventReadPath(
  cwd: string,
  file: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandReadForAuthority(
    cwd,
    [".code-pact/state/events", file].join("/"),
    isProgressEventPath,
  );
}

export async function resolveProgressEventWritePath(
  cwd: string,
  file: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWriteForAuthority(
    cwd,
    [".code-pact/state/events", file].join("/"),
    isProgressEventPath,
  );
}

export async function resolveProgressEventDeletePath(
  cwd: string,
  file: string,
): Promise<OwnedDeletePath> {
  return resolveAndBrandDeleteForAuthority(
    cwd,
    [".code-pact/state/events", file].join("/"),
    isProgressEventPath,
  );
}

export async function resolveProjectProbeReadPath(
  cwd: string,
  relPath: string,
): Promise<ProjectPresencePath> {
  return brandProjectPresence(
    await resolveAndBrandReadForAuthority(cwd, relPath, () => true),
  );
}

export async function resolveStandaloneProjectProbeReadPath(
  path: string,
): Promise<ProjectPresencePath> {
  return resolveProjectProbeReadPath(dirname(path), basename(path));
}

export function resolveProjectProbeReadPathSync(
  cwd: string,
  relPath: string,
): ProjectPresencePath {
  assertSafeRelativePath(relPath);
  return brandProjectPresence(resolveSymlinkFreeProjectPathSync(cwd, relPath));
}
