#!/usr/bin/env tsx
// Generate marked doc blocks FROM the typed source-of-truth catalogs in src/.
//
// This is the "generate-from-source" companion to check-doc-invariants.mjs.
// That checker asserts "IF code does X THEN the doc must MENTION Y" — the prose
// stays hand-written, the check only guards its presence. This generator goes
// one step further for *enumerable* facts (tables of values): the doc block IS
// rendered from the typed catalog, so it cannot drift because nobody hand-writes
// it. Edit the catalog in src/, run `pnpm gen:doc-blocks`, and CI
// (`pnpm check:doc-blocks`) fails until the committed block matches.
//
//   pnpm gen:doc-blocks     rewrite every block in place
//   pnpm check:doc-blocks   regenerate in memory and fail on drift (CI)
//
// Run via tsx so it imports the TypeScript catalog directly — no dist build
// needed (matches scripts/gen-cli-reference.ts).
//
// To add a block: export a catalog from src/, write a `render()` for it, add a
// BLOCKS entry, and wrap the target region in the start/end markers below.
// --check compares the regenerated block to what is committed, so it works on a
// dirty working tree (unlike `git diff --exit-code`).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { SPEC_IMPORT_DETAILS } from "../src/contracts/spec-import-details.ts";
import {
  PLAN_INPUT_FILE_DETAILS,
  PLAN_INPUT_STDIN_DETAILS,
} from "../src/contracts/plan-input-details.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- pure helpers (exported for tests) ------------------------------------

/** Escape a string for safe use inside a RegExp source. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The opening marker comment for a generated block. */
export function startMarker(id: string, source: string): string {
  return `<!-- @generated:${id} — DO NOT EDIT by hand; regenerate with \`pnpm gen:doc-blocks\`. Source: ${source}. -->`;
}

/** The closing marker comment for a generated block. */
export function endMarker(id: string): string {
  return `<!-- @generated:${id}:end -->`;
}

/**
 * The full marker-wrapped block text. Block-level (default) puts the markers on
 * their own lines around a multi-line body (a table); `inline` keeps everything
 * on one line so a generated value can sit mid-sentence — the marker comments are
 * invisible when rendered, so the prose reads unchanged.
 */
export function renderBlock(id: string, source: string, body: string, inline = false): string {
  const sep = inline ? "" : "\n";
  return `${startMarker(id, source)}${sep}${body}${sep}${endMarker(id)}`;
}

/** Matches the whole start…end region for `id` (start marker text is flexible). */
function blockRegExp(id: string): RegExp {
  const e = escapeRegExp(id);
  // `(?![-\w])`, NOT `\b`: ids are hyphenated, and `\b` matches between a word
  // char and `-`, so `blockRegExp("foo")` would wrongly match a `foo-bar` marker
  // — and the lazy body could then span from one block's start to another's end,
  // deleting the block in between on splice. The lookahead requires the id to END
  // here (next char is neither a word char nor `-`).
  return new RegExp(
    `<!-- @generated:${e}(?![-\\w])[^>]*-->[\\s\\S]*?<!-- @generated:${e}:end -->`,
  );
}

/** The current marker-wrapped region for `id`, or null if its markers are absent. */
export function extractBlock(docText: string, id: string): string | null {
  const m = docText.match(blockRegExp(id));
  return m ? m[0] : null;
}

/**
 * Replace the region between `id`'s markers with a freshly rendered block.
 * Idempotent (splicing the same body twice yields the same text). Throws if the
 * markers are absent, so a generator entry can never silently no-op.
 */
export function spliceBlock(
  docText: string,
  id: string,
  source: string,
  body: string,
  inline = false,
): string {
  const re = blockRegExp(id);
  if (!re.test(docText)) {
    throw new Error(
      `gen-doc-blocks: markers for "${id}" not found — add ${startMarker(id, source)} … ${endMarker(id)} around the target region`,
    );
  }
  return docText.replace(re, renderBlock(id, source, body, inline));
}

/** Escape a value so it is safe inside a Markdown table cell (`|` breaks the row). */
export function escapeTableCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Render a `| detail | When |` table from a `{ key: { when } }` catalog. */
export function renderDetailTable(catalog: Record<string, { when: string }>): string {
  const rows = Object.entries(catalog).map(
    ([detail, { when }]) => `| \`${escapeTableCell(detail)}\` | ${escapeTableCell(when)} |`,
  );
  return ["| `detail` | When |", "| --- | --- |", ...rows].join("\n");
}

/**
 * Render an inline `` `a | b | c` `` enum list from a catalog (keys only, in
 * insertion order) — the form already used in prose for the plan input details.
 */
export function renderDetailList(catalog: Record<string, unknown>): string {
  return `\`${Object.keys(catalog).join(" | ")}\``;
}

// --- registry -------------------------------------------------------------

interface BlockSpec {
  id: string;
  file: string;
  source: string;
  render: () => string;
  /** Inline blocks sit mid-sentence (no surrounding newlines). */
  inline?: boolean;
}

const PLAN_INPUT_SOURCE =
  "PLAN_INPUT_*_DETAILS in src/contracts/plan-input-details.ts";

export const BLOCKS: BlockSpec[] = [
  {
    id: "spec-import-details",
    file: "docs/cli-contract.md",
    source: "SPEC_IMPORT_DETAILS in src/contracts/spec-import-details.ts",
    render: () => renderDetailTable(SPEC_IMPORT_DETAILS),
  },
  // plan brief / plan constitution share the same --from-file / --stdin detail
  // sets; the inline list mirrors the existing prose form. Four ids (one per
  // command×mode) keep each doc location self-contained.
  {
    id: "plan-brief-from-file-detail",
    file: "docs/cli-contract.md",
    source: PLAN_INPUT_SOURCE,
    render: () => renderDetailList(PLAN_INPUT_FILE_DETAILS),
    inline: true,
  },
  {
    id: "plan-brief-from-stdin-detail",
    file: "docs/cli-contract.md",
    source: PLAN_INPUT_SOURCE,
    render: () => renderDetailList(PLAN_INPUT_STDIN_DETAILS),
    inline: true,
  },
  {
    id: "plan-constitution-from-file-detail",
    file: "docs/cli-contract.md",
    source: PLAN_INPUT_SOURCE,
    render: () => renderDetailList(PLAN_INPUT_FILE_DETAILS),
    inline: true,
  },
  {
    id: "plan-constitution-from-stdin-detail",
    file: "docs/cli-contract.md",
    source: PLAN_INPUT_SOURCE,
    render: () => renderDetailList(PLAN_INPUT_STDIN_DETAILS),
    inline: true,
  },
];

// --- run ------------------------------------------------------------------

/** Group blocks by their target file (one read/write per file). */
function blocksByFile(): Map<string, BlockSpec[]> {
  const byFile = new Map<string, BlockSpec[]>();
  for (const block of BLOCKS) {
    const list = byFile.get(block.file) ?? [];
    list.push(block);
    byFile.set(block.file, list);
  }
  return byFile;
}

function runGenerate(): void {
  for (const [file, blocks] of blocksByFile()) {
    const abs = resolve(repoRoot, file);
    let text = readFileSync(abs, "utf8");
    for (const block of blocks) {
      text = spliceBlock(text, block.id, block.source, block.render(), block.inline);
    }
    writeFileSync(abs, text);
    process.stdout.write(`Wrote ${blocks.length} block(s) to ${file}\n`);
  }
}

function runCheck(): void {
  const problems: string[] = [];
  for (const [file, blocks] of blocksByFile()) {
    const text = readFileSync(resolve(repoRoot, file), "utf8");
    for (const block of blocks) {
      const expected = renderBlock(block.id, block.source, block.render(), block.inline);
      const actual = extractBlock(text, block.id);
      if (actual === null) {
        problems.push(`${file}: markers for "${block.id}" not found`);
      } else if (actual !== expected) {
        problems.push(`${file}: generated block "${block.id}" is stale`);
      }
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`check:doc-blocks: ${problems.length} issue(s):\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write("Run `pnpm gen:doc-blocks` and commit the result.\n");
    process.exit(1);
  }
  process.stdout.write(
    `check:doc-blocks: OK — ${BLOCKS.length} generated block(s) up to date.\n`,
  );
}

// Run when invoked directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (process.argv.includes("--check")) runCheck();
  else runGenerate();
}
