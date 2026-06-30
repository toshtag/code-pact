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
import { isDecisionRefPath, normalizeDecisionRefPath } from "../schemas/decision-ref.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import {
  brandOwnedRead,
  type OwnedReadPath,
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

async function resolveAndBrand(
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
  return resolveAndBrand(cwd, canonical, isDecisionRefPath);
}

/**
 * Resolve the decision directory (`design/decisions/`) for listing.
 */
export async function resolveDecisionDirectoryReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(cwd, "design/decisions", () => true);
}

/**
 * Resolve a phase file path for reading. Phase paths come from a validated
 * `PhaseRef` and must end with `.yaml`.
 */
export async function resolvePhaseReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p.endsWith(".yaml") && (p.startsWith("design/phases/") || p.startsWith("design/")),
  );
}

/**
 * Resolve the roadmap file (`design/roadmap.yaml`) for reading.
 */
export async function resolveRoadmapReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(cwd, "design/roadmap.yaml", () => true);
}

/**
 * Resolve the project config file (`.code-pact/project.yaml`) for reading.
 */
export async function resolveProjectConfigReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(cwd, ".code-pact/project.yaml", () => true);
}

/**
 * Resolve a model profile path under `.code-pact/model-profiles/` for reading.
 */
export async function resolveModelProfileReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p.startsWith(".code-pact/model-profiles/") && p.endsWith(".yaml"),
  );
}

/**
 * Resolve the model profiles directory (`.code-pact/model-profiles/`) for listing.
 */
export async function resolveModelProfileDirectoryReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(cwd, ".code-pact/model-profiles", () => true);
}

/**
 * Resolve a progress file path under `.code-pact/state/` for reading.
 */
export async function resolveProgressReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p.startsWith(".code-pact/state/") && (p.endsWith(".yaml") || p.endsWith(".yml")),
  );
}

/**
 * Resolve `.gitignore` for reading.
 */
export async function resolveGitignoreReadPath(
  cwd: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(cwd, ".gitignore", () => true);
}

/**
 * Resolve a design instruction file (e.g. `design/constitution.md`,
 * `design/brief.md`) for reading.
 */
export async function resolveInstructionReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p.startsWith("design/") && p.endsWith(".md"),
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
  return resolveAndBrand(cwd, relPath, () => true);
}

/**
 * Resolve a directory under `design/` or `.code-pact/` for listing.
 * Used by doctor's `.bak` file scanner.
 */
export async function resolveOwnedDirectoryReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p === "design" || p === ".code-pact" || p.startsWith("design/") || p.startsWith(".code-pact/"),
  );
}

/**
 * Resolve an agent profile path under `.code-pact/agent-profiles/` for reading.
 */
export async function resolveAgentProfileReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p.startsWith(".code-pact/agent-profiles/") && p.endsWith(".yaml"),
  );
}

/**
 * Resolve an adapter static file path for reading.
 */
export async function resolveAdapterStaticReadPath(
  cwd: string,
  relPath: string,
): Promise<OwnedReadPath> {
  return resolveAndBrand(
    cwd,
    relPath,
    (p) => p.startsWith(".code-pact/") || p.startsWith("design/"),
  );
}
