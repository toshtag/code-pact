import { readRegularOwnedText } from "../project-fs/raw-internal.ts";
import { posix } from "node:path";
import {
  assertSafeRelativePath,
  resolveSymlinkFreeProjectPath,
} from "../path-safety.ts";
import { normalizeDecisionRefPath } from "../schemas/decision-ref.ts";

/**
 * Normalize a repo-relative path so a ledger entry and a `decision_refs` value
 * compare equal regardless of `./` prefixes or slash style. Used on the REF
 * side, which is already safety-checked upstream — this only canonicalizes
 * shape. (The ledger side goes through {@link normalizePrunedDecisionPath},
 * which additionally re-validates and constrains.)
 */
export function normalizeRelPath(p: string): string {
  const fwd = p.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return posix.normalize(fwd).replace(/^(?:\.\/)+/, "");
}

/**
 * Constrain a raw `PRUNED.md` entry to a *pruned decision path*, returning its
 * normalized form or `null` to reject it. `PRUNED.md` is user-editable, so —
 * unlike a `decision_refs` value, which is validated upstream — a ledger entry
 * is re-validated here and confined to nested `.md` records under `design/decisions/`
 * record. This is what stops the ledger from being a licence to silence an
 * arbitrary missing file (a `docs/` page, a `design/phases/*.yaml`, or a `../`
 * traversal): only a decision record can be
 * tombstoned, never `README.md` / `PRUNED.md` itself.
 */
export function normalizePrunedDecisionPath(raw: string): string | null {
  const fwd = raw.replace(/^(?:\.\/)+/, "");
  try {
    assertSafeRelativePath(fwd); // reject traversal / absolute / drive paths
  } catch {
    return null;
  }
  const normalized = posix.normalize(fwd).replace(/^(?:\.\/)+/, "");
  // Delegate to the single source of truth in decision-ref.ts. All forbidden
  // characters (including pipe, backtick, CR/LF, hash, control chars, etc.)
  // are rejected there — no duplicate constraints here.
  if (normalizeDecisionRefPath(normalized) === null) return null;
  return normalized;
}

const TABLE_ROW = /^\s*\|(.+)\|\s*$/;

/** The first table cell of a row holds the retired decision path. */
function extractPath(cell: string): string | null {
  const code = /`([^`]+)`/.exec(cell); // `path`
  if (code) return code[1]!.trim();
  const link = /\]\(([^)]+)\)/.exec(cell); // [text](path)
  if (link) return link[1]!.trim();
  const bare = cell.trim();
  return bare.endsWith(".md") ? bare : null;
}

/**
 * Read `design/decisions/PRUNED.md` — the append-only ledger of decision records
 * retired by `decision prune` — and return the SET of normalized decision paths
 * it records. Absent file → empty set. The first table column carries the path
 * (a `code span` or a `[text](link)`); header / separator / malformed rows are
 * skipped; duplicates collapse.
 *
 * The ledger is deliberately NOT a blanket silencer. It only carries paths a
 * prune intentionally removed; the caller must still confirm the target is
 * actually missing AND the referencing task is `done` before silencing — a
 * present file, or a live task, is never silenced by a ledger entry alone.
 */
/** Is `line` a data row of the ledger table? Returns its normalized decision path, or null. */
function rowDecisionPath(line: string): string | null {
  const m = TABLE_ROW.exec(line);
  if (!m) return null;
  const first = m[1]!.split("|")[0]!.trim();
  // Skip the header ("Decision") and the `---` separator row.
  if (
    first === "" ||
    /^:?-{2,}:?$/.test(first) ||
    first.toLowerCase() === "decision"
  )
    return null;
  const raw = extractPath(first);
  if (!raw) return null;
  return normalizePrunedDecisionPath(raw); // null for entries outside design/decisions/**.md
}

/** Parse the SET of normalized pruned-decision paths from ledger text. */
export function parsePrunedLedger(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const path = rowDecisionPath(line);
    if (path) out.add(path);
  }
  return out;
}

/** The FIRST raw ledger row line that records `normalizedDecision`, or null. */
export function findPrunedRow(
  text: string,
  normalizedDecision: string,
): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (rowDecisionPath(line) === normalizedDecision) return line;
  }
  return null;
}

export async function readPrunedLedger(cwd: string): Promise<Set<string>> {
  let text: string;
  try {
    // Route through the symlink-escape guard: this set SILENCES missing-decision_ref
    // integrity warnings, so it must never trust a PRUNED.md that resolves outside
    // the repo. A resolve escape throws and lands in the fail-closed branch below.
    const path = await resolveSymlinkFreeProjectPath(
      cwd,
      "design/decisions/PRUNED.md",
    );
    text = await readRegularOwnedText(path);
  } catch {
    // Any failure (escape, absent ENOENT, EACCES, EISDIR) → empty set. This is the
    // fail-CLOSED direction: an unreadable/untrusted ledger silences nothing, so a
    // genuinely pruned ref simply warns again rather than a broken ledger silencing
    // refs it never listed. Swallowing is therefore safe here, not a hidden hazard.
    return new Set();
  }
  const out = parsePrunedLedger(text);
  return out;
}

/** A pruned-decision ledger row, as `decision prune --write` records it. */
export type PrunedLedgerRow = {
  /** The retired decision path — written as a CODE SPAN, never a link. */
  decision: string;
  /** The task(s) that referenced it (joined ids), or a dash when none. */
  phase_task: string;
  /** YYYY-MM-DD (the executor formats this from an injected clock). */
  pruned_date: string;
  /** Where the rationale now lives — e.g. "git history" / "CHANGELOG vX.Y". */
  rationale_home: string;
};

/**
 * The header written when `PRUNED.md` is first created. The path column is the
 * one {@link readPrunedLedger} parses; the "Decision" header cell and the `---`
 * separator are both skipped by it, and the intro prose carries no leading
 * pipe so it is not mistaken for a row.
 */
const LEDGER_HEADER = `# Pruned decisions

Append-only ledger of decision records retired by \`code-pact decision prune\`.
The full text of each pruned record remains in git history.

| Decision | Phase / Task | Pruned | Rationale home |
| --- | --- | --- | --- |
`;

/** Escape a value so it cannot break out of its markdown table cell. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Render one ledger row. The decision path is a **code span** (`` `path` ``),
 * NOT a markdown link: the record is being deleted, so a link would be a broken
 * reference the moment the row is written. {@link readPrunedLedger} reads the
 * code-span form back as the pruned path.
 */
export function serializePrunedRow(row: PrunedLedgerRow): string {
  const path = normalizePrunedDecisionPath(row.decision);
  if (path === null) {
    const error = new Error(
      `invalid pruned decision path: ${JSON.stringify(row.decision)}`,
    );
    (error as NodeJS.ErrnoException).code = "INVALID_PRUNED_DECISION_PATH";
    throw error;
  }
  return `| \`${path}\` | ${cell(row.phase_task)} | ${cell(row.pruned_date)} | ${cell(row.rationale_home)} |`;
}

/** The next full content of the ledger after appending `row` — computed, not written. */
export type PreparedLedger = {
  /** Absolute, symlink-escape-guarded path of `design/decisions/PRUNED.md`. */
  ledger_path: string;
  /** The complete file content to write (header + existing rows + the new row). */
  content: string;
  /** The serialized new row (for the result envelope). */
  row: string;
  /** The normalized decision path this row records (for a commit-time presence check), or null if unprunable. */
  normalized_decision: string | null;
  /** Did `PRUNED.md` exist at prepare time? Distinguishes "absent" from "present but empty". */
  existed: boolean;
  /** The exact bytes read at prepare time — for a write-time drift check (`""` when absent). */
  existing_content: string;
  /**
   * `true` when the decision is ALREADY recorded in the ledger — appending again
   * would duplicate the tombstone, so the caller should skip the append (but must
   * still verify the row is present at commit time). Makes a retry after a
   * partial-failure prune idempotent on the ledger.
   */
  already_recorded: boolean;
};

/**
 * Read the existing ledger and compute the content it would have after
 * appending `row` — **without writing anything**. This is the fallible read
 * step (it can surface an unreadable/EISDIR ledger) factored out so a caller
 * can run it as a preflight, before any irreversible mutation, and only commit
 * the write once the rest of the operation is known to be safe.
 *
 * Only a genuinely ABSENT ledger (ENOENT) is created fresh; any other read
 * error is rethrown — treating an unreadable-but-present ledger as empty would
 * overwrite every prior append-only row.
 */
export async function buildAppendedLedger(
  cwd: string,
  row: PrunedLedgerRow,
): Promise<PreparedLedger> {
  const ledger_path = await resolveSymlinkFreeProjectPath(
    cwd,
    "design/decisions/PRUNED.md",
  );
  let existing = "";
  let existed = true;
  try {
    existing = await readRegularOwnedText(ledger_path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = "";
    existed = false;
  }
  const newLine = serializePrunedRow(row);
  const normalized = normalizePrunedDecisionPath(row.decision);
  const existingRow =
    normalized !== null ? findPrunedRow(existing, normalized) : null;
  const already_recorded = existingRow !== null;
  // Idempotent on retry: if this decision is already recorded, do not append a
  // duplicate tombstone — leave the ledger byte-identical.
  const content = already_recorded
    ? existing
    : existing.trim() === ""
      ? `${LEDGER_HEADER}${newLine}\n`
      : existing.endsWith("\n")
        ? `${existing}${newLine}\n`
        : `${existing}\n${newLine}\n`;
  return {
    ledger_path,
    content,
    // Report the row that reflects reality: the EXISTING row on an idempotent
    // retry (not the freshly-generated one), else the row just appended.
    row: already_recorded ? existingRow!.trim() : newLine,
    normalized_decision: normalized,
    existed,
    existing_content: existing,
    already_recorded,
  };
}
