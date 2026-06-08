import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { assertSafeRelativePath } from "../path-safety.ts";

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
 * is re-validated here and confined to `design/decisions/**.md`. This is what
 * stops the ledger from being a licence to silence an arbitrary missing file
 * (a `docs/` page, a `design/phases/*.yaml`, a `../` traversal): only a real
 * decision record can be tombstoned, never `README.md` / `PRUNED.md` itself.
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
  if (NON_DECISION_LEDGER_PATHS.has(normalized)) return null;
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
