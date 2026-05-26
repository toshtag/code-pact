#!/usr/bin/env node
// Doc link checker (PR1 safety baseline).
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
// Anchor slugs are generated with `github-slugger` (a tested GitHub-compatible
// implementation) — never a hand-rolled slugifier, which would diverge on
// backticks, brackets, dots, non-ASCII headings, and duplicate-heading -1/-2.

import { readFile, access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, join, extname } from "node:path";
import GithubSlugger from "github-slugger";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Source files whose links we scan: README + the doc trees + design + .github.
// CHANGELOG.md is intentionally excluded as a *source* (3k lines of historical
// links create noise); it remains valid as a *target* for inbound links.
const SOURCE_ROOTS = [
  { dir: ".", recursive: false, exts: [".md"] },
  { dir: "docs", recursive: true, exts: [".md"] },
  { dir: "design", recursive: true, exts: [".md"] },
  { dir: ".github", recursive: true, exts: [".md", ".yml"] },
];
// Root-level .md files we do NOT scan as sources (still valid as targets).
const ROOT_SOURCE_SKIP = new Set(["CHANGELOG.md"]);

const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const LINK_RE = /\[(?:[^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
const HEADING_RE = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/gm;
const FENCE_RE = /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[^\n]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const HEADING_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;

async function exists(absPath) {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

async function walk(absDir, recursive) {
  const out = [];
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

async function collectSourceFiles() {
  const files = new Set();
  for (const root of SOURCE_ROOTS) {
    const absDir = resolve(repoRoot, root.dir);
    const found = await walk(absDir, root.recursive);
    for (const abs of found) {
      if (!root.exts.includes(extname(abs))) continue;
      const rel = relative(repoRoot, abs);
      if (root.dir === "." && ROOT_SOURCE_SKIP.has(rel)) continue;
      files.add(abs);
    }
  }
  return [...files].sort();
}

// Blank out a matched span while preserving newlines, so byte/line offsets in
// the result still line up with the raw text (accurate line numbers in
// reports). Non-newline characters become spaces.
const blank = (m) => m.replace(/[^\n]/g, " ");

// Blank fenced code blocks only. Used for heading extraction: a `#` inside a
// fenced block is not a heading, but inline code in a heading (e.g.
// "## `phase import`") is real and must be kept — github-slugger strips the
// backticks itself, so removing them here would corrupt the slug.
function stripFences(text) {
  return text.replace(FENCE_RE, blank);
}

// Blank fenced blocks AND inline code spans. Used for link extraction so that
// example links inside code (fenced or inline) are not treated as real links.
function stripCode(text) {
  return stripFences(text).replace(INLINE_CODE_RE, blank);
}

// Build the set of GitHub anchor slugs (heading-derived) for a Markdown file.
const anchorCache = new Map();
async function anchorsFor(absMdPath) {
  if (anchorCache.has(absMdPath)) return anchorCache.get(absMdPath);
  let raw;
  try {
    raw = await readFile(absMdPath, "utf8");
  } catch {
    anchorCache.set(absMdPath, null);
    return null;
  }
  const body = stripFences(raw);
  const slugger = new GithubSlugger();
  const slugs = new Set();
  for (const m of body.matchAll(HEADING_RE)) {
    // Reduce markdown links `[txt](url)` in a heading to their visible text,
    // matching how GitHub slugs such a heading.
    const textPart = m[2].replace(HEADING_LINK_RE, "$1");
    slugs.add(slugger.slug(textPart));
  }
  anchorCache.set(absMdPath, slugs);
  return slugs;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Extract inline links (with line numbers), skipping image embeds.
function extractLinks(rawText) {
  const stripped = stripCode(rawText);
  const out = [];
  for (const m of stripped.matchAll(LINK_RE)) {
    const before = m.index > 0 ? stripped[m.index - 1] : "";
    if (before === "!") continue; // image embed
    out.push({ target: m[1], line: lineOf(stripped, m.index) });
  }
  return out;
}

async function main() {
  const sources = await collectSourceFiles();
  const problems = [];
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
        const slugs = await anchorsFor(absSource);
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
        problems.push(`${relSource}:${line} → ${target} (target file does not exist)`);
        continue;
      }
      if (fragment !== "") {
        const slugs = await anchorsFor(absTarget);
        if (slugs && !slugs.has(decodeURIComponent(fragment))) {
          problems.push(
            `${relSource}:${line} → ${target} (file exists, but #${fragment} is not a heading there)`,
          );
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(
      `check-doc-links: ${problems.length} broken link(s) across ${sources.length} source file(s):`,
    );
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(
    `check-doc-links: OK — ${checked} relative .md link(s) resolved across ${sources.length} source file(s).`,
  );
}

await main();
