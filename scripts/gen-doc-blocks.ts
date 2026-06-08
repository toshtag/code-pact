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
  PLAN_CAPTURE_FILE_DETAILS,
  PLAN_CAPTURE_STDIN_DETAILS,
} from "../src/contracts/plan-capture-details.ts";

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
 * The full marker-wrapped block text: the markers go on their own lines around a
 * block-level body (a table). Generated blocks are always block-level — never
 * inline mid-sentence markers, which clutter the Markdown source (see
 * design/rules/doc-authoring.md).
 */
export function renderBlock(id: string, source: string, body: string): string {
  return `${startMarker(id, source)}\n${body}\n${endMarker(id)}`;
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
export function spliceBlock(docText: string, id: string, source: string, body: string): string {
  const re = blockRegExp(id);
  if (!re.test(docText)) {
    throw new Error(
      `gen-doc-blocks: markers for "${id}" not found — add ${startMarker(id, source)} … ${endMarker(id)} around the target region`,
    );
  }
  return docText.replace(re, renderBlock(id, source, body));
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

/** Backtick + comma-join a catalog's keys (insertion order). */
function backtickedKeys(catalog: Record<string, unknown>): string {
  return Object.keys(catalog)
    .map((k) => `\`${k}\``)
    .join(", ");
}

/**
 * Render the single shared `plan brief` / `plan constitution` non-interactive
 * input detail table (one block-level table both command sections link to,
 * instead of restating the enum inline in four places).
 */
export function renderPlanCaptureDetailTable(): string {
  return [
    "| Surface | `detail` values |",
    "| --- | --- |",
    `| \`plan brief --from-file\`, \`plan constitution --from-file\` | ${escapeTableCell(backtickedKeys(PLAN_CAPTURE_FILE_DETAILS))} |`,
    `| \`plan brief --stdin\`, \`plan constitution --stdin\` | ${escapeTableCell(backtickedKeys(PLAN_CAPTURE_STDIN_DETAILS))} |`,
  ].join("\n");
}

// --- registry -------------------------------------------------------------

interface BlockSpec {
  id: string;
  file: string;
  source: string;
  render: () => string;
}

export const BLOCKS: BlockSpec[] = [
  {
    id: "spec-import-details",
    file: "docs/cli-contract.md",
    source: "SPEC_IMPORT_DETAILS in src/contracts/spec-import-details.ts",
    render: () => renderDetailTable(SPEC_IMPORT_DETAILS),
  },
  // One shared table for the plan brief / plan constitution capture details —
  // both command sections link to it, rather than restating the enum inline.
  {
    id: "plan-capture-details",
    file: "docs/cli-contract.md",
    source: "PLAN_CAPTURE_*_DETAILS in src/contracts/plan-capture-details.ts",
    render: renderPlanCaptureDetailTable,
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
      text = spliceBlock(text, block.id, block.source, block.render());
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
      const expected = renderBlock(block.id, block.source, block.render());
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
