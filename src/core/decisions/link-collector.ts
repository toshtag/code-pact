import { readFile, readdir } from "node:fs/promises";
import { posix } from "node:path";
import { resolveWithinProject } from "../path-safety.ts";

/**
 * One inbound reference considered by the prune write plan. `rewrite_action`
 * decides what `--write` (PR-C2) does — `tombstone` (a README decision-index
 * row) or `delink` (a body link). Carries everything the executor needs to act
 * on the exact span WITHOUT re-parsing: `column` + `raw_link` disambiguate two
 * links on one line, and `link_text` is what `delink` keeps. The dry-run preview
 * and `--write` consume the same items. Deliberately NOT the conservative
 * eligibility parser (`decisionLinksTo`).
 */
export type LinkRewriteItem = {
  source_file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column where the link starts. */
  column: number;
  /** The full matched link text, e.g. `[A](../x.md "t")`. */
  raw_link: string;
  /** The destination token only (preserves `<…>`, excludes any title). */
  raw_href: string;
  /** The visible text — what `delink` keeps. */
  link_text: string;
  normalized_target: string;
  link_kind: "inline" | "index_row";
  rewrite_action: "tombstone" | "delink";
};

/** An inbound reference (or a discovery failure) prune cannot safely plan — fail-closed. */
export type LinkScanIssue = {
  source_file: string;
  line: number | null;
  reason: "unreadable" | "unsupported_reference_style" | "protected_ledger";
};

export type InboundLinkScan = { items: LinkRewriteItem[]; issues: LinkScanIssue[] };

// EXTERNAL_RE / FENCE_RE / INLINE_CODE_RE are byte-identical to
// scripts/check-doc-links.mjs so the collector strips code and rejects external
// URLs the same way the checker does. The inline link grammar (`INLINE` below)
// is deliberately a SUPERSET of the checker's `LINK_RE`: it also matches
// `<href>`, single-quoted, and parenthesized-title links. That is safe — every
// link the checker treats as real is also found here, so each one the checker
// would flag broken after C2 deletes the target is already in the plan; the
// extra forms just mean we also clean up valid links the checker happens to
// miss. Parity of the shared rules is locked by the tests in
// link-collector.test.ts. (A shared module is the eventual home; the checker
// runs under plain `node` today and can't import a `.ts`.)
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[^\n]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const INLINE =
  /\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

/** The append-only prune ledger — `--write` may only APPEND to it, never rewrite its rows. */
const LEDGER = "design/decisions/PRUNED.md";

/** Skipped during the walk — matches scripts/check-doc-links.mjs. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

// Blank a span to spaces, preserving newlines so line/column offsets are exact.
const blank = (m: string): string => m.replace(/[^\n]/g, " ");
/** Blank fenced code blocks AND inline code spans (identical to check-doc-links). */
function stripCode(text: string): string {
  return text.replace(FENCE_RE, blank).replace(INLINE_CODE_RE, blank);
}

function stripAngleBrackets(raw: string): string {
  const s = raw.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

/** Resolve a link destination relative to its source file's directory. */
function resolveFrom(sourceFile: string, href: string): string {
  const dest = stripAngleBrackets(href).split("#")[0]!.trim();
  if (dest === "" || EXTERNAL_RE.test(dest)) return ""; // empty / external / protocol-relative
  return posix.normalize(posix.join(posix.dirname(sourceFile), dest)).replace(/^(?:\.\/)+/, "");
}

const ROOTS: { rel: string; recursive: boolean; exts: string[] }[] = [
  { rel: ".", recursive: false, exts: [".md"] },
  { rel: "docs", recursive: true, exts: [".md"] },
  { rel: "design", recursive: true, exts: [".md"] },
  { rel: ".github", recursive: true, exts: [".md", ".yml"] },
];

/**
 * STRICT walk of the source surface. Unlike the best-effort `walkAndMatch`, an
 * unreadable EXISTING directory (or one that symlink-escapes the repo) is not
 * silently skipped — it becomes an `unreadable` issue so the plan can fail
 * closed. A genuinely absent root (ENOENT) is fine.
 */
async function discoverSources(cwd: string): Promise<{ files: string[]; issues: LinkScanIssue[] }> {
  const files = new Set<string>();
  const issues: LinkScanIssue[] = [];

  async function walk(rel: string, recursive: boolean, exts: string[]): Promise<void> {
    let abs: string;
    if (rel === ".") {
      abs = cwd; // the project root itself is trusted
    } else {
      try {
        abs = await resolveWithinProject(cwd, rel); // symlink-escape guard
      } catch {
        issues.push({ source_file: rel, line: null, reason: "unreadable" });
        return;
      }
    }
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // absent root/subdir is fine
      issues.push({ source_file: rel === "." ? "." : rel, line: null, reason: "unreadable" });
      return;
    }
    for (const e of entries) {
      const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue; // node_modules / .git / dist — as check-doc-links
        if (recursive) await walk(childRel, true, exts);
      } else if (e.isFile()) {
        if (childRel === "CHANGELOG.md") continue; // durable record, never rewritten
        if (exts.some((x) => childRel.endsWith(x))) files.add(childRel);
      }
    }
  }

  for (const r of ROOTS) await walk(r.rel, r.recursive, r.exts);
  return { files: [...files], issues };
}

/**
 * Collect every inbound reference to `target` across the doc surface, with the
 * action `--write` would take: a `README.md` decision-index row → `tombstone`;
 * an inline body link → `delink`. Links inside fenced code blocks, inline code,
 * and image embeds (`![]()`) are EXCLUDED (blanked by the shared `stripCode`,
 * exactly as check-doc-links ignores them) — they are examples, not live
 * references, and rewriting them would corrupt rather than fix. A reference-style
 * link outside code is unsupported (a fail-closed issue, since check-doc-links
 * does not resolve it either but the executor can't safely delink it); a real
 * markdown link to the target inside the append-only `PRUNED.md` ledger is a
 * fail-closed `protected_ledger` issue; an unreadable source file/dir is an
 * issue too.
 */
export async function collectInboundLinks(
  cwd: string,
  target: string,
): Promise<InboundLinkScan> {
  const { files, issues } = await discoverSources(cwd);
  const items: LinkRewriteItem[] = [];

  for (const rel of files.sort()) {
    if (rel === target) continue; // the file being pruned itself
    let content: string;
    try {
      const abs = await resolveWithinProject(cwd, rel); // symlink-escape guard
      content = await readFile(abs, "utf8");
    } catch {
      issues.push({ source_file: rel, line: null, reason: "unreadable" });
      continue;
    }

    const isLedger = rel === LEDGER;
    const origLines = content.split(/\r?\n/);
    const strippedLines = stripCode(content).split(/\r?\n/); // fences + inline code → spaces (length preserved)

    for (let i = 0; i < strippedLines.length; i++) {
      const sLine = strippedLines[i]!;
      const oLine = origLines[i] ?? "";

      // Reference-style definition (on the code-stripped line, so a fenced
      // example def never matches).
      const ref = REF_DEF.exec(sLine);
      if (ref && resolveFrom(rel, ref[1]!) === target) {
        issues.push({
          source_file: rel,
          line: i + 1,
          reason: isLedger ? "protected_ledger" : "unsupported_reference_style",
        });
        continue;
      }

      INLINE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INLINE.exec(sLine)) !== null) {
        const start = m.index;
        if (start > 0 && sLine[start - 1] === "!") continue; // image embed — never rewritten
        if (resolveFrom(rel, m[2]!) !== target) continue;
        if (isLedger) {
          // The ledger is append-only — never delink/rewrite an existing row.
          issues.push({ source_file: rel, line: i + 1, reason: "protected_ledger" });
          continue;
        }
        const isIndexRow = rel === "design/decisions/README.md" && /^\s*\|/.test(oLine);
        items.push({
          source_file: rel,
          line: i + 1,
          column: start + 1,
          // From the ORIGINAL line (same length as the blanked one), so an
          // inline-code label like "use `foo`" is preserved, not blanked.
          raw_link: oLine.slice(start, start + m[0].length),
          raw_href: m[2]!,
          link_text: oLine.slice(start + 1, start + 1 + m[1]!.length),
          normalized_target: target,
          link_kind: isIndexRow ? "index_row" : "inline",
          rewrite_action: isIndexRow ? "tombstone" : "delink",
        });
      }
    }
  }

  items.sort((a, b) =>
    a.source_file !== b.source_file
      ? a.source_file < b.source_file
        ? -1
        : 1
      : a.line !== b.line
        ? a.line - b.line
        : a.column - b.column,
  );
  issues.sort((a, b) =>
    a.source_file !== b.source_file ? (a.source_file < b.source_file ? -1 : 1) : (a.line ?? 0) - (b.line ?? 0),
  );
  return { items, issues };
}
