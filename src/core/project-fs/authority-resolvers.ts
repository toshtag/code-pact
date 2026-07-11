/**
 * Namespace-specific authority resolvers for filesystem reads.
 *
 * Each resolver validates that a path belongs to a specific owned namespace
 * (e.g. `design/decisions/`, `.code-pact/`, `design/phases/`) before branding
 * it as an {@link OwnedReadPath}. Generic containment-only helpers are not
 * authority: they prove location, not namespace ownership.
 *
 * Domain modules MUST use these resolvers instead of constructing branded
 * paths directly or using generic containment-only helpers.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import {
  isDecisionRefPath,
  normalizeDecisionRefPath,
} from "../schemas/decision-ref.ts";
import { parseEvidenceRef, SHA256_PATTERN } from "../evidence/evidence-ref.ts";
import { isPhasePath } from "../schemas/phase-path.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import {
  brandOwnedRead,
  brandOwnedWrite,
  brandOwnedDelete,
  brandExplicitUserRead,
  brandOwnedList,
  type OwnedReadPath,
  type OwnedWritePath,
  type OwnedDeletePath,
  type ExplicitUserReadPath,
  type OwnedListPath,
} from "./branded-paths-internal.ts";

function codedPathNotOwned(raw: string): Error {
  const err = new Error(`path is not in an owned namespace: ${raw}`);
  (err as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
  return err;
}

function codedFilesystemAuthorityFailure(raw: string, code?: string): Error {
  const err = new Error(
    `filesystem authority resolution failed for "${raw}"${code ? ` (${code})` : ""}`,
  );
  (err as NodeJS.ErrnoException).code = "FS_AUTHORITY_FAILURE";
  return err;
}

async function resolveAndBrandRead(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedReadPath> {
  if (relPath === ".") {
    if (!validate(relPath)) throw codedPathNotOwned(relPath);
    return brandOwnedRead(cwd);
  }
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedRead(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED" || code === "PATH_OUTSIDE_PROJECT") {
      throw error;
    }
    throw codedFilesystemAuthorityFailure(relPath, code);
  }
}

export const resolveAndBrandReadForAuthority = resolveAndBrandRead;

async function resolveAndBrandWrite(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedWritePath> {
  if (relPath === ".") {
    if (!validate(relPath)) throw codedPathNotOwned(relPath);
    return brandOwnedWrite(cwd);
  }
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedWrite(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED" || code === "PATH_OUTSIDE_PROJECT") {
      throw error;
    }
    throw codedFilesystemAuthorityFailure(relPath, code);
  }
}

export const resolveAndBrandWriteForAuthority = resolveAndBrandWrite;

async function resolveAndBrandDelete(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedDeletePath> {
  if (relPath === ".") {
    if (!validate(relPath)) throw codedPathNotOwned(relPath);
    return brandOwnedDelete(cwd);
  }
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedDelete(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED" || code === "PATH_OUTSIDE_PROJECT") {
      throw error;
    }
    throw codedFilesystemAuthorityFailure(relPath, code);
  }
}

export const resolveAndBrandDeleteForAuthority = resolveAndBrandDelete;

async function resolveAndBrandList(
  cwd: string,
  relPath: string,
  validate: (relPath: string) => boolean,
): Promise<OwnedListPath> {
  if (relPath === ".") {
    if (!validate(relPath)) throw codedPathNotOwned(relPath);
    return brandOwnedList(cwd);
  }
  assertSafeRelativePath(relPath);
  if (!validate(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, relPath);
    return brandOwnedList(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED" || code === "PATH_OUTSIDE_PROJECT") {
      throw error;
    }
    throw codedFilesystemAuthorityFailure(relPath, code);
  }
}

export const resolveAndBrandListForAuthority = resolveAndBrandList;

async function resolveAndBrandExplicitUserRead(
  cwd: string,
  relPath: string,
): Promise<ExplicitUserReadPath> {
  let projectRelative: string;
  if (isAbsolute(relPath)) {
    const cwdReal = await realpath(cwd).catch(() => cwd);
    const inputReal = await realpath(relPath).catch(() => resolve(relPath));
    projectRelative = relative(cwdReal, inputReal);
    if (projectRelative.startsWith("..")) {
      const cwdResolved = resolve(cwd);
      projectRelative = relative(cwdResolved, resolve(relPath));
    }
  } else {
    projectRelative = relPath;
  }
  if (projectRelative === ".") {
    return brandExplicitUserRead(cwd);
  }
  assertSafeRelativePath(projectRelative);
  try {
    const abs = await resolveSymlinkFreeProjectPath(cwd, projectRelative);
    return brandExplicitUserRead(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "PATH_NOT_OWNED" || code === "PATH_OUTSIDE_PROJECT") {
      throw error;
    }
    throw codedFilesystemAuthorityFailure(relPath, code);
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
): Promise<OwnedListPath> {
  return resolveAndBrandList(cwd, "design/decisions", () => true);
}

/**
 * Resolve the phases directory (`design/phases/`) for listing.
 */
export async function resolvePhaseDirectoryReadPath(
  cwd: string,
): Promise<OwnedListPath> {
  return resolveAndBrandList(cwd, "design/phases", () => true);
}

/**
 * Resolve a phase file path for reading. Phase paths must be under
 * `design/phases/` and end with `.yaml`.
 */
export async function resolvePhaseReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    isPhasePath,
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
 * Resolve a cached verification evidence artifact for reading. Public callers
 * pass the opaque evidence ref; only the lowercase sha256 digest becomes a
 * filename under the owned cache namespace.
 */
export async function resolveEvidenceReadPath(
  cwd: string,
  ref: string,
): Promise<OwnedReadPath> {
  const digest = parseEvidenceRef(ref);
  return resolveAndBrandRead(
    cwd,
    `.code-pact/cache/evidence/${digest}.json`,
    relPath => relPath === `.code-pact/cache/evidence/${digest}.json`,
  );
}

/**
 * Resolve a cached verification evidence artifact for writing. The digest is
 * structurally validated before it is used as a filename.
 */
export async function resolveEvidenceWritePath(
  cwd: string,
  digest: string,
): Promise<OwnedWritePath> {
  if (!SHA256_PATTERN.test(digest)) {
    throw codedPathNotOwned(digest);
  }
  return resolveAndBrandWrite(
    cwd,
    `.code-pact/cache/evidence/${digest}.json`,
    relPath => relPath === `.code-pact/cache/evidence/${digest}.json`,
  );
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
): Promise<OwnedListPath> {
  return resolveAndBrandList(cwd, ".code-pact/model-profiles", () => true);
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

const INSTRUCTION_PATHS = new Set([
  "design/constitution.md",
  "design/brief.md",
]);

function isInstructionPath(raw: string): boolean {
  return INSTRUCTION_PATHS.has(raw);
}

/**
 * Resolve a design instruction file (`design/constitution.md` or
 * `design/brief.md`) for reading.
 */
export async function resolveInstructionReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  if (!isInstructionPath(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  return resolveAndBrandRead(cwd, relPath, () => true);
}

/**
 * Resolve a context directory (agent profile's `context_dir`) for listing.
 * The path must be under the project root and must not escape via `..`.
 */
export async function resolveContextDirectoryReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedListPath> {
  return resolveAndBrandList(cwd, relPath, () => true);
}

/**
 * Resolve a directory under `design/` or `.code-pact/` for listing.
 * Used by doctor's `.bak` file scanner.
 */
export async function resolveOwnedDirectoryReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedListPath> {
  return resolveAndBrandList(
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
 * Resolve a design rules file (`design/rules/*.md`) for reading.
 */
export async function resolveRulesReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(
    cwd,
    relPath,
    p => p.startsWith("design/rules/") && p.endsWith(".md"),
  );
}

/**
 * Resolve the design rules directory (`design/rules/`) for listing.
 */
export async function resolveRulesDirectoryReadPath(
  cwd: string,
): Promise<OwnedListPath> {
  return resolveAndBrandList(cwd, "design/rules", () => true);
}

/**
 * Resolve the doctor config file (`.code-pact/doctor.yaml`) for reading.
 */
export async function resolveDoctorConfigReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrandRead(cwd, ".code-pact/doctor.yaml", () => true);
}

/**
 * Resolve an explicit user-supplied input path (e.g. `--from-file`) for
 * reading. This grants read access ONLY — the resulting ExplicitUserReadPath
 * cannot be passed to write, delete, or mkdir operations.
 */
export async function resolveExplicitUserReadPath(
  cwd: string,
  relPath: string,
): Promise<ExplicitUserReadPath> {
  return resolveAndBrandExplicitUserRead(cwd, relPath);
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
 * Resolve a phase file path for writing. Phase paths must be under
 * `design/phases/` and end with `.yaml`.
 */
export async function resolvePhaseWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  return resolveAndBrandWrite(
    cwd,
    relPath,
    isPhasePath,
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
 * Resolve a design instruction file (`design/constitution.md` or
 * `design/brief.md`) for writing.
 */
export async function resolveInstructionWritePath(
  cwd: string,
  relPath: string,
): Promise<OwnedWritePath> {
  if (!isInstructionPath(relPath)) {
    throw codedPathNotOwned(relPath);
  }
  return resolveAndBrandWrite(cwd, relPath, () => true);
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
    isPhasePath,
  );
}
