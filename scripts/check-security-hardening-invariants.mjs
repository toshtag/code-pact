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

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function rel(abs) {
  return abs
    .replace(`${repoRoot}/`, "")
    .split(/[\\/]/)
    .join("/");
}

function actualRawImportFiles() {
  const files = new Set();
  const rawModulePattern =
    /(?:import|export)\s+(?!type\b)[^'"]*\s+from\s+["']([^"']+)["']/g;
  for (const file of walkTs(join(repoRoot, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(rawModulePattern)) {
      const specifier = match[1];
      if (
        specifier === "node:fs" ||
        specifier === "node:fs/promises" ||
        specifier.endsWith("raw-internal.ts")
      ) {
        files.add(rel(file));
      }
    }
  }
  return [...files].sort();
}

function runAuthorityFixture(name, lines) {
  const dir = mkdtempSync(join(repoRoot, ".tmp-security-hardening-"));
  const fixture = join(dir, `${name}.ts`);
  writeFileSync(fixture, `${lines.join("\n")}\n`, "utf8");
  try {
    execFileSync(
      "node",
      [join(repoRoot, "scripts/check-fs-authority.mjs"), fixture],
      { cwd: repoRoot, stdio: "pipe" },
    );
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const containedReadResolver = "resolveContained" + "ReadPath";
const containedWriteResolver = "resolveContained" + "WritePath";
const containedDeleteResolver = "resolveContained" + "DeletePath";

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
// 3. Raw fs import boundary — exact set, no file-level trusted return
// ---------------------------------------------------------------------------
console.log("\n=== 3. Raw fs import boundary ===");
{
  const checker = readFile("scripts/check-fs-authority.mjs");
  check(
    "RAW_FS_IMPORT_ALLOWLIST is defined",
    grepIn(checker, "RAW_FS_IMPORT_ALLOWLIST"),
  );
  check(
    "TRUSTED_FS_MODULES is removed",
    !grepIn(checker, "TRUSTED_FS_MODULES"),
  );
  check(
    "file-level authority early return is removed",
    !grepIn(checker, "isAuthorityModule\\("),
  );
  const expectedRawImportFiles = [
    "src/core/path-safety.ts",
    "src/core/project-fs/authority-resolvers.ts",
    "src/core/project-fs/operations.ts",
    "src/core/project-fs/raw-internal.ts",
    "src/io/atomic-text.ts",
    "src/lib/package-version.ts",
  ];
  const actual = actualRawImportFiles();
  check(
    "raw fs import file set matches exact allowlist",
    JSON.stringify(actual) === JSON.stringify(expectedRawImportFiles),
    `actual: ${actual.join(", ")}`,
  );
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
  const operations = readFile("src/core/project-fs/operations.ts");
  check(
    "readOwnedText uses fd no-follow reader, not readFileRaw",
    grepIn(operations, "readRegularOwnedTextRaw") &&
      !grepIn(operations, "readFileRaw\\(unbrand\\(path\\)"),
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
// 9. Allowlist is structured JSON with line numbers (no broad auto-approval)
// ---------------------------------------------------------------------------
console.log("\n=== 9. Allowlist ===");
{
  const allowlist = readFile(".code-pact/fs-authority-allowlist.json");
  const parsed = JSON.parse(allowlist);
  const keys = Object.keys(parsed);
  check("allowlist is valid JSON", keys.length > 0);
  let allHaveLine = true;
  for (const key of keys) {
    for (const entry of parsed[key]) {
      if (typeof entry.line !== "number") {
        allHaveLine = false;
        break;
      }
    }
    if (!allHaveLine) break;
  }
  check("all allowlist entries have numeric line field", allHaveLine);
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
  check(
    "generic resolver rejection tests present",
    grepIn(authTest, "generic contained read/write/delete resolver fixtures"),
  );
  check(
    "read-to-delete/write-open rejection tests present",
    grepIn(authTest, "read authority passed to delete and write-open"),
  );
  check(
    "namespace brand rejection test present",
    grepIn(authTest, "brand constructor namespace import"),
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
// 11. Negative fixture execution
// ---------------------------------------------------------------------------
console.log("\n=== 11. Negative fixture execution ===");
{
  check(
    "generic write fixture exits 1",
    runAuthorityFixture("generic-write", [
      `import { ${containedWriteResolver}, writeOwnedText } from "../src/core/project-fs/index.ts";`,
      "async function f(cwd, userPath) {",
      `  await writeOwnedText(await ${containedWriteResolver}(cwd, userPath), "x");`,
      "}",
    ]) === 1,
  );
  check(
    "raw-internal wildcard re-export fixture exits 1",
    runAuthorityFixture("raw-reexport", [
      'export * from "../src/core/project-fs/raw-internal.ts";',
    ]) === 1,
  );
  check(
    "namespace brand fixture exits 1",
    runAuthorityFixture("namespace-brand", [
      'import * as brands from "../src/core/project-fs/branded-paths-internal.ts";',
      'import { readOwnedText } from "../src/core/project-fs/index.ts";',
      "async function f(path) {",
      "  return readOwnedText(brands.brandOwnedRead(path));",
      "}",
    ]) === 1,
  );
  check(
    "read-to-delete fixture exits 1",
    runAuthorityFixture("read-delete", [
      'import { resolveProjectConfigReadPath, unlinkOwned } from "../src/core/project-fs/index.ts";',
      "async function f(cwd) {",
      "  await unlinkOwned(await resolveProjectConfigReadPath(cwd));",
      "}",
    ]) === 1,
  );
}

// ---------------------------------------------------------------------------
// 12. Documentation updated — design/decisions/**/*.md
// ---------------------------------------------------------------------------
console.log("\n=== 12. Documentation ===");
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
