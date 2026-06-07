#!/usr/bin/env node
// History-noise gate — a self-enforcing ratchet (companion to
// check-doc-invariants.mjs).
//
// Hard-fails on version tags (vX.Y[.Z]) in user-facing surfaces, because
// version provenance baked into prose or comments is a hand-synced surface that
// drifts every release: it must be re-touched each time a feature ships, and
// when it isn't, the docs contradict the product. This is the mechanized form
// of the P1-16 docs cleanup — it stops NEW version noise from entering the
// protected surfaces, while an explicit allowlist grandfathers the heavy docs
// that are still being cleaned by hand.
//
// THE RATCHET. scripts/history-noise-allowlist.txt may only SHRINK:
//   - You may not add a path to silence a fresh violation — clean the file.
//   - When you clean an allowlisted file, you MUST remove it from the list:
//     this checker FAILS on a "stale" allowlist entry (one that no longer has
//     any version tag), so a cleaned-but-still-listed file cannot slip by. The
//     allowlist therefore can only get smaller over time.
//
// Scope is deliberately narrow to stay false-positive-free:
//   - Hard pattern: version tags only (\bv\d+\.\d+(?:\.\d+)?\b). Phase ids
//     (Pnn), RFC citations, and wizard-prompt phrasing are NOT gated here — a
//     regex cannot tell a legitimate example id / external standard / current
//     description from history noise, so those stay a matter of judgment.
//   - Docs: docs/**/*.md plus the root README.md, scanning visible prose only.
//     Fenced code, <details> blocks, and inline code spans are stripped first:
//     a version inside an install command, sample output, or a collapsed
//     history block is legitimate. docs/maintainers/** is the sanctioned home
//     for version history and is exempt wholesale.
//   - Code: comments only in src/**/*.ts. String literals are never scanned — a
//     version in an error message or a generated artifact is the generator's
//     concern (guarded by its own unit test), not prose drift. tests/ comments
//     are intentionally out of scope: test comments legitimately carry
//     version-scenario context (migration tests, "behavior shipped in vX.Y"
//     markers that document what a test pins), so a hard gate there would be
//     mostly false positives.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

// vX.Y or vX.Y.Z — the only hard-gated pattern.
const VERSION_RE = /\bv\d+\.\d+(?:\.\d+)?\b/g;

const problems = [];

// --- allowlist ------------------------------------------------------------
const ALLOWLIST_REL = "scripts/history-noise-allowlist.txt";
const allow = new Set(
  read(ALLOWLIST_REL)
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean),
);
// docs/maintainers/** is exempt in code (category, not a per-file entry).
const isExempt = (rel) => allow.has(rel) || rel.startsWith("docs/maintainers/");

// --- file discovery -------------------------------------------------------
function walk(dir, keep, acc = []) {
  if (!existsSync(resolve(repoRoot, dir))) return acc;
  for (const name of readdirSync(resolve(repoRoot, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(resolve(repoRoot, rel)).isDirectory()) walk(rel, keep, acc);
    else if (keep(rel)) acc.push(rel);
  }
  return acc;
}

// --- scanners (pure: return [{ line, match }]) ----------------------------
// Visible markdown prose only. Skips fenced code, <details> blocks, and inline
// code spans; collects every version tag left in the remaining prose.
function collectDocHits(text) {
  const hits = [];
  const lines = text.split("\n");
  let fenceChar = ""; // "" = not in a fence
  let fenceLen = 0;
  let inDetails = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceChar) {
      // CommonMark close: a run of >= the opening length, same char, nothing
      // else on the line. A language-annotated line (```yaml) is content, not
      // a close, so a longer outer fence wrapping inner fences is handled.
      const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
        fenceChar = "";
        fenceLen = 0;
      }
      continue;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      continue;
    }
    if (/<details\b/i.test(line)) inDetails = true;
    if (inDetails) {
      if (/<\/details>/i.test(line)) inDetails = false;
      continue;
    }
    // Strip inline code spans (double-backtick before single so ``x`` goes too).
    const visible = line.replace(/``[^`\n]*``/g, "").replace(/`[^`\n]*`/g, "");
    for (const m of visible.matchAll(VERSION_RE)) hits.push({ line: i + 1, match: m[0] });
  }
  return hits;
}

const lineOfOffset = (text, offset) => {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
};

// TypeScript comments only (single- and multi-line). String literals and code
// are never inspected, so a version in an error message or generated artifact
// is ignored — that surface is guarded by its own unit test.
function collectTsHits(text) {
  const hits = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.Standard,
    text,
  );
  let token;
  while ((token = scanner.scan()) !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      continue;
    }
    const start = scanner.getTokenPos();
    const body = scanner.getTokenText();
    for (const m of body.matchAll(VERSION_RE)) {
      hits.push({ line: lineOfOffset(text, start + m.index), match: m[0] });
    }
  }
  return hits;
}

// --- run ------------------------------------------------------------------
const allDocs = ["README.md", ...walk("docs", (rel) => rel.endsWith(".md"))];
const scannedDocs = allDocs.filter((rel) => !isExempt(rel));
for (const rel of scannedDocs) {
  for (const h of collectDocHits(read(rel))) {
    problems.push(
      `${rel}:${h.line}: version tag "${h.match}" in prose — move it to <details> / ` +
        `upgrading.md / maintainers, or drop it. Do NOT add the file to the allowlist.`,
    );
  }
}

const srcFiles = walk("src", (rel) => rel.endsWith(".ts")).filter((rel) => !isExempt(rel));
for (const rel of srcFiles) {
  for (const h of collectTsHits(read(rel))) {
    problems.push(
      `${rel}:${h.line}: version tag "${h.match}" in a comment — drop it (a comment ` +
        `records an invariant, not which release introduced it).`,
    );
  }
}

// Ratchet enforcement: every allowlisted doc must STILL be dirty. A cleaned
// (or deleted/over-broad) entry left in the list is the only way the allowlist
// could fail to shrink, so flag it.
for (const rel of allow) {
  if (!rel.endsWith(".md")) continue; // allowlist holds doc paths only
  if (!existsSync(resolve(repoRoot, rel))) {
    problems.push(
      `${ALLOWLIST_REL}: "${rel}" no longer exists — remove this stale allowlist entry.`,
    );
    continue;
  }
  if (collectDocHits(read(rel)).length === 0) {
    problems.push(
      `${ALLOWLIST_REL}: "${rel}" has no version tags left — remove it from the allowlist ` +
        `(the ratchet tightens: a cleaned file must be protected, not exempt).`,
    );
  }
}

if (problems.length > 0) {
  console.error(`check-history-noise: ${problems.length} issue(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-history-noise: OK — no version tags in ${scannedDocs.length} doc(s) + ` +
    `${srcFiles.length} src file(s); ${[...allow].filter((r) => r.endsWith(".md")).length} ` +
    `allowlisted doc(s) all still dirty.`,
);
