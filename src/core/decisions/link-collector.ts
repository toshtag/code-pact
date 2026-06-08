import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { walkAndMatch } from "../glob.ts";

/**
 * One inbound `.md` reference to a pruned decision. The dry-run preview and the
 * future `--write` executor consume the SAME items — this collector is the
 * single source of the rewrite plan. It is deliberately NOT the conservative
 * eligibility parser (`decisionLinksTo`): that one over-counts on purpose
 * (fail-closed) and resolves relative to `design/decisions/`; this one is
 * precise, line-accurate, code-fence-aware, and resolves each link relative to
 * its OWN source file's directory.
 */
export type LinkRewriteItem = {
  source_file: string;
  line: number;
  raw_href: string;
  normalized_target: string;
  link_kind: "inline" | "reference_definition" | "index_row";
  rewrite_action: "tombstone" | "delink" | "leave_as_is";
};

/** The doc surface `check:doc-links` validates — where a broken inbound link would fail. */
function inLinkSurface(rel: string): boolean {
  if (!rel.endsWith(".md")) return false;
  return (
    !rel.includes("/") || // root-level
    rel.startsWith("docs/") ||
    rel.startsWith("design/") ||
    rel.startsWith(".github/")
  );
}

const INLINE = /\[(?:[^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const REF_DEF = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const FENCE = /^\s*(```+|~~~+)/;

function stripAngleBrackets(raw: string): string {
  const s = raw.trim();
  return s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

/** Resolve a link destination relative to its source file's directory. */
function resolveFrom(sourceFile: string, href: string): string {
  const dest = stripAngleBrackets(href).split("#")[0]!.trim();
  if (dest === "" || /^[a-z]+:\/\//i.test(dest)) return ""; // empty / absolute URL
  return posix.normalize(posix.join(posix.dirname(sourceFile), dest)).replace(/^(?:\.\/)+/, "");
}

/**
 * Collect every inbound markdown link to `target` across the doc surface, with
 * the action `--write` would take: a `README.md` decision-index row →
 * `tombstone`; a body link → `delink`; a link inside a fenced code block →
 * `leave_as_is` (it is an example, not a live reference). Empty when nothing
 * links to the target.
 */
export async function collectInboundLinks(
  cwd: string,
  target: string,
): Promise<LinkRewriteItem[]> {
  const files = (await walkAndMatch(cwd, "**/*.md")).filter(inLinkSurface);
  const items: LinkRewriteItem[] = [];

  for (const rel of files) {
    if (rel === target) continue; // the file being pruned itself
    let content: string;
    try {
      content = await readFile(join(cwd, rel), "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    let inFence = false;
    let fenceChar = "";

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const fence = FENCE.exec(text);
      if (fence) {
        const ch = fence[1]![0]!;
        if (!inFence) {
          inFence = true;
          fenceChar = ch;
        } else if (ch === fenceChar) {
          inFence = false;
        }
        continue; // the fence line itself carries no link
      }

      const hrefs: { raw: string; kind: "inline" | "reference_definition" }[] = [];
      let m: RegExpExecArray | null;
      INLINE.lastIndex = 0;
      while ((m = INLINE.exec(text)) !== null) hrefs.push({ raw: m[1]!, kind: "inline" });
      const ref = REF_DEF.exec(text);
      if (ref) hrefs.push({ raw: ref[1]!, kind: "reference_definition" });

      for (const { raw, kind } of hrefs) {
        if (resolveFrom(rel, raw) !== target) continue;
        const isIndexRow =
          rel === "design/decisions/README.md" && /^\s*\|/.test(text);
        const link_kind = isIndexRow ? "index_row" : kind;
        const rewrite_action = inFence
          ? "leave_as_is"
          : link_kind === "index_row"
            ? "tombstone"
            : "delink";
        items.push({
          source_file: rel,
          line: i + 1,
          raw_href: raw,
          normalized_target: target,
          link_kind,
          rewrite_action,
        });
      }
    }
  }

  return items.sort((a, b) =>
    a.source_file === b.source_file
      ? a.line - b.line
      : a.source_file < b.source_file
        ? -1
        : 1,
  );
}
