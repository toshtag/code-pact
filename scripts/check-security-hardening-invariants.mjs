#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-security-hardening-invariants.mjs
//
// Verifies all completion invariants for the security hardening initiative.
// Each check is a structural / textual assertion on the codebase that must
// hold at CI time. Exits 0 only when every invariant passes.
//
// Run: node scripts/check-security-hardening-invariants.mjs
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures++;
  }
}

function readFile(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function fileExists(rel) {
  return existsSync(join(repoRoot, rel));
}

function grepIn(content, pattern) {
  return new RegExp(pattern).test(content);
}

// ---------------------------------------------------------------------------
// 1. Branded filesystem API — raw fs primitives NOT exported from index
// ---------------------------------------------------------------------------
console.log("\n=== 1. Branded filesystem API ===");
{
  const index = readFile("src/core/project-fs/index.ts");
  check(
    "index.ts does not export raw fs primitives",
    !grepIn(index, "export\\s+\\*\\s+from\\s+['\"]\\./raw-internal"),
    "raw-internal wildcard export found",
  );
  check(
    "index.ts exports branded operations",
    grepIn(index, "readOwnedText|writeOwnedText|removeOwned"),
  );
  check(
    "index.ts exports authority resolvers",
    grepIn(index, "resolveDecision|resolveAgentProfile|resolveAndBrand"),
  );
}

// ---------------------------------------------------------------------------
// 2. owned-read.ts deprecated — no active exports
// ---------------------------------------------------------------------------
console.log("\n=== 2. owned-read.ts deprecated ===");
{
  const ownedRead = readFile("src/core/project-fs/owned-read.ts");
  check(
    "owned-read.ts is deprecated",
    grepIn(ownedRead, "@deprecated|deprecated"),
  );
}

// ---------------------------------------------------------------------------
// 3. TRUSTED_FS_MODULES — limited set
// ---------------------------------------------------------------------------
console.log("\n=== 3. TRUSTED_FS_MODULES scope ===");
{
  const checker = readFile("scripts/check-fs-authority.mjs");
  check("TRUSTED_FS_MODULES is defined", grepIn(checker, "TRUSTED_FS_MODULES"));
  // The 7 core trusted modules per the plan (checked via join() fragments)
  const expectedCore = [
    "raw-internal.ts",
    "operations.ts",
    "authority-resolvers.ts",
    "branded-paths-internal.ts",
    "control-plane.ts",
    "path-safety.ts",
    "atomic-text.ts",
  ];
  for (const file of expectedCore) {
    check(`TRUSTED_FS_MODULES includes ${file}`, grepIn(checker, file));
  }
}

// ---------------------------------------------------------------------------
// 4. Authority checker scans full src directory
// ---------------------------------------------------------------------------
console.log("\n=== 4. Authority checker discovery ===");
{
  const checker = readFile("scripts/check-fs-authority.mjs");
  check("checker walks src/ recursively", grepIn(checker, "walkTs"));
  check(
    "checker discovers all .ts files under src/",
    grepIn(checker, 'join\\("src"\\)'),
  );
  // Phase 4.1: allowlist line field is required (no function-wide auto-approval)
  check(
    "allowlist requires typeof aEntry.line === number",
    grepIn(checker, 'typeof aEntry\\.line === "number"'),
  );
  check(
    "allowlist does NOT use optional line (!aEntry.line)",
    !grepIn(checker, "!aEntry\\.line"),
  );
}

// ---------------------------------------------------------------------------
// 5. DecisionRefPath — single source of truth
// ---------------------------------------------------------------------------
console.log("\n=== 5. DecisionRefPath validator ===");
{
  const schema = readFile("src/core/schemas/decision-ref.ts");
  check(
    "NON_DECISION_BASENAMES uses toLocaleLowerCase",
    grepIn(schema, "toLocaleLowerCase"),
  );
  check(
    "FORBIDDEN_DECISION_SEGMENT includes control chars",
    grepIn(schema, "\\\\u0000-\\\\u001f"),
  );
  check("FORBIDDEN_DECISION_SEGMENT includes pipe", grepIn(schema, "\\|"));
  check("FORBIDDEN_DECISION_SEGMENT includes backtick", grepIn(schema, "`"));
  check("FORBIDDEN_DECISION_SEGMENT includes hash", grepIn(schema, "#"));
  check(
    "normalizeDecisionRefPath is exported",
    grepIn(schema, "export function normalizeDecisionRefPath"),
  );
  check(
    "DecisionRefPath schema is exported",
    grepIn(schema, "export const DecisionRefPath"),
  );
}

// ---------------------------------------------------------------------------
// 6. pruned-ledger.ts uses unified normalization
// ---------------------------------------------------------------------------
console.log("\n=== 6. pruned-ledger unified normalization ===");
{
  const ledger = readFile("src/core/decisions/pruned-ledger.ts");
  check(
    "pruned-ledger imports normalizeDecisionRefPath",
    grepIn(ledger, "normalizeDecisionRefPath"),
  );
  check(
    "pruned-ledger throws on invalid path (no silent fallback)",
    grepIn(ledger, "throw") && !grepIn(ledger, "return null.*fallback"),
  );
}

// ---------------------------------------------------------------------------
// 7. Symlink-safe read — O_NOFOLLOW
// ---------------------------------------------------------------------------
console.log("\n=== 7. Symlink-safe read ===");
{
  const rawInternal = readFile("src/core/project-fs/raw-internal.ts");
  check(
    "raw-internal exports readRegularOwnedText",
    grepIn(rawInternal, "readRegularOwnedText"),
  );
  check(
    "readRegularOwnedText uses O_NOFOLLOW",
    grepIn(rawInternal, "O_NOFOLLOW"),
  );
}

// ---------------------------------------------------------------------------
// 8. Exclusive create — atomicCreateTextExclusive
// ---------------------------------------------------------------------------
console.log("\n=== 8. Exclusive create ===");
{
  const atomic = readFile("src/io/atomic-text.ts");
  check(
    "atomicCreateTextExclusive is exported",
    grepIn(atomic, "export async function atomicCreateTextExclusive"),
  );
  check("uses link() as publish primitive", grepIn(atomic, "link\\("));
  check("throws EEXIST on conflict (no overwrite)", grepIn(atomic, "EEXIST"));

  const scaffold = readFile("src/core/decisions/scaffold.ts");
  check(
    "scaffold uses atomicCreateTextExclusive",
    grepIn(scaffold, "atomicCreateTextExclusive"),
  );
}

// ---------------------------------------------------------------------------
// 9. Allowlist is empty (call-site granular, no broad auto-approval)
// ---------------------------------------------------------------------------
console.log("\n=== 9. Allowlist ===");
{
  const allowlist = readFile(".code-pact/fs-authority-allowlist.json");
  check(
    "allowlist is empty",
    allowlist.trim() === "{}" || allowlist.trim() === "",
  );
}

// ---------------------------------------------------------------------------
// 10. Tests exist for security hardening
// ---------------------------------------------------------------------------
console.log("\n=== 10. Test coverage ===");
{
  check(
    "decision-ref.test.ts exists",
    fileExists("tests/unit/schemas/decision-ref.test.ts"),
  );
  check(
    "atomic-text.test.ts exists",
    fileExists("tests/unit/io/atomic-text.test.ts"),
  );
  check(
    "check-fs-authority.test.ts exists",
    fileExists("tests/unit/scripts/check-fs-authority.test.ts"),
  );
  check(
    "adr.test.ts exists",
    fileExists("tests/unit/core/decisions/adr.test.ts"),
  );
  check(
    "decision-prune.test.ts exists",
    fileExists("tests/integration/decision-prune.test.ts"),
  );

  // Phase 9.2: case-insensitive tests
  const decRefTest = readFile("tests/unit/schemas/decision-ref.test.ts");
  check(
    "case-insensitive README/PRUNED tests present",
    grepIn(decRefTest, "case-insensitive") && grepIn(decRefTest, "ReadMe"),
  );
  check(
    "control character reject tests present",
    grepIn(decRefTest, "control character"),
  );

  // Phase 9.6: concurrency tests
  const atomicTest = readFile("tests/unit/io/atomic-text.test.ts");
  check(
    "atomicCreateTextExclusive tests present",
    grepIn(atomicTest, "atomicCreateTextExclusive"),
  );
  check(
    "concurrent writer test present",
    grepIn(atomicTest, "concurrent") ||
      grepIn(atomicTest, "Promise.allSettled"),
  );

  // Phase 9.1: authority checker tests
  const authTest = readFile("tests/unit/scripts/check-fs-authority.test.ts");
  check(
    "raw-internal import rejection test present",
    grepIn(authTest, "raw-internal import"),
  );
  check(
    "node:fs import rejection test present",
    grepIn(authTest, "node:fs import"),
  );

  // Phase 9.3: nested decision gate tests
  const adrTest = readFile("tests/unit/core/decisions/adr.test.ts");
  check(
    "nested decision gate tests present",
    grepIn(adrTest, "nested decision_refs"),
  );

  // Phase 9.5: nested prune integration tests
  const pruneTest = readFile("tests/integration/decision-prune.test.ts");
  check(
    "nested prune integration tests present",
    grepIn(pruneTest, "nested decision paths"),
  );

  // Phase 9.7: nested retire integration tests
  check(
    "decision-retire.test.ts exists",
    fileExists("tests/integration/decision-retire.test.ts"),
  );
  const retireTest = readFile("tests/integration/decision-retire.test.ts");
  check(
    "nested retire integration tests present",
    grepIn(retireTest, "nested decision paths"),
  );

  // Phase 9.8: expanded authority checker tests
  check(
    "raw-internal re-export rejection test present",
    grepIn(authTest, "raw-internal re-exports"),
  );
  check(
    "node:fs namespace import rejection test present",
    grepIn(authTest, "node:fs namespace"),
  );

  // Phase 9.9: nested quality scan tests
  check(
    "nested quality scan tests present",
    grepIn(adrTest, "nested quality scan"),
  );
  check(
    "same basename distinct parent test present",
    grepIn(adrTest, "same basename"),
  );

  // Phase 9.10: nested filename-scan tests
  check(
    "nested filename-scan tests present",
    grepIn(adrTest, "nested filename-scan"),
  );

  // Phase 9.11: directory-list EACCES → DECISION_SCAN_UNREADABLE tests
  check(
    "directory-list EACCES tests present",
    grepIn(adrTest, "directory-list EACCES"),
  );
  check(
    "DECISION_SCAN_UNREADABLE propagation test present",
    grepIn(adrTest, "DECISION_SCAN_UNREADABLE"),
  );

  // Phase 9.12: nested inbound link rewrite test
  check(
    "nested inbound link rewrite test present",
    grepIn(pruneTest, "nested decision --write rewrites inbound links"),
  );

  // Phase 9.13: nested archive fallback + live nested unsafe path tests
  const gateArchiveTest = readFile(
    "tests/unit/core/decisions/decision-gate-archive.test.ts",
  );
  check(
    "nested archive fallback exact match tests present",
    grepIn(gateArchiveTest, "nested archive fallback"),
  );
  check(
    "live nested unsafe path never falls back test present",
    grepIn(gateArchiveTest, "live nested unsafe path never falls back"),
  );
}

// ---------------------------------------------------------------------------
// 11. Documentation updated — design/decisions/**/*.md
// ---------------------------------------------------------------------------
console.log("\n=== 11. Documentation ===");
{
  const lifecycle = readFile("docs/concepts/design-doc-lifecycle.md");
  check(
    "design-doc-lifecycle uses **/*.md",
    grepIn(lifecycle, "design/decisions/\\*\\*/\\*\\.md"),
  );

  const docsMaint = readFile("docs/maintainers/docs-maintenance.md");
  check(
    "docs-maintenance uses **/*.md",
    grepIn(docsMaint, "design/decisions/\\*\\*/\\*\\.md"),
  );

  const constitution = readFile("design/constitution.md");
  check(
    "constitution uses **/*.md",
    grepIn(constitution, "design/decisions/\\*\\*/\\*\\.md"),
  );

  const readme = readFile("design/decisions/README.md");
  check(
    "decisions README uses **/*.md",
    grepIn(readme, "design/decisions/\\*\\*/\\*\\.md"),
  );

  const positioning = readFile("docs/positioning.md");
  check(
    "positioning uses **/*.md",
    grepIn(positioning, "design/decisions/\\*\\*/\\*\\.md"),
  );

  const cliContract = readFile("docs/cli-contract.md");
  check(
    "cli-contract uses **/*.md",
    grepIn(cliContract, "design/decisions/\\*\\*/\\*\\.md"),
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n=== Summary ===");
if (failures === 0) {
  console.log("All security hardening invariants verified ✓");
  process.exit(0);
} else {
  console.error(`${failures} invariant(s) failed ✗`);
  process.exit(1);
}
