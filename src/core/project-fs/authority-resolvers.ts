/**
 * Namespace-specific authority resolvers for filesystem reads.
 *
 * Each resolver validates that a path belongs to a specific owned namespace
 * (e.g. `design/decisions/`, `.code-pact/`, `design/phases/`) before branding
 * it as an {@link OwnedReadPath}. This replaces the generic
 * `owned-read.ts` which only proved containment, not namespace ownership.
 *
 * Domain modules MUST use these resolvers instead of constructing branded
 * paths directly or using generic containment-only helpers.
 */
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import {
  isDecisionRefPath,
  normalizeDecisionRefPath,
} from "../schemas/decision-ref.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import {
  brandOwnedRead,
  brandOwnedWrite,
  brandOwnedDelete,
  type OwnedReadPath,
  type OwnedWritePath,
  type OwnedDeletePath,
} from "./branded-paths-internal.ts";

function codedPathNotOwned(raw: string): Error {
  const err = new Error(`path is not in an owned namespace: ${raw}`);
  (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
  return err;
}

function codedPathOutsideProject(raw: string): Error {
  const err = new Error(`path resolves outside the project root: ${raw}`);
  (err as NodeJS.ErrnoException).code = "PATH_OUTSIDE_PROJECT";
  return err;
}

async function resolveAndBrandRead(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedReadPath> {
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedRead(abs);
  } catch {
    throw codedPathOutsideProject(relPath);
  }
}

async function resolveAndBrandWrite(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedWritePath> {
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedWrite(abs);
  } catch {
    throw codedPathOutsideProject(relPath);
  }
}

async function resolveAndBrandDelete(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedDeletePath> {
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedDelete(abs);
  } catch {
    throw codedPathOutsideProject(relPath);
  }
}

/**
 * Resolve a decision record path for reading. Validates that the path is
 * a valid decision ref under `design/decisions/`.
 */
export async function resolveDecisionReadPath(
  cwd: string,
  raw: string,
): Promise<OwnedReadPath> {
  const canonical = normalizeDecisionRefPath(raw);
  if (canonical === null) {
    throw codedPathNotOwned(raw);
  }
  return resolveAndBrandRead(cwd, canonical, isDecisionRefPath);
}

/**
 * Resolve the decision directory (`design/decisions/`) for listing.
 */
export async function resolveDecisionDirectoryReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, "design/decisions", () => true);
}

/**
 * Resolve a phase file path for reading. Phase paths come from a validated
 * `PhaseRef` and must end with `.yaml`.
 */
export async function resolvePhaseReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p =>
      p.endsWith(".yaml") &&
      (p.startsWith("design/phases/") || p.startsWith("design/")),
  );
}

/**
 * Resolve the roadmap file (`design/roadmap.yaml`) for reading.
 */
export async function resolveRoadmapReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, "design/roadmap.yaml", () => true);
}

/**
 * Resolve the project config file (`.code-pact/project.yaml`) for reading.
 */
export async function resolveProjectConfigReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, ".code-pact/project.yaml", () => true);
}

/**
 * Resolve a model profile path under `.code-pact/model-profiles/` for reading.
 */
export async function resolveModelProfileReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p => p.startsWith(".code-pact/model-profiles/") && p.endsWith(".yaml"),
  );
}

/**
 * Resolve the model profiles directory (`.code-pact/model-profiles/`) for listing.
 */
export async function resolveModelProfileDirectoryReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, ".code-pact/model-profiles", () => true);
}

/**
 * Resolve a progress file path under `.code-pact/state/` for reading.
 */
export async function resolveProgressReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p =>
      p.startsWith(".code-pact/state/") &&
      (p.endsWith(".yaml") || p.endsWith(".yml") || p.endsWith(".json")),
  );
}

/**
 * Resolve `.gitignore` for reading.
 */
export async function resolveGitignoreReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, ".gitignore", () => true);
}

/**
 * Resolve a design instruction file (e.g. `design/constitution.md`,
 * `design/brief.md`) for reading.
 */
export async function resolveInstructionReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p => p.startsWith("design/") && p.endsWith(".md"),
  );
}

/**
 * Resolve a context directory (agent profile's `context_dir`) for listing.
 * The path must be under the project root and must not escape via `..`.
 */
export async function resolveContextDirectoryReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, relPath, () => true);
}

/**
 * Resolve a directory under `design/` or `.code-pact/` for listing.
 * Used by doctor's `.bak` file scanner.
 */
export async function resolveOwnedDirectoryReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p =>
      p === "design" ||
      p === ".code-pact" ||
      p.startsWith("design/") ||
      p.startsWith(".code-pact/"),
  );
}

/**
 * Resolve an agent profile path under `.code-pact/agent-profiles/` for reading.
 */
export async function resolveAgentProfileReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p => p.startsWith(".code-pact/agent-profiles/") && p.endsWith(".yaml"),
  );
}

/**
 * Resolve an adapter static file path for reading.
 */
export async function resolveAdapterStaticReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p => p.startsWith(".code-pact/") || p.startsWith("design/"),
  );
}

/**
 * Resolve any project-relative path for symlink-free reading.
 * This is the generic fallback for diagnostic reads that have already been
 * validated by the caller (e.g. manifest ownership checks). It provides
 * containment and symlink-free resolution but does NOT enforce namespace
 * ownership — callers must ensure the path is safe to read.
 */
export async function resolveContainedReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  if (relPath === ".") {
    return brandOwnedRead(cwd);
  }
  const projectRelative = relPath.startsWith("/")
    ? relPath.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
    : relPath;
  const abs = await resolveSymlinkFreeProjectPath(cwd, projectRelative);
  return brandOwnedRead(abs);
}

// ── Write resolvers ──────────────────────────────────────────────────────

/**
 * Resolve a decision record path for writing. Validates that the path is
 * a valid decision ref under `design/decisions/`.
 */
export async function resolveDecisionWritePath(
  cwd: string,
  raw: string,
): Promise<OwnedWritePath> {
  const canonical = normalizeDecisionRefPath(raw);
  if (canonical === null) {
    throw codedPathNotOwned(raw);
  }
  return resolveAndBrandWrite(cwd, canonical, isDecisionRefPath);
}

/**
 * Resolve a phase file path for writing. Phase paths must end with `.yaml`
 * and be under `design/phases/` or `design/`.
 */
export async function resolvePhaseWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(
    cwd,
    relPath,
    p =>
      p.endsWith(".yaml") &&
      (p.startsWith("design/phases/") || p.startsWith("design/")),
  );
}

/**
 * Resolve the roadmap file (`design/roadmap.yaml`) for writing.
 */
export async function resolveRoadmapWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(cwd, "design/roadmap.yaml", () => true);
}

/**
 * Resolve a progress file path under `.code-pact/state/` for writing.
 */
export async function resolveProgressWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(cwd, relPath, p =>
    p.startsWith(".code-pact/state/"),
  );
}

/**
 * Resolve a progress file path under `.code-pact/state/` for deletion.
 */
export async function resolveProgressDeletePath(
  cwd: string,
  relPath: string,
): Promise<OwnedDeletePath> {
  return resolveAndBrandDelete(cwd, relPath, p =>
    p.startsWith(".code-pact/state/"),
  );
}

/**
 * Resolve a design instruction file (e.g. `design/constitution.md`,
 * `design/brief.md`) for writing.
 */
export async function resolveInstructionWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(
    cwd,
    relPath,
    p => p.startsWith("design/") && p.endsWith(".md"),
  );
}

/**
 * Resolve a model profile path under `.code-pact/model-profiles/` for writing.
 */
export async function resolveModelProfileWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(
    cwd,
    relPath,
    p => p.startsWith(".code-pact/model-profiles/") && p.endsWith(".yaml"),
  );
}

/**
 * Resolve an agent profile path under `.code-pact/agent-profiles/` for writing.
 */
export async function resolveAgentProfileWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(
    cwd,
    relPath,
    p => p.startsWith(".code-pact/agent-profiles/") && p.endsWith(".yaml"),
  );
}

/**
 * Resolve the project config file (`.code-pact/project.yaml`) for writing.
 */
export async function resolveProjectConfigWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(cwd, ".code-pact/project.yaml", () => true);
}

/**
 * Resolve `.gitignore` for writing.
 */
export async function resolveGitignoreWritePath(
  cwd: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(cwd, ".gitignore", () => true);
}

/**
 * Resolve a decision record path for deletion.
 */
export async function resolveDecisionDeletePath(
  cwd: string,
  raw: string,
): Promise<OwnedDeletePath> {
  const canonical = normalizeDecisionRefPath(raw);
  if (canonical === null) {
    throw codedPathNotOwned(raw);
  }
  return resolveAndBrandDelete(cwd, canonical, isDecisionRefPath);
}

/**
 * Resolve a phase file path for deletion.
 */
export async function resolvePhaseDeletePath(
  cwd: string,
  relPath: string,
): Promise<OwnedDeletePath> {
  return resolveAndBrandDelete(
    cwd,
    relPath,
    p =>
      p.endsWith(".yaml") &&
      (p.startsWith("design/phases/") || p.startsWith("design/")),
  );
}

/**
 * Resolve any project-relative path for symlink-free writing.
 * Generic fallback for write operations that have already been validated
 * by the caller. Provides containment and symlink-free resolution but
 * does NOT enforce namespace ownership.
 */
export async function resolveContainedWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  const projectRelative = relPath.startsWith("/")
    ? relPath.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
    : relPath;
  const abs = await resolveSymlinkFreeProjectPath(cwd, projectRelative);
  return brandOwnedWrite(abs);
}

/**
 * Resolve any project-relative path for symlink-free deletion.
 * Generic fallback for delete operations that have already been validated
 * by the caller.
 */
export async function resolveContainedDeletePath(
  cwd: string,
  relPath: string,
): Promise<OwnedDeletePath> {
  const projectRelative = relPath.startsWith("/")
    ? relPath.slice(cwd.endsWith("/") ? cwd.length : cwd.length + 1)
    : relPath;
  const abs = await resolveSymlinkFreeProjectPath(cwd, projectRelative);
  return brandOwnedDelete(abs);
}
