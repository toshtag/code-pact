#!/usr/bin/env node
// Semantic doc invariants (companion to check-doc-links.mjs).
//
// check-doc-links catches broken links. This catches a different class:
// links/text that are still *valid* but semantically stale or unsafe — the
// kind of drift that re-appears every time a feature is added. Each rule
// below encodes a lesson from a past regression so CI can stop it recurring.
//
// Rules are intentionally narrow and prose-scoped (code fences and <details>
// blocks are stripped before scanning) to avoid false positives on legitimate
// examples.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

const problems = [];
const fail = (rel, msg) => problems.push(`${rel}: ${msg}`);

// Strip fenced code blocks, <details> blocks, and inline code so rules scan
// only the visible beginner-facing prose.
function prose(text) {
  return text
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

// 1. The README quick tour must be runnable from a fresh install. A plain
//    `init` creates an empty roadmap, so `P1-T1` does not exist — the tour
//    must use `code-pact tutorial` and/or the sample `TUTORIAL-` tasks.
{
  const readme = read("README.md");
  if (!readme.includes("code-pact tutorial")) {
    fail("README.md", "quick tour must use `code-pact tutorial` (runs against a throwaway sandbox)");
  }
  if (readme.includes("P1-T1")) {
    fail("README.md", "`P1-T1` does not exist after a fresh `init` — use `TUTORIAL-T1` or `code-pact tutorial` in examples");
  }
}

// 2. The Japanese getting-started must not list dogfood.md as newcomer
//    "next reading" (it is a maintainer doc; EN dropped it).
{
  const ja = read("docs/ja/getting-started.md");
  if (/]\((\.\.\/)?dogfood\.md[)#]/.test(ja)) {
    fail("docs/ja/getting-started.md", "must not link dogfood.md (maintainer doc — keep it out of the newcomer path)");
  }
}

// 3. dogfood.md is a maintainer *quick* guide — keep it lean. Deep material
//    belongs in maintainers/operations.md.
{
  const lines = read("docs/dogfood.md").split("\n").length;
  const CAP = 180;
  if (lines > CAP) {
    fail("docs/dogfood.md", `is ${lines} lines (cap ${CAP}). Move detail to maintainers/operations.md`);
  }
}

// 4. The canonical per-task loop now lives in per-task-loop.md. The runbook
//    concept doc must not claim (present tense) that the sequence lives in
//    dogfood.
{
  const runbook = read("docs/concepts/runbook.md");
  if (/lives in [^.\n]*dogfood/i.test(runbook)) {
    fail("docs/concepts/runbook.md", 'must not say the loop "lives in dogfood" (present tense) — per-task-loop.md is the canonical source');
  }
}

// 5. getting-started (EN + JA) must teach `task finalize` as preview → apply
//    (dry-run is the default), matching per-task-loop.md.
for (const rel of ["docs/getting-started.md", "docs/ja/getting-started.md"]) {
  const body = read(rel);
  const hasPreview = body.includes("task finalize TUTORIAL-T1 --json");
  const hasApply = body.includes("task finalize TUTORIAL-T1 --write --json");
  if (!hasPreview || !hasApply) {
    fail(rel, "the TUTORIAL sample must show `task finalize TUTORIAL-T1 --json` (preview) then `--write --json` (apply)");
  }
}

// 6. Beginner-facing getting-started prose must not carry version/RFC noise
//    (feature-shipped-in tags and phase/RFC citations). Such detail belongs in
//    <details>, upgrading.md, or maintainers/operations.md. Scans prose only.
const NOISE = [
  { re: /\bPre-v\d/, label: "Pre-vX.Y version-history note" },
  { re: /\bP\d+-T\d+\b/, label: "phase-task RFC reference (e.g. P13-T3)" },
  { re: /\(v\d+\.\d+\+/, label: "feature-version tag (e.g. (v1.4+)" },
  { re: /\bP1[0-9]\b(?!-)/, label: "bare phase/RFC reference (e.g. P17)" },
];
for (const rel of ["docs/getting-started.md", "docs/ja/getting-started.md"]) {
  const text = prose(read(rel));
  for (const { re, label } of NOISE) {
    const m = text.match(re);
    if (m) {
      fail(rel, `beginner prose contains ${label}: "${m[0]}" — move to <details>, upgrading.md, or operations.md`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-doc-invariants: ${problems.length} issue(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("check-doc-invariants: OK — all semantic doc invariants hold.");
