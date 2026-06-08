import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { walkAndMatch } from "../glob.ts";

/**
 * One inbound reference to a pruned decision that `--write` (PR-C2) will rewrite,
 * carrying everything the executor needs to act on the exact span WITHOUT
 * re-parsing: `column` + `raw_link` disambiguate two links on one line, and
 * `link_text` is what `delink` keeps. This is the shared rewrite plan — the
 * dry-run preview and `--write` consume the same items. Deliberately NOT the
 * conservative eligibility parser (`decisionLinksTo`).
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
  rewrite_action: "tombstone" | "delink" | "leave_as_is";
};

/** An inbound reference prune cannot safely plan a rewrite for — fail-closed. */
export type LinkScanIssue = {
  source_file: string;
  line: number | null;
  reason: "unreadable" | "unsupported_reference_style";
};

export type InboundLinkScan = { items: LinkRewriteItem[]; issues: LinkScanIssue[] };

// Capture: 1 = visible text, 2 = destination token. Mirrors check-doc-links'
// inline grammar; an optional "title" / 'title' / (title) is matched but NOT
// captured into the href.
const INLINE =
  /\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const FENCE = /^\s*(```+|~~~+)/;

function stripAngleBrackets(raw: string): string {
  const s = raw.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

/** Blank `…` inline-code spans with same-length spaces so links inside code are
 *  not matched, while columns of links OUTSIDE code stay exact. */
function blankInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

/** Resolve a link destination relative to its source file's directory. */
function resolveFrom(sourceFile: string, href: string): string {
  const dest = stripAngleBrackets(href).split("#")[0]!.trim();
  if (dest === "" || /^[a-z]+:\/\//i.test(dest)) return ""; // empty / absolute URL
  return posix.normalize(posix.join(posix.dirname(sourceFile), dest)).replace(/^(?:\.\/)+/, "");
}

/** The exact source surface `check:doc-links` validates. */
async function linkSurfaceFiles(cwd: string): Promise<string[]> {
  const md = await walkAndMatch(cwd, "**/*.md");
  const yml = [
    ...(await walkAndMatch(cwd, "**/*.yml")),
    ...(await walkAndMatch(cwd, "**/*.yaml")),
  ];
  const out: string[] = [];
  for (const rel of md) {
    if (rel === "CHANGELOG.md") continue; // durable authored record — never rewritten (excluded by check-doc-links too)
    if (!rel.includes("/") || rel.startsWith("docs/") || rel.startsWith("design/") || rel.startsWith(".github/")) {
      out.push(rel);
    }
  }
  for (const rel of yml) if (rel.startsWith(".github/")) out.push(rel);
  return out.sort();
}

/**
 * Collect every inbound reference to `target` across the doc surface, with the
 * action `--write` would take: a `README.md` decision-index row → `tombstone`;
 * an inline body link → `delink`; a link inside a fenced code block →
 * `leave_as_is`. **Excludes** image embeds (`![]()`) and inline-code links (both
 * excluded by check-doc-links — rewriting them would corrupt, not fix). A
 * reference-style link (`[t][label]` + `[label]: …`) cannot be rewritten by the
 * span-local executor without also touching its usages, so it is returned as an
 * `issue`, not an item; an unreadable source file is likewise an `issue`. The
 * caller fails CLOSED on any issue.
 */
export async function collectInboundLinks(
  cwd: string,
  target: string,
): Promise<InboundLinkScan> {
  const items: LinkRewriteItem[] = [];
  const issues: LinkScanIssue[] = [];

  for (const rel of await linkSurfaceFiles(cwd)) {
    if (rel === target) continue; // the file being pruned itself
    let content: string;
    try {
      content = await readFile(join(cwd, rel), "utf8");
    } catch {
      issues.push({ source_file: rel, line: null, reason: "unreadable" });
      continue;
    }

    const lines = content.split(/\r?\n/);
    let inFence = false;
    let fenceChar = "";

    for (let i = 0; i < lines.length; i++) {
      const original = lines[i]!;
      const fence = FENCE.exec(original);
      if (fence) {
        const ch = fence[1]![0]!;
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
        } else if (ch === fenceChar) {
          inFence = false;
        }
        continue;
      }

      // reference-style definition pointing at the target → unsupported (fail-closed).
      const ref = REF_DEF.exec(original);
      if (ref && resolveFrom(rel, ref[1]!) === target) {
        issues.push({ source_file: rel, line: i + 1, reason: "unsupported_reference_style" });
        continue;
      }

      const blanked = blankInlineCode(original);
      INLINE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INLINE.exec(blanked)) !== null) {
        const start = m.index;
        if (start > 0 && blanked[start - 1] === "!") continue; // image embed — never rewritten
        if (resolveFrom(rel, m[2]!) !== target) continue;
        const isIndexRow = rel === "design/decisions/README.md" && /^\s*\|/.test(original);
        items.push({
          source_file: rel,
          line: i + 1,
          column: start + 1,
          raw_link: original.slice(start, start + m[0].length),
          raw_href: m[2]!,
          link_text: m[1]!,
          normalized_target: target,
          link_kind: isIndexRow ? "index_row" : "inline",
          rewrite_action: inFence ? "leave_as_is" : isIndexRow ? "tombstone" : "delink",
        });
      }
    }
  }

  const byPos = (a: LinkRewriteItem, b: LinkRewriteItem) =>
    a.source_file !== b.source_file
      ? a.source_file < b.source_file
        ? -1
        : 1
      : a.line !== b.line
        ? a.line - b.line
        : a.column - b.column;
  items.sort(byPos);
  issues.sort((a, b) =>
    a.source_file !== b.source_file ? (a.source_file < b.source_file ? -1 : 1) : (a.line ?? 0) - (b.line ?? 0),
  );
  return { items, issues };
}
