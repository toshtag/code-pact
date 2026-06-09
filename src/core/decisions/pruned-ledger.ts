import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { assertSafeRelativePath, resolveWithinProject } from "../path-safety.ts";
import { atomicWriteText } from "../../io/atomic-text.ts";

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

/** README / the ledger itself are never decisions, so never pruned-decision entries. */
const NON_DECISION_LEDGER_PATHS = new Set([
  "design/decisions/README.md",
  "design/decisions/PRUNED.md",
]);

/**
 * Constrain a raw `PRUNED.md` entry to a *pruned decision path*, returning its
 * normalized form or `null` to reject it. `PRUNED.md` is user-editable, so —
 * unlike a `decision_refs` value, which is validated upstream — a ledger entry
 * is re-validated here and confined to a **top-level** `design/decisions/*.md`
 * record. This is what stops the ledger from being a licence to silence an
 * arbitrary missing file (a `docs/` page, a `design/phases/*.yaml`, a `../`
 * traversal, a nested ADR): only a real top-level decision record can be
 * tombstoned, never `README.md` / `PRUNED.md` itself.
 */
export function normalizePrunedDecisionPath(raw: string): string | null {
  const fwd = raw.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  try {
    assertSafeRelativePath(fwd); // reject traversal / absolute / drive paths
  } catch {
    return null;
  }
  const normalized = posix.normalize(fwd).replace(/^(?:\.\/)+/, "");
  if (!normalized.startsWith("design/decisions/")) return null;
  if (!normalized.endsWith(".md")) return null;
  // Reject characters that cannot survive the ledger's markdown-table / code-span
  // round-trip: a pipe ends a cell, a backtick ends the path code span, and a
  // CR/LF ends the row. Such a path could never be parsed back by
  // `readPrunedLedger`, so it is not a valid ledger entry (nor a prune target).
  if (/[\r\n|`]/.test(normalized)) return null;
  if (NON_DECISION_LEDGER_PATHS.has(normalized)) return null;
  // Top-level records only. A nested ADR (`design/decisions/x/y.md`) is not a
  // prune target: the gate scan that protects pruning is a flat top-level scan,
  // so allowing nested here would let a nested dependant slip past it. Nested
  // support is a deliberate future extension, not a silent gap.
  if (normalized.slice("design/decisions/".length).includes("/")) return null;
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
/** Parse the SET of normalized pruned-decision paths from ledger text. */
export function parsePrunedLedger(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = TABLE_ROW.exec(line);
    if (!m) continue;
    const first = m[1]!.split("|")[0]!.trim();
    // Skip the header ("Decision") and the `---` separator row.
    if (first === "" || /^:?-{2,}:?$/.test(first) || first.toLowerCase() === "decision") {
      continue;
    }
    const raw = extractPath(first);
    if (!raw) continue;
    const path = normalizePrunedDecisionPath(raw);
    if (path) out.add(path); // entries outside design/decisions/**.md are ignored
  }
  return out;
}

export async function readPrunedLedger(cwd: string): Promise<Set<string>> {
  let text: string;
  try {
    text = await readFile(join(cwd, "design", "decisions", "PRUNED.md"), "utf8");
  } catch {
    // Any read failure (absent ENOENT, EACCES, EISDIR) → empty set. This is the
    // fail-CLOSED direction: an unreadable ledger silences nothing, so a genuinely
    // pruned ref simply warns again rather than a broken ledger silencing refs it
    // never listed. Swallowing is therefore safe here, not a hidden hazard.
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
  const path = normalizePrunedDecisionPath(row.decision) ?? row.decision;
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
  /** The exact bytes read at prepare time — for a write-time drift check (`""` when absent). */
  existing_content: string;
  /**
   * `true` when the decision is ALREADY recorded in the ledger — appending again
   * would duplicate the tombstone, so the caller should skip the write. Makes a
   * retry after a partial-failure prune idempotent on the ledger.
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
  const ledger_path = await resolveWithinProject(cwd, "design/decisions/PRUNED.md");
  let existing = "";
  try {
    existing = await readFile(ledger_path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existing = "";
  }
  const line = serializePrunedRow(row);
  const normalized = normalizePrunedDecisionPath(row.decision);
  const already_recorded = normalized !== null && parsePrunedLedger(existing).has(normalized);
  // Idempotent on retry: if this decision is already recorded, do not append a
  // duplicate tombstone — leave the ledger byte-identical.
  const content = already_recorded
    ? existing
    : existing.trim() === ""
      ? `${LEDGER_HEADER}${line}\n`
      : existing.endsWith("\n")
        ? `${existing}${line}\n`
        : `${existing}\n${line}\n`;
  return { ledger_path, content, row: line, existing_content: existing, already_recorded };
}

/**
 * Append a row to `design/decisions/PRUNED.md`, creating the file with its
 * header when absent. Append-only and idempotent: an existing ledger is only
 * extended, and a decision already recorded is not duplicated. Goes through the
 * shared {@link atomicWriteText} primitive (temp + rename), symlink-escape guarded.
 */
export async function appendPrunedLedger(cwd: string, row: PrunedLedgerRow): Promise<void> {
  const prepared = await buildAppendedLedger(cwd, row);
  if (prepared.already_recorded) return; // no duplicate tombstone
  await atomicWriteText(prepared.ledger_path, prepared.content);
}
