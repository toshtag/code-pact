import { z } from "zod";
import { RelativePosixPath } from "./relative-path.ts";

/**
 * The ONE namespace contract for a `decision_refs` / `acceptance_refs` path.
 *
 * A decision reference is a path to an ADR markdown file under
 * `design/decisions/`. WITHOUT this constraint, `decision_refs` was any
 * non-empty string: a value like `.env` passed the schema, was read by the
 * gate (adr.ts), classified "accepted" (no status line → lenient accept),
 * released the `requires_decision` gate, AND was rendered into the
 * agent-facing context pack — an arbitrary-local-file read + gate bypass +
 * secret-into-artifact leak from a single checked-in phase YAML field.
 *
 * Contract (CVE class: arbitrary local file read via decision_refs):
 *   - project-relative POSIX (RelativePosixPath rejects absolute, `..`,
 *     `.`, empty segments, backslash, drive letters)
 *   - under `design/decisions/` (any depth — nested ADRs like
 *     `design/decisions/2026/ADR-001.md` are supported, matching the gate
 *     and `normalizeDecisionRef`)
 *   - ends with `.md`
 *   - never the index (`README.md`) or the prune tombstone (`PRUNED.md`),
 *     at ANY depth — those are not decision records
 *
 * Symlink escape is NOT a lexical concern: it is enforced at READ time by
 * `resolveOwnedProjectPath` (rejects any symlink component). This validator
 * is the LEXICAL gate; the read seam is the FILESYSTEM gate. Both run — the
 * defense is multi-layer, never schema-only.
 *
 * This is the single source of truth. Every site that accepts or consumes a
 * `decision_refs` value uses it: the Task / phase-import schemas (parse-time
 * hard fail), `task add`, plan lint, the decision gate, the pack loader,
 * context-fit, and the retire/prune/archive fallbacks.
 */
const DECISIONS_PREFIX = "design/decisions/";
const NON_DECISION_BASENAMES = new Set(["README.md", "PRUNED.md"]);

/**
 * Returns "" when `value` is a valid decision-ref path, else a human reason.
 * Pure and synchronous — the lexical half of the contract. Shared by the Zod
 * schema, the boolean predicate, and the lint diagnostics so the message and
 * the verdict can never drift.
 */
export function decisionRefPathReason(value: string): string {
  const relative = RelativePosixPath.safeParse(value);
  if (!relative.success) {
    return relative.error.issues[0]?.message ?? "invalid relative POSIX path";
  }
  if (!value.startsWith(DECISIONS_PREFIX)) {
    return "decision path must be under design/decisions/";
  }
  if (!value.endsWith(".md")) {
    return "decision path must end with .md";
  }
  const basename = value.split("/").pop() ?? "";
  if (NON_DECISION_BASENAMES.has(basename)) {
    return "README.md / PRUNED.md are never decision records";
  }
  return "";
}

/** Boolean form of {@link decisionRefPathReason} for read-time re-validation. */
export function isDecisionRefPath(value: string): boolean {
  return decisionRefPathReason(value) === "";
}

/** The parse-time schema. Use everywhere a `decision_refs` value is accepted. */
export const DecisionRefPath = z.string().min(1).superRefine((value, ctx) => {
  const reason = decisionRefPathReason(value);
  if (reason !== "") ctx.addIssue({ code: "custom", message: reason });
});
export type DecisionRefPath = z.infer<typeof DecisionRefPath>;
