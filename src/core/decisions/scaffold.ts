import { atomicCreateTextExclusive } from "../../io/atomic-text.ts";
import { assertSafeRelativePath } from "../path-safety.ts";
import { resolveDecisionWritePath } from "../project-fs/authority-resolvers.ts";
import { PLAN_ID_PATTERN } from "../schemas/plan-id.ts";
import { normalizeDecisionRefPath } from "../schemas/decision-ref.ts";

// ---------------------------------------------------------------------------
// Proposed-ADR stub scaffolding
//
// Generates `**Status:** proposed` ADR stubs for requires_decision tasks that
// have no decision yet, so an imported roadmap arrives with the decision
// work-surfaces already in place. A proposed stub is classified `blocked` by
// the status-aware gate and does NOT resolve — flipping it to
// `accepted` is the human act that releases the gate. Opt-in only.
// ---------------------------------------------------------------------------

const DECISIONS_DIR = "design/decisions/";

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

/** True when `relPath` lives under `design/decisions/`. */
export function isUnderDecisionsDir(relPath: string): boolean {
  return toPosix(relPath).startsWith(DECISIONS_DIR);
}

/**
 * Throws CONFIG_ERROR if `taskId` is not safe as a single filename segment.
 * `assertSafeRelativePath` alone is insufficient: `P1/T1` is a valid relative
 * path but an invalid filename segment, and would otherwise produce a nested
 * `design/decisions/P1/T1.md` from a task id. Conservative allowlist — the
 * same {@link PLAN_ID_PATTERN} the Task/Phase schemas enforce at parse time,
 * applied here as runtime defense-in-depth at the filesystem boundary.
 */
export function assertSafeDecisionFilenameSegment(taskId: string): void {
  if (
    taskId.length === 0 ||
    taskId === "." ||
    taskId === ".." ||
    !PLAN_ID_PATTERN.test(taskId)
  ) {
    const err = new Error(
      `Task id "${taskId}" is not a safe filename segment for an ADR stub (allowed: letters, digits, "._-").`,
    );
    (err as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw err;
  }
}

/** The default stub path for a task with no `decision_refs`. */
export function defaultStubRelPath(taskId: string): string {
  return `${DECISIONS_DIR}${taskId}.md`;
}

/**
 * The scaffold targets for a gated task: its explicit `decision_refs` when
 * present (the all-must-be-accepted contract), otherwise the default
 * `design/decisions/<task-id>.md`.
 */
export function scaffoldTargetsForTask(
  taskId: string,
  decisionRefs?: string[],
): string[] {
  return decisionRefs && decisionRefs.length > 0
    ? [...decisionRefs]
    : [defaultStubRelPath(taskId)];
}

/** The English-locked stub body. Non-empty, with `**Status:** proposed` so the
 *  gate classifies it `blocked` until a human flips it to `accepted`. */
export function proposedAdrStub(label: string): string {
  return (
    [
      `# Decision: ${label}`,
      "",
      "**Status:** proposed",
      "",
      "> Scaffolded by `code-pact … --scaffold-decisions`. Flip **Status** to `accepted`",
      "> once the decision is settled — that is what releases the verify / record-done gate.",
      "",
      "## Context",
      "",
      "<why this decision is needed>",
      "",
      "## Decision",
      "",
      "<what was decided>",
      "",
      "## Consequences",
      "",
      "<trade-offs / follow-ups>",
    ].join("\n") + "\n"
  );
}

/**
 * Writes a `proposed` ADR stub at `relPath` unless it already exists. Defends
 * its own write boundary — does NOT trust the caller: structural safety
 * (`assertSafeRelativePath`), under-`design/decisions/` containment, and
 * owned-path resolution (`resolveSymlinkFreeProjectPath`). Never overwrites an existing file.
 * Returns whether it wrote (`"created"`) or found one already present
 * (`"exists"`).
 */
export async function writeProposedAdrIfAbsent(
  cwd: string,
  relPath: string,
  label: string,
): Promise<"created" | "exists"> {
  assertSafeRelativePath(relPath);
  const normalized = normalizeDecisionRefPath(relPath);
  if (normalized === null) {
    throw new Error(
      `Refusing to scaffold "${relPath}": ADR stubs must be decision records under ${DECISIONS_DIR}`,
    );
  }
  const abs = await resolveDecisionWritePath(cwd, normalized);
  try {
    await atomicCreateTextExclusive(abs, proposedAdrStub(label));
    return "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return "exists";
    }
    throw err;
  }
}
