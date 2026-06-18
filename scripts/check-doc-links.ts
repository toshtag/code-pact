#!/usr/bin/env -S npx tsx
// Doc link checker (PR1 safety baseline; design-docs-ephemeral step 7 PR-A made it
// archive-record-aware and testable).
//
// Validates relative Markdown links so the documentation overhaul (and any
// future doc reshaping) cannot silently break the cross-doc anchor web. CI
// has no markdown lint / link check; `plan lint` only validates phase-YAML
// `acceptance_refs` / `decision_refs`, never the prose links between docs.
//
// Scope (deliberately narrow — matches the approved plan):
//   - relative `.md` file links            → target file must exist
//   - relative `.md#anchor` links          → file must exist AND anchor must resolve
//   - same-file `#anchor` links (in .md)   → anchor must resolve in the same file
//
// Out of scope (skipped, not failures):
//   - external links (http/https/mailto/tel/protocol-relative)
//   - non-.md relative targets (src/*.ts, *.json, directories, LICENSE, …)
//   - links inside fenced or inline code spans, and image embeds (`![]()`)
//
// design-docs-ephemeral step 7 (half ii): a relative `.md` link whose target file
// is GONE but is recorded as a RETIRED decision under `.code-pact/state` resolves
// as *retired*, not *broken* — the safety net for a hand-deleted
// `design/decisions/*.md`. The retired judgement is delegated WHOLE to the step-5
// lint-soften predicate `decisionRecordSoftensMissingRef` (which itself does the
// normalize + symlink-aware true-ENOENT presence + identity re-check + schema
// validation); this checker re-implements none of that contract — see
// `isRetiredDecision` below.
//
// Anchor slugs are generated with `github-slugger` (a tested GitHub-compatible
// implementation) — never a hand-rolled slugifier, which would diverge on
// backticks, brackets, dots, non-ASCII headings, and duplicate-heading -1/-2.

import { readFile, access, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, relative, join, extname, isAbsolute, sep } from "node:path";
import GithubSlugger from "github-slugger";
import { decisionRecordSoftensMissingRef } from "../src/core/decisions/decision-gate-archive.ts";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Source files whose links we scan: README + the doc trees + design + .github.
// CHANGELOG.md is intentionally excluded as a *source* (3k lines of historical
// links create noise); it remains valid as a *target* for inbound links.
const SOURCE_ROOTS: { dir: string; recursive: boolean; exts: string[] }[] = [
  { dir: ".", recursive: false, exts: [".md"] },
  { dir: "docs", recursive: true, exts: [".md"] },
  { dir: "design", recursive: true, exts: [".md"] },
  { dir: ".github", recursive: true, exts: [".md", ".yml"] },
];
// Root-level .md files we do NOT scan as sources (still valid as targets).
const ROOT_SOURCE_SKIP = new Set(["CHANGELOG.md"]);

// The archived CHANGELOG history (`docs/maintainers/history/CHANGELOG-<major>.md`) is the
// SAME verbatim historical content as root `CHANGELOG.md` — older major sections MOVED out
// of the root file by `changelog:archive` — so it is excluded as a SOURCE for the identical
// reason: its links are POINT-IN-TIME (they reference docs / `design/decisions/*.md` as they
// were at that release; some have since moved or retired), so checking them is noise, not
// signal, and could never stay green as the tree evolves. It remains valid as a link TARGET.
const ARCHIVED_CHANGELOG_RE = /^docs[/\\]maintainers[/\\]history[/\\]CHANGELOG-\d+\.md$/;

const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[^\n]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const HEADING_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;

async function exists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function walk(absDir: string, recursive: boolean): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
      continue;
    }
    const abs = join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) out.push(...(await walk(abs, true)));
    } else if (entry.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

async function collectSourceFiles(repoRoot: string): Promise<string[]> {
  const files = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    const absDir = resolve(repoRoot, root.dir);
    const found = await walk(absDir, root.recursive);
    for (const abs of found) {
      if (!root.exts.includes(extname(abs))) continue;
      const rel = relative(repoRoot, abs);
      if (root.dir === "." && ROOT_SOURCE_SKIP.has(rel)) continue;
      if (ARCHIVED_CHANGELOG_RE.test(rel.split(sep).join("/"))) continue; // verbatim historical content
      files.add(abs);
    }
  }
  return [...files].sort();
}

// Blank out a matched span while preserving newlines, so byte/line offsets in
// the result still line up with the raw text (accurate line numbers in
// reports). Non-newline characters become spaces.
const blank = (m: string): string => m.replace(/[^\n]/g, " ");

// Blank fenced code blocks only. Used for heading extraction: a `#` inside a
// fenced block is not a heading, but inline code in a heading (e.g.
// "## `phase import`") is real and must be kept — github-slugger strips the
// backticks itself, so removing them here would corrupt the slug.
function stripFences(text: string): string {
  return text.replace(FENCE_RE, blank);
}

// Blank fenced blocks AND inline code spans. Used for link extraction so that
// example links inside code (fenced or inline) are not treated as real links.
function stripCode(text: string): string {
  return stripFences(text).replace(INLINE_CODE_RE, blank);
}

// Build the set of GitHub anchor slugs (heading-derived) for a Markdown file.
// The cache is per-run (created inside checkDocLinks), so a temp-tree test never
// sees a slug set computed against a different repoRoot.
async function anchorsFor(
  absMdPath: string,
  cache: Map<string, Set<string> | null>,
): Promise<Set<string> | null> {
  if (cache.has(absMdPath)) return cache.get(absMdPath) ?? null;
  let raw: string;
  try {
    raw = await readFile(absMdPath, "utf8");
  } catch {
    cache.set(absMdPath, null);
    return null;
  }
  const body = stripFences(raw);
  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  for (const m of body.matchAll(HEADING_RE)) {
    // Reduce markdown links `[txt](url)` in a heading to their visible text,
    // matching how GitHub slugs such a heading.
    const textPart = m[2]!.replace(HEADING_LINK_RE, "$1");
    slugs.add(slugger.slug(textPart));
  }
  cache.set(absMdPath, slugs);
  return slugs;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// Extract inline links (with line numbers), skipping image embeds.
function extractLinks(rawText: string): { target: string; line: number }[] {
  const stripped = stripCode(rawText);
  const out: { target: string; line: number }[] = [];
  for (const m of stripped.matchAll(LINK_RE)) {
    const before = m.index! > 0 ? stripped[m.index! - 1] : "";
    if (before === "!") continue; // image embed
    out.push({ target: m[1]!, line: lineOf(stripped, m.index!) });
  }
  return out;
}

// design-docs-ephemeral step 7 (half ii). A thin adapter: convert the link's
// resolved abs target into a project-relative POSIX ref, then delegate the WHOLE
// retired/broken judgement to the step-5 lint-soften predicate. The predicate
// itself does normalize (top-level design/decisions/*.md only), symlink-aware
// true-ENOENT live presence (an ancestor-symlink escape is `inaccessible`, NOT
// absent → not retired), identity re-check (canonical_ref / original_path /
// path_sha256), and schema validation (a corrupt record is `invalid`, never
// collapsed to absent → not retired). This checker re-implements none of it, so
// the runtime reader and the checker can never drift.
async function isRetiredDecision(
  repoRoot: string,
  absSource: string,
  pathPart: string,
): Promise<boolean> {
  // A backslash in the LINK on a POSIX filesystem is a literal filename byte, not
  // a separator: `exists()` already looked for a file literally named
  // `design\decisions\x.md` (which can't exist), so we must NOT hand the predicate
  // a path that its `\`→`/` normalization would silently turn into the valid
  // forward-slash ref — that would soften a link whose actual fs target is absent
  // for a different reason than retirement. On Windows (`sep === "\\"`) a backslash
  // IS a separator and the conversion below is correct, so only guard on POSIX.
  if (sep === "/" && pathPart.includes("\\")) return false;
  const absTarget = resolve(dirname(absSource), pathPart);
  const rel = relative(repoRoot, absTarget);
  // A structural escape (`..`/absolute) is never a project decision ref. The
  // predicate's normalizeDecisionRef would reject it too, but bail explicitly.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const projectRelativePosix = rel.split(sep).join("/");
  return decisionRecordSoftensMissingRef(repoRoot, projectRelativePosix);
}

export type CheckDocLinksOptions = {
  repoRoot?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
};

/**
 * Scan the doc source roots under `repoRoot` and validate every relative
 * Markdown link. Returns the process exit code (0 = OK, 1 = broken links) instead
 * of calling `process.exit`, so tests can drive a temp tree and assert the result.
 */
export async function checkDocLinks(options: CheckDocLinksOptions = {}): Promise<number> {
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const out = options.stdout ?? process.stdout;
  const err = options.stderr ?? process.stderr;
  const anchorCache = new Map<string, Set<string> | null>();

  const sources = await collectSourceFiles(repoRoot);
  const problems: string[] = [];
  let checked = 0;

  for (const absSource of sources) {
    const relSource = relative(repoRoot, absSource);
    const raw = await readFile(absSource, "utf8");
    const isMd = extname(absSource) === ".md";

    for (const { target, line } of extractLinks(raw)) {
      if (EXTERNAL_RE.test(target)) continue;

      const hashIdx = target.indexOf("#");
      const pathPart = hashIdx === -1 ? target : target.slice(0, hashIdx);
      const fragment = hashIdx === -1 ? "" : target.slice(hashIdx + 1);

      // Same-file anchor (only meaningful for Markdown sources).
      if (pathPart === "") {
        if (!isMd || fragment === "") continue;
        checked++;
        const slugs = await anchorsFor(absSource, anchorCache);
        if (slugs && !slugs.has(decodeURIComponent(fragment))) {
          problems.push(`${relSource}:${line} → #${fragment} (no such heading in this file)`);
        }
        continue;
      }

      // Only .md targets are in scope.
      if (extname(pathPart) !== ".md") continue;

      checked++;
      const absTarget = resolve(dirname(absSource), pathPart);
      if (!(await exists(absTarget))) {
        // design-docs-ephemeral step 7 (half ii): a gone `.md` target that is a
        // recorded RETIRED decision resolves as retired, not broken. Delegated
        // whole to the step-5 predicate (no record logic here).
        if (await isRetiredDecision(repoRoot, absSource, pathPart)) {
          // Already counted at the `checked++` above — a retired link is resolved
          // (via the decision-state record), counted exactly once, like any link.
          // A `#fragment` on a retired target is intentionally NOT validated: the
          // file is gone, so its old headings cannot be (and need not be) checked —
          // the record proves the decision was retired, and a retired link is a
          // historical cross-reference, not a live anchor target.
          continue;
        }
        problems.push(`${relSource}:${line} → ${target} (target file does not exist)`);
        continue;
      }
      if (fragment !== "") {
        const slugs = await anchorsFor(absTarget, anchorCache);
        if (slugs && !slugs.has(decodeURIComponent(fragment))) {
          problems.push(
            `${relSource}:${line} → ${target} (file exists, but #${fragment} is not a heading there)`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    err.write(
      `check-doc-links: ${problems.length} broken link(s) across ${sources.length} source file(s):\n`,
    );
    for (const p of problems) err.write(`  - ${p}\n`);
    return 1;
  }

  out.write(
    `check-doc-links: OK — ${checked} relative .md link(s) resolved across ${sources.length} source file(s).\n`,
  );
  return 0;
}

// CLI entry — only when run directly, never on import (so tests can import
// `checkDocLinks` without triggering a real-repo scan).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(await checkDocLinks());
}
