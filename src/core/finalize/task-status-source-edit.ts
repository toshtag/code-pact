import { isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";
import { Phase, type PhaseStatus } from "../schemas/phase.ts";

// ---------------------------------------------------------------------------
// Lossless task-status source edit
//
// Finalization and reconciliation change exactly one thing in a phase YAML:
// the `status` of one task. Everything else in that file — the phase-level
// `evidence:` list, keys the Phase schema does not model, comments, key order,
// block-scalar wrapping, quote style, line endings — is the maintainer's, and
// must survive the write byte-for-byte.
//
// The previous writer parsed the file into the strict `Phase` model and
// serialized that model back. zod object parsing strips unknown keys, so
// everything the schema does not model was silently dropped on every
// `task finalize --write` (issue #560), and the round-trip re-wrapped block
// scalars it did model.
//
// This module never serializes a phase. It locates the target `status` scalar
// in the ORIGINAL source text and replaces that token alone:
//
//   raw phase bytes
//     → YAML parse + Phase validation
//     → locate the one task mapping, then its one `status` scalar
//     → replace that scalar's source range, keeping its quote style
//     → re-parse + re-validate the candidate
//
// Pure: no fs, no atomic write, no error codes, no logging. The caller
// (safe-write.ts) owns path authority and the compare-and-swap write.
// ---------------------------------------------------------------------------

/** The rewritten source plus the byte range in the ORIGINAL source it replaced. */
export type TaskStatusSourceEdit = {
  /** Full phase source with only the target status scalar changed. */
  candidate: string;
  /** Half-open `[start, end)` offsets of the replaced scalar in the input `raw`. */
  changed_range: {
    start: number;
    end: number;
  };
};

export type TaskStatusSourceEditRequest = {
  /** The phase YAML exactly as read from disk. */
  raw: string;
  /** Id of the task whose status is being flipped. */
  taskId: string;
  /** Status the task must currently hold; a mismatch is refused. */
  expectedBefore: PhaseStatus;
  /** Status to write in its place. */
  targetAfter: PhaseStatus;
};

/**
 * Renders `value` in the same scalar style the source used, so a
 * `status: "planned"` stays double-quoted and a bare `status: planned` stays
 * plain. Status values come from a closed enum of plain identifiers, so no
 * escaping is needed inside the quotes.
 */
function renderInSourceStyle(value: PhaseStatus, style: Scalar["type"]): string {
  if (style === "QUOTE_DOUBLE") return `"${value}"`;
  if (style === "QUOTE_SINGLE") return `'${value}'`;
  return value;
}

/**
 * Builds the lossless source edit that flips one task's `status`.
 *
 * Throws — rather than returning a partial result — when the edit cannot be
 * proven to be a single-scalar replacement:
 *   - the source does not parse as YAML, or does not validate as a `Phase`
 *   - the task id is absent, or present more than once
 *   - the task mapping has no `status` key, or has it more than once
 *   - the current status is not `expectedBefore`
 *   - the rewritten source no longer parses, no longer validates, or does not
 *     carry `targetAfter` on the target task
 *
 * The caller treats every throw as a refusal to write: the file on disk is
 * left exactly as it was.
 */
export function buildTaskStatusSourceEdit(
  req: TaskStatusSourceEditRequest,
): TaskStatusSourceEdit {
  const { raw, taskId, expectedBefore, targetAfter } = req;

  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new Error(
      `phase source does not parse as YAML: ${doc.errors[0]!.message}`,
    );
  }
  // Semantic validation up front: a source we would not accept as a Phase is
  // not a source we are willing to rewrite in place.
  Phase.parse(doc.toJS() as unknown);

  const tasks = doc.get("tasks", true);
  if (!isSeq(tasks)) {
    throw new Error(`phase source has no "tasks" sequence`);
  }

  const matches = tasks.items.filter(
    item => isMap(item) && item.get("id") === taskId,
  );
  if (matches.length === 0) {
    throw new Error(`task "${taskId}" not found in phase source`);
  }
  if (matches.length > 1) {
    // A duplicate id makes "the" target task ambiguous. Refusing is the only
    // safe answer: picking either one could flip the wrong task's status.
    throw new Error(
      `task "${taskId}" appears ${matches.length} times in phase source`,
    );
  }

  const target = matches[0]!;
  if (!isMap(target)) {
    throw new Error(`task "${taskId}" is not a mapping in phase source`);
  }

  // Phase validation above already rejects a task without `status`, and a
  // duplicate mapping key is a YAML document error, so neither guard below is
  // reachable through the normal path. They stay because the alternative is
  // taking `statusPairs[0]` on faith: if either upstream check ever loosens,
  // the failure mode is flipping the wrong scalar, not a refusal.
  const statusPairs = target.items.filter(
    pair => isScalar(pair.key) && pair.key.value === "status",
  );
  if (statusPairs.length === 0) {
    throw new Error(`task "${taskId}" has no "status" key in phase source`);
  }
  if (statusPairs.length > 1) {
    throw new Error(
      `task "${taskId}" has ${statusPairs.length} "status" keys in phase source`,
    );
  }

  const statusNode = statusPairs[0]!.value;
  if (!isScalar(statusNode) || statusNode.range == null) {
    throw new Error(
      `task "${taskId}" status is not a locatable scalar in phase source`,
    );
  }
  if (statusNode.value !== expectedBefore) {
    throw new Error(
      `task "${taskId}" status is "${String(statusNode.value)}" in phase source, expected "${expectedBefore}"`,
    );
  }

  // `range` is `[start, valueEnd, nodeEnd]`; `nodeEnd` extends past the scalar
  // over trailing whitespace and any line comment, so only `[start, valueEnd)`
  // is ours to replace.
  const [start, end] = statusNode.range;
  const candidate =
    raw.slice(0, start) +
    renderInSourceStyle(targetAfter, statusNode.type) +
    raw.slice(end);

  assertCandidateIsStatusOnlyEdit({
    raw,
    candidate,
    taskId,
    targetAfter,
    start,
    end,
  });

  return { candidate, changed_range: { start, end } };
}

/**
 * Re-reads the rewritten source as the next reader will. The edit is only
 * accepted when the candidate still parses, still validates as a `Phase`,
 * carries `targetAfter` on the target task, and differs from the original
 * nowhere but inside the replaced range.
 */
function assertCandidateIsStatusOnlyEdit(args: {
  raw: string;
  candidate: string;
  taskId: string;
  targetAfter: PhaseStatus;
  start: number;
  end: number;
}): void {
  const { raw, candidate, taskId, targetAfter, start, end } = args;

  const reparsed = parseDocument(candidate);
  if (reparsed.errors.length > 0) {
    throw new Error(
      `rewritten phase source does not parse as YAML: ${reparsed.errors[0]!.message}`,
    );
  }
  const phase = Phase.parse(reparsed.toJS() as unknown);
  const written = (phase.tasks ?? []).find(t => t.id === taskId);
  if (written?.status !== targetAfter) {
    throw new Error(
      `rewritten phase source does not carry status "${targetAfter}" for task "${taskId}"`,
    );
  }

  // Belt and braces against a future refactor of the slice arithmetic above:
  // everything outside the replaced range must still be the maintainer's bytes.
  const tailStart = candidate.length - (raw.length - end);
  if (
    candidate.slice(0, start) !== raw.slice(0, start) ||
    candidate.slice(tailStart) !== raw.slice(end)
  ) {
    throw new Error(
      `rewritten phase source changed bytes outside the task "${taskId}" status scalar`,
    );
  }
}
