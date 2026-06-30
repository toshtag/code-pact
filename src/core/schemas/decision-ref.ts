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
 *   - under `design/decisions/`, including nested subdirectories.
 *   - ends with `.md`
 *   - never an index (`README.md`) or prune tombstone (`PRUNED.md`) at any
 *     depth — those are not decision records
 *
 * Symlink escape is NOT a lexical concern: it is enforced at READ time by
 * `resolveSymlinkFreeProjectPath` (rejects any symlink component). This validator
 * is the LEXICAL gate; the read seam is the FILESYSTEM gate. Both run — the
 * defense is multi-layer, never schema-only.
 *
 * This is the single source of truth. Every site that accepts or consumes a
 * `decision_refs` value uses it: the Task / phase-import schemas (parse-time
 * hard fail), `task add`, plan lint, the decision gate, the pack loader,
 * context-fit, and the retire/prune/archive fallbacks.
 */
const DECISIONS_PREFIX = "design/decisions/";
const NON_DECISION_BASENAMES = new Set(["readme.md", "pruned.md"]);

const FORBIDDEN_DECISION_SEGMENT = /[\u0000-\u001f\u007f<>:"\\|?*`#]/;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function decisionSegmentReason(segment: string): string {
  if (FORBIDDEN_DECISION_SEGMENT.test(segment)) {
    return "decision path contains a non-portable or markdown-significant character";
  }
  if (segment.endsWith(" ") || segment.endsWith(".")) {
    return "decision path segment must not end in space or dot";
  }
  if (WINDOWS_DEVICE_NAME.test(segment)) {
    return "decision path uses a reserved device name";
  }
  return "";
}

export function normalizeDecisionRefPath(raw: string): string | null {
  const value = raw.replace(/^(?:\.\/)+/, "");
  return decisionRefPathReason(value) === "" ? value : null;
}

/**
 * Returns "" when `value` is a valid decision-ref path, else a human reason.
 * Pure and synchronous — the lexical half of the contract. Shared by the Zod
 * schema, the boolean predicate, and the lint diagnostics so the message and
 * the verdict can never drift.
 *
 * This is the single source of truth for decision path validation. Every site
 * that accepts or consumes a `decision_refs` value uses it: the Task /
 * phase-import schemas (parse-time hard fail), `task add`, plan lint, the
 * decision gate, the pack loader, context-fit, and the retire/prune/archive
 * fallbacks. The PRUNED ledger and archive paths also delegate here — no
 * duplicate character constraints exist elsewhere.
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
  const rest = value.slice(DECISIONS_PREFIX.length);
  if (rest.length === 0) {
    return "decision path must include a filename under design/decisions/";
  }
  const segments = rest.split("/");
  const basename = segments.pop() ?? rest;
  if (NON_DECISION_BASENAMES.has(basename.toLocaleLowerCase("en-US"))) {
    return "README.md / PRUNED.md are never decision records";
  }
  for (const seg of segments) {
    const segReason = decisionSegmentReason(seg);
    if (segReason) return segReason;
  }
  const baseReason = decisionSegmentReason(basename);
  if (baseReason) return baseReason;
  return "";
}

/** Boolean form of {@link decisionRefPathReason} for read-time re-validation. */
export function isDecisionRefPath(value: string): boolean {
  return decisionRefPathReason(value) === "";
}

/** The parse-time schema. Use everywhere a `decision_refs` value is accepted. */
export const DecisionRefPath = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    const reason = decisionRefPathReason(value);
    if (reason !== "") ctx.addIssue({ code: "custom", message: reason });
  });
export type DecisionRefPath = z.infer<typeof DecisionRefPath>;
