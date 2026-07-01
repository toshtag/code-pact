import {
  brandOwnedDelete,
  brandOwnedList,
  brandOwnedRead,
  brandOwnedWrite,
  type OwnedDeletePath,
  type OwnedListPath,
  type OwnedReadPath,
  type OwnedWritePath,
} from "../branded-paths-internal.ts";
import {
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
} from "../branded-paths.ts";

export function projectConfigReadPath(path: string): OwnedReadPath {
  return brandOwnedRead(path);
}

export function projectConfigWritePath(path: string): OwnedWritePath {
  return brandOwnedWrite(path);
}

export function projectConfigDeletePath(path: string): OwnedDeletePath {
  return brandOwnedDelete(path);
}

export function projectConfigListPath(path: string): OwnedListPath {
  return brandOwnedList(path);
}

export async function resolveProjectTreeListPath(
  cwd: string,
  relPath: string,
): Promise<OwnedListPath> {
  return resolveAndBrandListForAuthority(cwd, relPath, () => true);
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
