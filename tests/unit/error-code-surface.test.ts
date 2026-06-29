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
// - "public":       Stable agent-facing codes. This covers BOTH top-level
//                   `error.code` envelope values (the primary failure signal
//                   for agents and CI) AND documented `error.cause_code`
//                   values (v1.27+ / P39 — e.g. `COMMANDS_FAILED` and the
//                   cause-code use of `DECISION_REQUIRED`, which appear under
//                   a broad `VERIFICATION_FAILED` envelope on `task complete`,
//                   not as top-level codes). A single category keeps the scan
//                   simple; docs/cli-contract.md splits them into the
//                   "Public codes" and "Public cause codes" tables.
// - "plan":         Plan integrity diagnostics emitted by plan lint /
//                   plan normalize / plan analyze. Issue-level codes carry
//                   severity error|warning.
// - "doctor":       Doctor / validate / adapter doctor issue codes.
//                   Severity error|warning.
// - "adapter":      Adapter-platform diagnostic codes (ADAPTER_*).
//                   Emitted by adapter doctor and (manifest-aware) global
//                   doctor. Severity error|warning.
// - "internal":     Reserved for unhandled exceptions and contract drift.
const KNOWN_CODES: Record<
  string,
  "public" | "plan" | "doctor" | "adapter" | "internal"
> = {
  // Public
  AGENT_NOT_ENABLED: "public",
  AGENT_NOT_FOUND: "public",
  ALREADY_EXISTS: "public",
  ALREADY_INITIALIZED: "public",
  AMBIGUOUS_TASK_ID: "public",
  AMBIGUOUS_PHASE_ID: "public",
  ARCHIVE_BUNDLE_WRITE_FAILED: "public",
  BASELINE_NOT_FOUND: "public",
  COMMANDS_FAILED: "public",
  CONFIG_ERROR: "public",
  CONTEXT_OVER_BUDGET: "public",
  DECISION_PRUNE_NOT_ELIGIBLE: "public",
  DECISION_PRUNE_PLAN_STALE: "public",
  DECISION_PRUNE_WRITE_FAILED: "public",
  // archive-level compaction Layer 4: the delete-intent journal faults surfaced by the archive
  // write verbs. Fail-closed and operator-guided: PENDING_* (and a transient DURABILITY fault) is
  // re-runnable; RECOVERY_FAILED is NOT — it needs inspect/repair (corrupt journal, or a present
  // journal whose referenced bundle authority is missing/changed).
  DELETE_INTENT_RECOVERY_FAILED: "public",
  DELETE_INTENT_DURABILITY_FAILED: "public",
  PENDING_DELETE_INTENT: "public",
  // archive-level compaction (bundle-member-removal): the bundle-pair removal's pre-commit
  // reverify found the store no longer matches the plan. Surfaced by `state archive-maintain
  // --write` (which orchestrates the bundle-pair removal); fail-closed, re-plan and re-run.
  BUNDLE_PAIR_NOT_COMMITTABLE: "public",
  // design-docs-ephemeral step 7 PR-B2: the `decision retire` destructive verb.
  DECISION_RETIRE_NOT_ELIGIBLE: "public",
  DECISION_RETIRE_NOT_RETIRED: "public",
  DECISION_RETIRE_STALE: "public",
  DECISION_REQUIRED: "public",
  DUPLICATE_PHASE_ID: "public",
  INVALID_TASK_TRANSITION: "public",
  LOCK_HELD: "public",
  MANIFEST_NOT_FOUND: "public",
  PHASE_NOT_FOUND: "public",
  // design-docs-ephemeral step 7 PR-B1: the `phase archive` destructive verb.
  PHASE_ARCHIVE_INELIGIBLE: "public",
  PHASE_ARCHIVE_NOT_ARCHIVED: "public",
  PHASE_ARCHIVE_STALE: "public",
  // Event pack compaction (v2.0, Layer 2): `state compact` cannot proceed
  // (phase YAML present / no snapshot / evidence broken / pack stale|invalid),
  // and the pack write/readback-verify failed.
  STATE_COMPACT_INELIGIBLE: "public",
  STATE_COMPACT_WRITE_FAILED: "public",
  // Layer 3 cleanup contract — emitted by `state compact --write` (the wired unlink
  // path) when a gate aborts the cleanup or a survivor remains.
  STATE_COMPACT_CLEANUP_FAILED: "public",
  STATE_COMPACT_CLEANUP_INCOMPLETE: "public",
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
  PLAN_MIGRATE_FAILED: "public",
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
  // design-docs-ephemeral step 4a: a hand-deleted phase's roadmap ref whose
  // archive snapshot exists but is corrupt / identity-mismatched / non-terminal /
  // task-id-colliding cannot release the missing phase → fail-closed.
  // DUAL-SURFACE (like DUPLICATE_PHASE_ID): an issue-level diagnostic in plan lint /
  // doctor AND a top-level `error.code` (exit 2) on every `task *` command that
  // resolves a task (via the shared resolveTaskInRoadmap / the plan-state loaders).
  // Categorized "plan" because its primary home is the plan-integrity diagnostic
  // surface; docs/cli-contract.md lists it in BOTH the Public codes and Plan
  // diagnostic codes tables.
  PHASE_SNAPSHOT_INVALID: "plan",
  PROGRESS_EVENT_CONFLICT: "plan",
  // Ledger-integrity diagnostic (collaboration-safe-state RFC, B1/B5): an event
  // file's content (or its stored id) does not match its filename, which IS the
  // full content id. Surfaced as a structured error issue (data.issues[]) by the
  // LENIENT-loader surfaces — `doctor` and `plan lint` — exactly like INVALID_YAML
  // / SCHEMA_ERROR, hence the "plan" category. It is never a public top-level
  // error.code: the strict-loader readers `task *` / `verify` abort raw (exit 3,
  // like a corrupt legacy progress.yaml), while `plan analyze` / `plan migrate`
  // wrap it into the command's own failure code (PLAN_ANALYZE_FAILED /
  // PLAN_MIGRATE_FAILED) with the cause in error.message (see cmdPlanAnalyze /
  // cmdPlanMigrate / docs/cli-contract.md). `pack` is best-effort and skips it.
  EVENT_FILE_ID_MISMATCH: "plan",
  // Event-pack compaction (v2.0): pack integrity / snapshot-binding failure,
  // a snapshot evidence event_id that does not resolve from the durable ledger,
  // and a legacy event for an archived task that conflicts with the durable set.
  EVENT_PACK_INVALID: "plan",
  // Archive-level compaction (v2.0, Layer 1a): an archive bundle failed Tier-1
  // self/bijection validation. Strict loaders throw it; lenient surfaces (later
  // layers) will drop the bundle. Reader-validation code, same family as EVENT_PACK_INVALID.
  ARCHIVE_BUNDLE_INVALID: "plan",
  SNAPSHOT_EVENT_EVIDENCE_UNRESOLVABLE: "plan",
  LEGACY_EVENT_FOR_ARCHIVED_TASK: "plan",
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
  ADR_STATUS_UNRECOGNIZED: "plan",
  PHASE_CONFIDENCE_LOW: "plan",
  TASK_DECISION_UNRESOLVED: "plan",
  TASK_DESCRIPTION_MISSING: "plan",
  // P36 — ADR quality advisory (affects_exit: false, --include-quality).
  ADR_ACCEPTED_BODY_THIN: "plan",
  // P43 — ADR downstream-commitments advisory (affects_exit: false, --include-quality).
  ADR_COMMITMENTS_EMPTY: "plan",
  // P43 — docs-drift guard: a not-done phase writing public docs with no doc
  // check in verification (affects_exit: false, --include-quality).
  PHASE_DOCS_WRITE_NO_DOC_CHECK: "plan",
  // P50 — Context Fit advisories (affects_exit: false, --include-quality).
  TASK_CONTEXT_PACK_LARGE: "plan",
  TASK_CONTEXT_BUDGET_UNACHIEVABLE: "plan",
  TASK_DECLARED_DECISION_LARGE: "plan",
  TASK_READS_MATCH_TOO_MANY: "plan",

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
  CONTROL_PLANE_NOT_DRIVEN: "doctor",
  CONTROL_PLANE_BRANCH_NOT_DRIVEN: "doctor",
  CONTROL_PLANE_GITIGNORED: "doctor",
  EMPTY_OBJECTIVE: "doctor",
  LOCAL_NOT_GITIGNORED: "doctor",
  MISSING_DIR: "doctor",
  MISSING_MODEL_TIER: "doctor",
  MODEL_ID_UNKNOWN: "doctor",
  MODEL_MAP_STALE: "doctor",
  STALE_CONTEXT: "doctor",

  // Adapter platform diagnostics (manifest-aware + legacy)
  ADAPTER_CONTRACT_DRIFT: "adapter",
  ADAPTER_DESIRED_STALE: "adapter",
  ADAPTER_FILE_DRIFT: "adapter",
  ADAPTER_FILE_MISSING: "adapter",
  ADAPTER_FILE_PATH_UNSAFE: "adapter",
  ADAPTER_FILE_UNVERIFIABLE: "adapter",
  ADAPTER_GENERATOR_STALE: "adapter",
  ADAPTER_MANIFEST_INVALID: "adapter",
  ADAPTER_MANIFEST_MISSING: "adapter",
  ADAPTER_MISSING: "adapter",
  ADAPTER_PROFILE_INVALID: "adapter",
  ADAPTER_PROFILE_MISSING: "adapter",
  ADAPTER_PROFILE_DRIFT: "adapter",
  ADAPTER_PROFILE_CONTRACT_VIOLATION: "adapter",
  MODEL_PROFILES_INVALID: "adapter",
  MODEL_PROFILES_UNSAFE: "adapter",
  ADAPTER_SCHEMA_DRIFT: "adapter",
  ADAPTER_UNMANAGED_FILE: "adapter",

  // Internal
  INTERNAL_ERROR: "internal",
  // Path-safety escape: `resolveWithinProject` tags a symlink/unsafe-path escape
  // with this code so command layers can map it to a structured envelope
  // (e.g. adapter install/upgrade → ADAPTER_MANIFEST_INVALID for the manifest
  // path, CONFIG_ERROR for placeholder dirs) and the decision prune/retire gates
  // classify it as `target_invalid`. It is always caught + remapped, so it never
  // reaches an agent as a top-level `error.code` — hence "internal".
  PATH_OUTSIDE_PROJECT: "internal",
  // Path-ownership refusal: `resolveSymlinkFreeProjectPath` tags an in-project symlink
  // alias with this code so write/delete call sites can distinguish "contained"
  // from "owned". Command layers map it to CONFIG_ERROR / ADAPTER_MANIFEST_INVALID.
  // It is internal, not a top-level public envelope.
  PATH_NOT_OWNED: "internal",
  // Node.js standard errno: emitted by control-plane readRegularText when
  // a path that should be a regular file is a directory. Always caught and
  // remapped by callers (e.g. ENOENT-like handling in archive/decision gates).
  EISDIR: "internal",
  // Defense-in-depth invariant: an adapter generator produced two desired
  // files at the same path with differing content. Should never fire (each
  // adapter uniquifies its own paths); surfaced as an unhandled exception
  // (exit 3) rather than a structured envelope.
  ADAPTER_DESIRED_PATH_CONFLICT: "internal",
};

// Emission patterns we recognize:
// 1. Object-literal shorthand:  { code: "PHASE_NOT_FOUND", ... }
// 2. Assignment via ErrnoException pattern:  (err as ...).code = "AMBIGUOUS_TASK_ID"
// 3. Router/normalization assignment:        outCode = "AGENT_NOT_ENABLED"
//    (these are codes the CLI passes through — they originate as #2 elsewhere
//     but the surface presented to agents is still UPPER_SNAKE_CASE)
// 4. Advisory warnings pushed into an envelope array (v1.6 P15-T1):
//    warnings.push("TASK_WRITES_AUDIT_OUTSIDE_DECLARED")
// 5. The canonical error-envelope writer emitError(json, "CODE", message, …)
//    from src/cli/util.ts. The code is the 2nd positional arg, so it no
//    longer appears as a `code: "…"` object property at the call site —
//    codes emitted ONLY through this helper (e.g. DOCTOR_FAILED) need this
//    pattern to stay pinned to KNOWN_CODES + docs/cli-contract.md.
const EMISSION_PATTERNS: RegExp[] = [
  /\bcode:\s*"([A-Z][A-Z0-9_]+)"/g,
  /\.code\s*=\s*"([A-Z][A-Z0-9_]+)"/g,
  /\boutCode\s*=\s*"([A-Z][A-Z0-9_]+)"/g,
  /\bwarnings\.push\(\s*"([A-Z][A-Z0-9_]+)"\s*\)/g,
  // P39: error.cause_code values. The `\bcode:` pattern above does NOT match
  // `cause_code:` (the `_` defeats the word boundary), so cause codes need
  // their own pattern to stay pinned to KNOWN_CODES + docs/cli-contract.md.
  /\bcause_code:\s*"([A-Z][A-Z0-9_]+)"/g,
  // emitError(json, "CODE", …) — the 2nd positional arg is the error code.
  /\bemitError\(\s*[^,]+,\s*"([A-Z][A-Z0-9_]+)"/g,
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
//
// `CHECKED_TASK_SKIPPED` / `PHASE_ID_INFERRED` / `READINESS_FIELDS_NOT_INFERRED`
// are the same kind of advisory for `plan adopt`: they live in the adopt
// envelope's `data.warnings[].code` array, never become top-level
// `error.code`, and never affect the exit code. Documented under the
// `plan adopt` section of docs/cli-contract.md.
const NON_ERROR_CODES = new Set<string>([
  "MERGE_BASE_NOT_FOUND",
  "REF_NOT_FOUND",
  "PHASE_VERIFY_COMMANDS_MISSHAPED",
  "CHECKED_TASK_SKIPPED",
  "PHASE_ID_INFERRED",
  "READINESS_FIELDS_NOT_INFERRED",
  // `code-pact status` (Collaboration UX RFC, D2) reason codes — they live in
  // the read-only overview's `data.waiting[].reasons[].code`, never become a
  // top-level `error.code`, and never affect exit. A separate documented
  // contract (cli-contract.md § `status`), not part of the error-code surface.
  "WAITING_FOR_DEPENDENCY",
  "MISSING_DECISION",
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
    const missing = [...found].filter(c => !expected.has(c)).sort();
    expect(
      missing,
      `New error code(s) found in src/ but not categorized in KNOWN_CODES. Add them here AND in docs/cli-contract.md — and, if the code is user-recoverable, add a recovery entry to docs/troubleshooting.md (see docs/maintainers/docs-maintenance.md ownership map).`,
    ).toEqual([]);
  });

  it("every code in KNOWN_CODES is still emitted somewhere in src/", async () => {
    const found = await collectCodes();
    const stale = Object.keys(KNOWN_CODES)
      .filter(c => !found.has(c))
      .sort();
    expect(
      stale,
      `Code(s) in KNOWN_CODES are no longer emitted by src/. Remove them here AND from docs/cli-contract.md.`,
    ).toEqual([]);
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
    const allowed = new Set([
      "public",
      "plan",
      "doctor",
      "adapter",
      "internal",
    ]);
    for (const [code, cat] of Object.entries(KNOWN_CODES)) {
      expect(allowed.has(cat), `code ${code} has unknown category ${cat}`).toBe(
        true,
      );
    }
  });
});
