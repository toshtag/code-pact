#!/usr/bin/env tsx
// Public Markdown link check — the GitHub-clickable view.
//
// This is the COMPLEMENT of `check-doc-links`, not a duplicate:
//   - `check-doc-links` is RECORD-AWARE: a link to a hand-deleted / retired
//     `design/decisions/**/*.md` resolves as OK when a `.code-pact/state` decision
//     record backs it (the ephemeral-design-doc model's semantic integrity).
//   - THIS check is DISK-ONLY: a clickable Markdown link whose target file is not
//     present on disk is a 404 for a human reading the rendered Markdown on GitHub,
//     regardless of any record. v2.0.0's headline is "design docs can be retired
//     safely" — so a retired decision must be referenced as PLAIN TEXT / a code
//     span, never a clickable link, in the public doc set.
//
// Scope: README.md, CHANGELOG.md, SECURITY.md, CONTRIBUTING.md, and every `.md`
// under docs/ , design/ , .github/ — EXCLUDING the archived CHANGELOG history
// (`docs/maintainers/history/CHANGELOG-<major>.md`), whose links are verbatim
// point-in-time history (same exclusion `check-doc-links` makes). Links inside
// fenced or inline code are illustrative and skipped. Only relative `.md` targets
// are checked (external URLs, non-.md files, and bare `#anchor` links are out of
// scope — anchor validity is `check-doc-links`' job).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, normalize } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_FILES = ["README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md"];
// Mirrors check-doc-links' source roots: docs / design are Markdown; `.github`
// also carries `.yml` (issue templates render their `value:` strings as Markdown
// on GitHub, so a relative `.md` link in one is just as clickable / 404-able).
const SCAN_DIRS: { dir: string; exts: string[] }[] = [
  { dir: "docs", exts: [".md"] },
  { dir: "design", exts: [".md"] },
  { dir: ".github", exts: [".md", ".yml"] },
];
// Verbatim historical content; its links are point-in-time (mirrors check-doc-links).
const ARCHIVED_CHANGELOG_RE = /^docs[/\\]maintainers[/\\]history[/\\]CHANGELOG-\d+\.md$/;
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const LINK_RE = /\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;

/** Replace fenced + inline code spans with same-length blanks (line numbers preserved). */
function blankCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/~~~[\s\S]*?~~~/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

function filesUnder(absDir: string, relDir: string, exts: string[], out: string[]): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(absDir, e.name);
    const rel = join(relDir, e.name);
    if (e.isDirectory()) filesUnder(abs, rel, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(rel);
  }
}

/** Returns a list of human-readable problem strings (empty == no broken clickable links). */
export function checkPublicMdLinks(root: string): string[] {
  const problems: string[] = [];
  const sources = [...ROOT_FILES];
  for (const { dir, exts } of SCAN_DIRS) filesUnder(resolve(root, dir), dir, exts, sources);

  for (const rel of sources) {
    const relNorm = rel.split("\\").join("/");
    if (ARCHIVED_CHANGELOG_RE.test(rel)) continue;
    let raw: string;
    try {
      raw = readFileSync(resolve(root, rel), "utf8");
    } catch {
      continue; // a ROOT_FILE that does not exist in this tree
    }
    const lines = blankCode(raw).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      LINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LINK_RE.exec(line)) !== null) {
        const target = m[1];
        if (target === undefined || EXTERNAL_RE.test(target)) continue;
        const filePart = target.split("#")[0];
        if (!filePart || !filePart.endsWith(".md")) continue;
        const abs = normalize(join(dirname(resolve(root, rel)), filePart));
        if (!existsSync(abs)) {
          problems.push(`${relNorm}:${i + 1}: clickable link to a missing file → ${filePart} (404 on GitHub; reference it as plain text / a code span)`);
        }
      }
    }
  }
  return problems;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const problems = checkPublicMdLinks(repoRoot);
  if (problems.length > 0) {
    console.error(`check-public-md-links: ${problems.length} broken clickable .md link(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("check-public-md-links: OK — no clickable .md link 404s in the public doc set.");
}
