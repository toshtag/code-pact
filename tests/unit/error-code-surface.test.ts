// Error-code surface lock.
//
// v1.0 P8-T3 contract freeze depends on the public error-code table in
// docs/cli-contract.md being an accurate reflection of what src/ actually
// emits. This test walks src/ for every `code: "<CONSTANT>"` literal,
// builds the de-facto surface, and compares it to the expected categorized
// table maintained below.
//
// When this test fails:
// - A new error code was added in src/ but not categorized here → add it
//   to KNOWN_CODES with the right category AND add a row to the public
//   error-code table in docs/cli-contract.md.
// - An error code was removed in src/ → remove it from KNOWN_CODES AND
//   update docs/cli-contract.md.
//
// The test does NOT enforce that docs/cli-contract.md is the authoritative
// source — it enforces that KNOWN_CODES below tracks src/. The docs are a
// human-readable view that contributors must keep in sync with this table.

import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const srcRoot = join(repoRoot, "src");

// All error/issue codes emitted by src/, grouped by their v1.0 public
// contract category. The category determines how they appear in
// docs/cli-contract.md.
//
// - "public":       Top-level error envelope codes returned to agents and
//                   CI as the primary failure signal. Stable surface.
//                   ADAPTER_MISSING lives here for v0.8 back-compat reasons
//                   (legacy global doctor still emits it on projects without
//                   a manifest).
// - "plan":         Plan integrity diagnostics emitted by plan lint /
//                   plan normalize / plan analyze. Issue-level codes carry
//                   severity error|warning.
// - "doctor":       Doctor / validate / adapter doctor issue codes.
//                   Severity error|warning.
// - "adapter":      Adapter-platform diagnostic codes (ADAPTER_*).
//                   Emitted by adapter doctor and (manifest-aware) global
//                   doctor. Severity error|warning.
// - "internal":     Reserved for unhandled exceptions and contract drift.
const KNOWN_CODES: Record<string, "public" | "plan" | "doctor" | "adapter" | "internal"> = {
  // Public
  AGENT_NOT_ENABLED: "public",
  AGENT_NOT_FOUND: "public",
  ALREADY_EXISTS: "public",
  ALREADY_INITIALIZED: "public",
  AMBIGUOUS_TASK_ID: "public",
  BASELINE_NOT_FOUND: "public",
  CONFIG_ERROR: "public",
  CONTEXT_OVER_BUDGET: "public",
  DUPLICATE_PHASE_ID: "public",
  INVALID_TASK_TRANSITION: "public",
  LOCK_HELD: "public",
  MANIFEST_NOT_FOUND: "public",
  PHASE_NOT_FOUND: "public",
  PHASE_RECONCILE_WRITE_REFUSED: "public",
  TASK_FINALIZE_NOT_ELIGIBLE: "public",
  TASK_FINALIZE_WRITE_REFUSED: "public",
  TASK_NOT_FOUND: "public",
  TUTORIAL_FAILED: "public",
  UNKNOWN_COMMAND: "public",
  VALIDATE_FAILED: "public",
  VERIFICATION_FAILED: "public",
  DOCTOR_FAILED: "public",
  PLAN_ANALYZE_FAILED: "public",
  PLAN_LINT_FAILED: "public",
  PLAN_NORMALIZE_CONFLICT: "public",
  PLAN_NORMALIZE_REQUIRED: "public",
  WRITES_AUDIT_STRICT_FAILED: "public",

  // Plan diagnostics (issue codes inside plan lint / plan analyze)
  DUPLICATE_TASK_ID: "plan",
  INVALID_YAML: "plan",
  MISSING_PHASE_FILE: "plan",
  ORPHAN_PHASE_FILE: "plan",
  ORPHAN_PROGRESS_EVENT: "plan",
  PHASE_DONE_WITH_OPEN_TASKS: "plan",
  PHASE_ID_MISMATCH: "plan",
  PHASE_ID_NAMING: "plan",
  PLACEHOLDER_VERIFICATION: "plan",
  SCHEMA_ERROR: "plan",
  STATUS_DRIFT: "plan",
  TASK_ID_PHASE_PREFIX: "plan",
  WEAK_DOD: "plan",

  // Plan clarify/readiness advisories added in P31 (all affects_exit: false,
  // surfaced under `plan lint --include-quality`).
  PHASE_CONFIDENCE_LOW: "plan",
  TASK_DECISION_UNRESOLVED: "plan",
  TASK_DESCRIPTION_MISSING: "plan",

  // Plan diagnostics added in P10 — Task Readiness Schema. All emitted
  // by `plan lint` against the new optional task fields declared in
  // design/decisions/task-readiness-schema-rfc.md.
  TASK_ACCEPTANCE_REF_NOT_FOUND: "plan",
  TASK_ACCEPTANCE_REF_UNSAFE_PATH: "plan",
  TASK_DECISION_REF_NOT_FOUND: "plan",
  TASK_DECISION_REF_UNSAFE_PATH: "plan",
  TASK_DEPENDS_ON_CYCLE: "plan",
  TASK_DEPENDS_ON_SELF_REFERENCE: "plan",
  TASK_DEPENDS_ON_UNRESOLVED: "plan",
  TASK_READS_GLOB_INVALID: "plan",
  TASK_READS_NO_MATCH: "plan",
  TASK_READS_UNSAFE_PATH: "plan",
  TASK_WRITES_AUDIT_DECLARED_UNUSED: "plan",
  TASK_WRITES_AUDIT_OUTSIDE_DECLARED: "plan",
  TASK_WRITES_GLOB_INVALID: "plan",
  TASK_WRITES_OVER_BROAD: "plan",
  TASK_WRITES_PROTECTED_PATH: "plan",
  TASK_WRITES_UNSAFE_PATH: "plan",

  // Doctor diagnostics (general project health)
  ADAPTER_STALE: "doctor",
  BAK_FILE: "doctor",
  BRIEF_MISSING: "doctor",
  CONSTITUTION_PLACEHOLDER: "doctor",
  EMPTY_OBJECTIVE: "doctor",
  LOCAL_NOT_GITIGNORED: "doctor",
  MISSING_DIR: "doctor",
  MISSING_MODEL_TIER: "doctor",
  STALE_CONTEXT: "doctor",

  // Adapter platform diagnostics (manifest-aware + legacy)
  ADAPTER_CONTRACT_DRIFT: "adapter",
  ADAPTER_DESIRED_STALE: "adapter",
  ADAPTER_FILE_DRIFT: "adapter",
  ADAPTER_FILE_MISSING: "adapter",
  ADAPTER_GENERATOR_STALE: "adapter",
  ADAPTER_MANIFEST_INVALID: "adapter",
  ADAPTER_MANIFEST_MISSING: "adapter",
  ADAPTER_MISSING: "adapter",
  ADAPTER_PROFILE_DRIFT: "adapter",
  ADAPTER_SCHEMA_DRIFT: "adapter",
  ADAPTER_UNMANAGED_FILE: "adapter",

  // Internal
  INTERNAL_ERROR: "internal",
};

// Emission patterns we recognize:
// 1. Object-literal shorthand:  { code: "PHASE_NOT_FOUND", ... }
// 2. Assignment via ErrnoException pattern:  (err as ...).code = "AMBIGUOUS_TASK_ID"
// 3. Router/normalization assignment:        outCode = "AGENT_NOT_ENABLED"
//    (these are codes the CLI passes through — they originate as #2 elsewhere
//     but the surface presented to agents is still UPPER_SNAKE_CASE)
// 4. Advisory warnings pushed into an envelope array (v1.6 P15-T1):
//    warnings.push("TASK_WRITES_AUDIT_OUTSIDE_DECLARED")
const EMISSION_PATTERNS: RegExp[] = [
  /\bcode:\s*"([A-Z][A-Z0-9_]+)"/g,
  /\.code\s*=\s*"([A-Z][A-Z0-9_]+)"/g,
  /\boutCode\s*=\s*"([A-Z][A-Z0-9_]+)"/g,
  /\bwarnings\.push\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
];

// Strings that look like UPPER_SNAKE_CASE error codes but aren't part of the
// v1.0 error-code surface (e.g. case labels for routing, internal enum
// values). Filter them out explicitly so the test diagnostics stay accurate.
//
// `MERGE_BASE_NOT_FOUND` / `REF_NOT_FOUND` are the diagnostic sub-codes
// emitted on `write_audit.base_error.code` — they live inside the
// advisory `write_audit` envelope and never propagate to top-level
// `error.code`, so they are deliberately out of the v1.0 public surface.
//
// `PHASE_VERIFY_COMMANDS_MISSHAPED` is a `phase import` advisory that lives
// inside the import envelope's `data.warnings[].code` array. Like the
// write_audit sub-codes above, it never propagates to top-level
// `error.code` and never affects the exit code, so it is deliberately out
// of the v1.0 public error-code table. It is documented under the
// `phase import` section of docs/cli-contract.md instead.
const NON_ERROR_CODES = new Set<string>([
  "MERGE_BASE_NOT_FOUND",
  "REF_NOT_FOUND",
  "PHASE_VERIFY_COMMANDS_MISSHAPED",
]);

async function walkSrc(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walkSrc(full)));
    } else if (e.isFile() && full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

async function collectCodes(): Promise<Set<string>> {
  const files = await walkSrc(srcRoot);
  const codes = new Set<string>();
  for (const f of files) {
    const text = await readFile(f, "utf8");
    for (const re of EMISSION_PATTERNS) {
      // matchAll needs a fresh iterator per pass; the /g RegExp is stateless
      // when consumed via matchAll, so no need to reset lastIndex.
      for (const m of text.matchAll(re)) {
        const code = m[1];
        if (!code || NON_ERROR_CODES.has(code)) continue;
        codes.add(code);
      }
    }
  }
  return codes;
}

describe("error code surface (v1.0 contract anchor)", () => {
  it("every code emitted by src/ is categorized in KNOWN_CODES", async () => {
    const found = await collectCodes();
    const expected = new Set(Object.keys(KNOWN_CODES));
    const missing = [...found].filter((c) => !expected.has(c)).sort();
    expect(missing, `New error code(s) found in src/ but not categorized in KNOWN_CODES. Add them here AND in docs/cli-contract.md.`).toEqual([]);
  });

  it("every code in KNOWN_CODES is still emitted somewhere in src/", async () => {
    const found = await collectCodes();
    const stale = Object.keys(KNOWN_CODES).filter((c) => !found.has(c)).sort();
    expect(stale, `Code(s) in KNOWN_CODES are no longer emitted by src/. Remove them here AND from docs/cli-contract.md.`).toEqual([]);
  });

  it("KNOWN_CODES has no duplicate categories per code", () => {
    // Object keys are inherently unique, but the test serves as a regression
    // guard if a contributor accidentally writes the same key twice (later
    // wins silently). Detected by re-reading the source of THIS file.
    const seen = new Set<string>();
    for (const k of Object.keys(KNOWN_CODES)) {
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });

  it("public + plan + doctor + adapter + internal partition is total", () => {
    const allowed = new Set(["public", "plan", "doctor", "adapter", "internal"]);
    for (const [code, cat] of Object.entries(KNOWN_CODES)) {
      expect(allowed.has(cat), `code ${code} has unknown category ${cat}`).toBe(true);
    }
  });
});
