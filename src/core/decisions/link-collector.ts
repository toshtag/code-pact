import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

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

/** An inbound reference (or a discovery failure) prune cannot safely plan — fail-closed. */
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

// The exact source surface check:doc-links validates (scripts/check-doc-links.mjs):
// root .md (CHANGELOG.md excluded there too), docs/** .md, design/** .md,
// .github/** .md + .yml. Kept in lock-step on purpose — these are the files a
// post-prune broken link would be flagged in.
const ROOTS: { rel: string; recursive: boolean; exts: string[] }[] = [
  { rel: ".", recursive: false, exts: [".md"] },
  { rel: "docs", recursive: true, exts: [".md"] },
  { rel: "design", recursive: true, exts: [".md"] },
  { rel: ".github", recursive: true, exts: [".md", ".yml"] },
];

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

/**
 * STRICT walk of the source surface. Unlike the best-effort `walkAndMatch`, an
 * unreadable EXISTING directory is not silently skipped — it becomes an
 * `unreadable` issue so the plan can fail closed (a directory we couldn't read
 * might hide an inbound link). A genuinely absent root (ENOENT) is fine.
 */
async function discoverSources(cwd: string): Promise<{ files: string[]; issues: LinkScanIssue[] }> {
  const files = new Set<string>();
  const issues: LinkScanIssue[] = [];

  async function walk(rel: string, recursive: boolean, exts: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(cwd, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // absent root/subdir is fine
      issues.push({ source_file: rel === "." ? "." : rel, line: null, reason: "unreadable" });
      return;
    }
    for (const e of entries) {
      const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
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
 * an inline body link → `delink`; a link inside a fenced code block →
 * `leave_as_is`. **Excludes** image embeds (`![]()`) and inline-code links.
 * A reference-style link **outside** code is unsupported (a fail-closed issue);
 * inside a code block it is an example and ignored. An unreadable source file or
 * directory is a fail-closed issue too.
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

      // A reference-style definition pointing at the target is unsupported — but
      // ONLY when it is a real definition, not an example inside a code block.
      const ref = REF_DEF.exec(original);
      if (ref && !inFence && resolveFrom(rel, ref[1]!) === target) {
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
