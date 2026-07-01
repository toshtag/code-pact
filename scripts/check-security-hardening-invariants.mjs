#!/usr/bin/env node
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

function read(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function rel(abs) {
  return abs
    .replace(`${repoRoot}/`, "")
    .split(/[\\/]/)
    .join("/");
}

const AUTHORITY_MODULES = [
  "src/core/project-fs/authorities/adapter-authority.ts",
  "src/core/project-fs/authorities/archive-authority.ts",
  "src/core/project-fs/authorities/context-output-authority.ts",
  "src/core/project-fs/authorities/decision-authority.ts",
  "src/core/project-fs/authorities/normalize-authority.ts",
  "src/core/project-fs/authorities/phase-authority.ts",
  "src/core/project-fs/authorities/profile-authority.ts",
  "src/core/project-fs/authorities/project-config-authority.ts",
  "src/core/project-fs/authorities/prune-authority.ts",
  "src/core/project-fs/authorities/temporary-sandbox-authority.ts",
];

const BRAND_IMPORT_EXPECTED = [
  ...AUTHORITY_MODULES,
  "src/core/project-fs/authority-resolvers.ts",
].sort();

const FORBIDDEN_API_NAMES = [
  `resolveInit${"Read"}Path`,
  `resolveInit${"Write"}Path`,
  `resolveInit${"List"}Path`,
  `resolveAdapterStatic${"Read"}Path`,
  `openOwned${"Write"}`,
  `mkdtemp${"Owned"}`,
  `removeOwned${"Path"}`,
  `readOwnedFile${"Sync"}`,
  `realpathOwned${"Sync"}`,
];

function hasForbiddenApiName(text) {
  return FORBIDDEN_API_NAMES.some(name => text.includes(name));
}

function actualBrandConstructorImportFiles() {
  const files = new Set();
  const importPattern =
    /import\s+(?!type\b)(?:\{([^}]+)\}|\*\s+as\s+\w+)\s+from\s+["']([^"']*branded-paths-internal\.ts)["']/g;
  const brandPattern =
    /\bbrand(Contained|OwnedRead|OwnedWrite|OwnedDelete|OwnedList|ExplicitUserRead|TemporarySandbox)\b/;
  for (const file of walkTs(join(repoRoot, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      if (match[0].includes("* as") || brandPattern.test(match[1] ?? "")) {
        files.add(rel(file));
      }
    }
  }
  return [...files].sort();
}

function actualRawImportFiles() {
  const files = new Set();
  const rawPattern =
    /(?:import|export)\s+(?!type\b)[^'"]*\s+from\s+["']([^"']+)["']/g;
  for (const file of walkTs(join(repoRoot, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(rawPattern)) {
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

function runFixture(name, relPath, source) {
  const dir = mkdtempSync(join(repoRoot, ".tmp-security-hardening-"));
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, `${source.trim()}\n`, "utf8");
  try {
    execFileSync("node", [join(repoRoot, "scripts/check-fs-authority.mjs"), path], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChecker() {
  try {
    execFileSync("node", [join(repoRoot, "scripts/check-fs-authority.mjs")], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return typeof err.status === "number" ? err.status : 1;
  }
}

console.log("\n=== 1. Public API Surface ===");
{
  const index = read("src/core/project-fs/index.ts");
  check("project-fs/index.ts has no forbidden API", !hasForbiddenApiName(index));
  check(
    "project-fs/index.ts does not export FileHandle",
    !/\bFileHandle\b/.test(index),
  );
  check(
    "operations.ts has no arbitrary open/write temp API",
    !hasForbiddenApiName(read("src/core/project-fs/operations.ts")),
  );
}

console.log("\n=== 2. Brand Constructor Provenance ===");
{
  const actual = actualBrandConstructorImportFiles();
  check(
    "brand constructor import file set matches authority modules",
    JSON.stringify(actual) === JSON.stringify(BRAND_IMPORT_EXPECTED),
    `actual: ${actual.join(", ")}`,
  );
}

console.log("\n=== 3. Raw FS Boundary ===");
{
  const expected = [
    "src/core/path-safety.ts",
    "src/core/project-fs/authorities/temporary-sandbox-authority.ts",
    "src/core/project-fs/authority-resolvers.ts",
    "src/core/project-fs/operations.ts",
    "src/core/project-fs/raw-internal.ts",
    "src/io/atomic-text.ts",
    "src/lib/package-version.ts",
  ];
  const actual = actualRawImportFiles();
  check(
    "raw fs import file set matches exact allowlist",
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual: ${actual.join(", ")}`,
  );
}

console.log("\n=== 4. Safe Read ===");
{
  const raw = read("src/core/project-fs/raw-internal.ts");
  const operations = read("src/core/project-fs/operations.ts");
  check("async read uses O_NOFOLLOW", /O_NOFOLLOW/.test(raw));
  check("sync read uses O_NOFOLLOW + fstat", /readRegularOwnedTextSync/.test(raw) && /fstatSyncRaw/.test(raw));
  check(
    "operations has no unsafe readFileSync(unbrand(path))",
    !/readFileSyncRaw\(unbrand\(path\)/.test(operations),
  );
}

console.log("\n=== 5. PhasePath Single Source ===");
{
  check("PhasePath schema exists", existsSync(join(repoRoot, "src/core/schemas/phase-path.ts")));
  check(
    "roadmap uses PhasePath",
    /path:\s*PhasePath/.test(read("src/core/schemas/roadmap.ts")),
  );
  check(
    "phase snapshot uses PhasePath",
    /original_path:\s*PhasePath/.test(read("src/core/schemas/phase-snapshot.ts")),
  );
  check(
    "authority resolver uses isPhasePath",
    /isPhasePath/.test(read("src/core/project-fs/authority-resolvers.ts")),
  );
}

console.log("\n=== 6. Malicious Fixtures ===");
{
  const fixtures = [
    {
      name: "generic-project-read",
      relPath: "src/core/pack/index.ts",
      source: `
        import { ${`resolveInit${"Read"}Path`}, readOwnedText } from "../src/core/project-fs/index.ts";
        export async function f(cwd, userPath) {
          return readOwnedText(await ${`resolveInit${"Read"}Path`}(cwd, userPath));
        }
      `,
    },
    {
      name: "generic-project-write",
      relPath: "src/core/plan/normalize.ts",
      source: `
        import { ${`resolveInit${"Write"}Path`}, writeOwnedText } from "../src/core/project-fs/index.ts";
        export async function f(cwd, userPath) {
          await writeOwnedText(await ${`resolveInit${"Write"}Path`}(cwd, userPath), "x");
        }
      `,
    },
    {
      name: "write-capability-read",
      relPath: "src/core/archive/delete-intent-journal.ts",
      source: `
        import { ${`openOwned${"Write"}`} } from "../src/core/project-fs/index.ts";
        export async function f(writePath) {
          const h = await ${`openOwned${"Write"}`}(writePath, "r");
          return h.readFile("utf8");
        }
      `,
    },
    {
      name: "external-mkdtemp",
      relPath: "src/commands/tutorial.ts",
      source: `
        import { ${`mkdtemp${"Owned"}`} } from "../src/core/project-fs/index.ts";
        export async function f(prefix) {
          await ${`mkdtemp${"Owned"}`}(prefix);
        }
      `,
    },
    {
      name: "self-brand-former-domain",
      relPath: "src/core/pack/index.ts",
      source: `
        import { brandOwnedWrite } from "../src/core/project-fs/branded-paths-internal.ts";
        import { atomicWriteText } from "../src/io/atomic-text.ts";
        export async function f(userPath) {
          await atomicWriteText(brandOwnedWrite(userPath), "x");
        }
      `,
    },
  ];

  for (const fixture of fixtures) {
    check(`${fixture.name} exits 1`, runFixture(fixture.name, fixture.relPath, fixture.source) === 1);
  }
}

console.log("\n=== 7. Checker Execution ===");
{
  check("check-fs-authority exits 0 on repository", runChecker() === 0);
  const checker = read("scripts/check-fs-authority.mjs");
  check(
    "checker rejects forbidden public FS API imports",
    /FORBIDDEN_PUBLIC_FS_API_IMPORTS/.test(checker),
  );
  check(
    "checker does not trust removed init/static resolvers",
    !checker
      .replace(/FORBIDDEN_PUBLIC_FS_API_IMPORTS[\s\S]*?\]\);/, "")
      .includes(`resolveInit${"Read"}Path`) &&
      !checker.includes(`resolveAdapterStatic${"Read"}Path`),
  );
}

console.log("\n=== Summary ===");
if (failures === 0) {
  console.log("All security hardening invariants verified ✓");
  process.exit(0);
}
console.error(`${failures} invariant(s) failed ✗`);
process.exit(1);
