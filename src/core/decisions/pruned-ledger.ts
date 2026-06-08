import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * Normalize a repo-relative path so a ledger entry and a `decision_refs` /
 * `acceptance_refs` value compare equal regardless of `./` prefixes or slash
 * style. Refs are already safety-checked for traversal before this is reached,
 * so this only canonicalizes shape — it does not re-validate safety.
 */
export function normalizeRelPath(p: string): string {
  const fwd = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return posix.normalize(fwd).replace(/^\.\//, "");
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
    const path = extractPath(first);
    if (path) out.add(normalizeRelPath(path));
  }
  return out;
}
