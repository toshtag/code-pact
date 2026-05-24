import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupportedAgent } from "../core/agents.ts";
import {
  ACTIVATION_RULE_ANCHORS,
  ADAPTER_CONTRACT_HARDENING_FROM_VERSION,
  AGENT_CONTRACT_AXIS_HEADINGS,
  AGENT_CONTRACT_SECTION_HEADING,
  CONTRACT_ANTIPATTERNS,
  DIAGNOSTIC_REQUIRED_SURFACES,
  LIFECYCLE_REQUIRED_SURFACES,
  PRIMARY_ENTRYPOINT_SURFACE,
  PRIMARY_PRECEDES_SURFACES,
  REQUIRED_FAILURE_GUIDANCE,
} from "../core/adapters/conformance-spec.ts";
import { readManifest } from "../core/adapters/manifest.ts";
import type {
  AdapterManifest,
  ManifestFile,
} from "../core/schemas/adapter-manifest.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdapterConformanceOptions = {
  cwd: string;
  agentName: SupportedAgent;
};

export type ConformanceCheckStatus = "pass" | "fail";

/**
 * P30: a check is either `required` (a failure makes the adapter
 * non-compliant) or `advisory` (a failure is surfaced as a warning but
 * keeps `compliant: true`). Existing v1.11+ checks are `required`; the
 * P30 hardening checks resolve their severity from the manifest
 * `generator_version` (see `resolveHardeningSeverity`).
 */
export type ConformanceSeverity = "required" | "advisory";

export type ConformanceCheck = {
  id: string;
  status: ConformanceCheckStatus;
  severity: ConformanceSeverity;
  /** Project-relative path of the file the check inspected, when applicable. */
  file?: string;
  /** Check-specific structured detail (missing items, paths, etc.). */
  details?: Record<string, unknown>;
};

export type AdapterConformanceResult = {
  agent: SupportedAgent;
  compliant: boolean;
  checks: ConformanceCheck[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findInstructionFile(manifest: AdapterManifest): ManifestFile | null {
  return manifest.files.find((f) => f.role === "instruction") ?? null;
}

/**
 * LF-normalized UTF-8 sha256 — the same hash shape the install /
 * upgrade path writes to the manifest, so a direct equality compare
 * against `ManifestFile.sha256` is the contract.
 */
function hashContent(content: string): string {
  const normalised = content.replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

function pass(
  id: string,
  file?: string,
  details?: Record<string, unknown>,
  severity: ConformanceSeverity = "required",
): ConformanceCheck {
  const c: ConformanceCheck = { id, status: "pass", severity };
  if (file !== undefined) c.file = file;
  if (details !== undefined) c.details = details;
  return c;
}

function fail(
  id: string,
  file?: string,
  details?: Record<string, unknown>,
  severity: ConformanceSeverity = "required",
): ConformanceCheck {
  const c: ConformanceCheck = { id, status: "fail", severity };
  if (file !== undefined) c.file = file;
  if (details !== undefined) c.details = details;
  return c;
}

// ---------------------------------------------------------------------------
// P30 — hardening checks (pure, exported for unit testing)
// ---------------------------------------------------------------------------

/** Parse the `major.minor.patch` core of a version, ignoring build/prerelease. */
function parseVersionCore(v: string): [number, number, number] | null {
  const core = (v.split("+")[0] ?? "").split("-")[0] ?? "";
  const parts = core.split(".");
  if (parts.length < 3) return null;
  const nums = parts.slice(0, 3).map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/**
 * `a >= b` by semver core, with a prerelease of an equal core ordered
 * below the release (so `1.14.0-rc.1` is NOT >= `1.14.0`). Unparseable
 * `a` returns false (callers treat that as advisory).
 */
export function gteVersion(a: string, b: string): boolean {
  const ca = parseVersionCore(a);
  const cb = parseVersionCore(b);
  if (ca === null || cb === null) return false;
  for (let i = 0; i < 3; i++) {
    if (ca[i]! !== cb[i]!) return ca[i]! > cb[i]!;
  }
  // Equal cores: a-with-prerelease < b-without-prerelease.
  if (a.includes("-") && !b.includes("-")) return false;
  return true;
}

/**
 * Resolve the severity of the P30 checks from the manifest
 * `generator_version`: required when it is semver >= the hardening
 * threshold, advisory otherwise (missing / unparseable / below).
 */
export function resolveHardeningSeverity(
  generatorVersion: string | undefined,
): ConformanceSeverity {
  if (!generatorVersion) return "advisory";
  return gteVersion(generatorVersion, ADAPTER_CONTRACT_HARDENING_FROM_VERSION)
    ? "required"
    : "advisory";
}

/**
 * Compliance is gated by REQUIRED checks only: a failing `advisory`
 * check is surfaced (with remediation) but does not break compliance.
 */
export function isAdapterCompliant(checks: ConformanceCheck[]): boolean {
  return checks.every(
    (c) => c.status === "pass" || c.severity === "advisory",
  );
}

export type HardeningCheckResult = {
  ok: boolean;
  details: Record<string, unknown>;
};

/** `task prepare` appears and precedes the first `recommend` / `task context`. */
export function checkTaskPrepareIsPrimary(content: string): HardeningCheckResult {
  const prepareIdx = content.indexOf(PRIMARY_ENTRYPOINT_SURFACE);
  if (prepareIdx < 0) {
    return {
      ok: false,
      details: {
        primary_surface: PRIMARY_ENTRYPOINT_SURFACE,
        reason: `"${PRIMARY_ENTRYPOINT_SURFACE}" not found in the instruction`,
      },
    };
  }
  const precededBy = PRIMARY_PRECEDES_SURFACES.filter((s) => {
    const idx = content.indexOf(s);
    return idx >= 0 && idx < prepareIdx;
  });
  return {
    ok: precededBy.length === 0,
    details: {
      primary_surface: PRIMARY_ENTRYPOINT_SURFACE,
      must_precede: [...PRIMARY_PRECEDES_SURFACES],
      preceded_by: precededBy,
    },
  };
}

/** No P29 anti-pattern (e.g. `task finalize ... --agent`) in the guidance. */
export function checkNoContractAntipatterns(content: string): HardeningCheckResult {
  const found = CONTRACT_ANTIPATTERNS.filter((a) => a.pattern.test(content)).map(
    (a) => a.id,
  );
  return {
    ok: found.length === 0,
    details: {
      checked: CONTRACT_ANTIPATTERNS.map((a) => a.id),
      found,
    },
  };
}

/**
 * The P29-T3 activation rules are DOCUMENTED, detected by
 * locale-independent anchor tokens. Verifies documentation PRESENCE,
 * never runtime obedience (a static file check cannot observe behaviour).
 */
export function checkActivationRulesDocumented(content: string): HardeningCheckResult {
  const missing = ACTIVATION_RULE_ANCHORS.filter(
    (r) => !content.includes(r.anchor),
  ).map((r) => r.id);
  return {
    ok: missing.length === 0,
    details: {
      rules: ACTIVATION_RULE_ANCHORS.map((r) => r.id),
      missing,
      checks: "documentation presence, not runtime obedience",
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `code-pact adapter conformance <agent>` — focused read-only check
 * that the installed adapter satisfies the v1.11+ agent contract:
 * the `## Agent contract` section is present, the three axis sub-
 * headings exist, every required CLI surface (lifecycle + diagnostic)
 * is mentioned in the instruction file, every required failure-mode
 * keyword is mentioned, and each managed file's on-disk content
 * matches the manifest checksum.
 *
 * Returns `compliant: true` when every check passes; the CLI layer
 * exits 0 when compliant and 1 otherwise. No state is mutated.
 *
 * Doctor coverage (`ADAPTER_GENERATOR_STALE`, `ADAPTER_PROFILE_DRIFT`,
 * `ADAPTER_UNMANAGED_FILE`, etc.) is intentionally NOT duplicated
 * here — `adapter doctor` remains the broad audit; `adapter
 * conformance` is the focused contract-shape check.
 */
export async function runAdapterConformance(
  opts: AdapterConformanceOptions,
): Promise<AdapterConformanceResult> {
  const { cwd, agentName } = opts;
  const checks: ConformanceCheck[] = [];

  const manifest = await readManifest(cwd, agentName);

  if (manifest === null) {
    checks.push(
      fail("manifest_present", undefined, {
        reason: "no adapter manifest at .code-pact/adapters/" +
          agentName + ".manifest.yaml — run `code-pact adapter install` first",
      }),
    );
    return { agent: agentName, compliant: false, checks };
  }

  checks.push(pass("manifest_present"));

  const instructionEntry = findInstructionFile(manifest);
  if (instructionEntry === null) {
    checks.push(
      fail("instruction_file_present", undefined, {
        reason: "manifest contains no file with role=instruction",
      }),
    );
    return { agent: agentName, compliant: false, checks };
  }

  // Load the instruction file off disk. The body of every contract,
  // surface, and failure-guidance check below operates on this string.
  let instructionContent: string;
  try {
    instructionContent = await readFile(
      join(cwd, instructionEntry.path),
      "utf8",
    );
  } catch {
    checks.push(
      fail("instruction_file_present", instructionEntry.path, {
        reason: "instruction file declared in manifest is missing on disk",
      }),
    );
    return { agent: agentName, compliant: false, checks };
  }

  checks.push(pass("instruction_file_present", instructionEntry.path));

  // ----- contract section + three axes -----
  if (instructionContent.includes(AGENT_CONTRACT_SECTION_HEADING)) {
    checks.push(pass("contract_section_present", instructionEntry.path));
  } else {
    checks.push(
      fail("contract_section_present", instructionEntry.path, {
        expected: AGENT_CONTRACT_SECTION_HEADING,
      }),
    );
  }

  const axisCheckIds = [
    "axis_when_to_invoke",
    "axis_what_to_verify",
    "axis_how_to_handle",
  ] as const;
  for (let i = 0; i < AGENT_CONTRACT_AXIS_HEADINGS.length; i++) {
    const heading = AGENT_CONTRACT_AXIS_HEADINGS[i]!;
    const checkId = axisCheckIds[i]!;
    if (instructionContent.includes(heading)) {
      checks.push(pass(checkId, instructionEntry.path));
    } else {
      checks.push(
        fail(checkId, instructionEntry.path, { expected: heading }),
      );
    }
  }

  // ----- required CLI surface mentions (lifecycle + diagnostic) -----
  const missingLifecycle = LIFECYCLE_REQUIRED_SURFACES.filter(
    (s) => !instructionContent.includes(s),
  );
  const missingDiagnostic = DIAGNOSTIC_REQUIRED_SURFACES.filter(
    (s) => !instructionContent.includes(s),
  );
  const surfaceDetails = {
    lifecycle_required: [...LIFECYCLE_REQUIRED_SURFACES],
    diagnostic_required: [...DIAGNOSTIC_REQUIRED_SURFACES],
    missing_lifecycle: missingLifecycle,
    missing_diagnostic: missingDiagnostic,
  };
  if (missingLifecycle.length === 0 && missingDiagnostic.length === 0) {
    checks.push(
      pass(
        "required_cli_surface_mentions",
        instructionEntry.path,
        surfaceDetails,
      ),
    );
  } else {
    checks.push(
      fail(
        "required_cli_surface_mentions",
        instructionEntry.path,
        surfaceDetails,
      ),
    );
  }

  // ----- required failure guidance keywords -----
  const missingFailureGuidance = REQUIRED_FAILURE_GUIDANCE.filter(
    (k) => !instructionContent.includes(k),
  );
  const failureDetails = {
    required: [...REQUIRED_FAILURE_GUIDANCE],
    missing: missingFailureGuidance,
  };
  if (missingFailureGuidance.length === 0) {
    checks.push(
      pass(
        "required_failure_guidance",
        instructionEntry.path,
        failureDetails,
      ),
    );
  } else {
    checks.push(
      fail(
        "required_failure_guidance",
        instructionEntry.path,
        failureDetails,
      ),
    );
  }

  // ----- P30: post-P29 `task prepare` primary contract -----
  // Severity is hybrid/version-gated: required for adapters whose
  // templates carry the P29-aligned guidance (generator_version >=
  // threshold), advisory below so pre-hardening installs warn rather
  // than hard-fail. A failure's details carry the upgrade remediation.
  const hardeningSeverity = resolveHardeningSeverity(manifest.generator_version);
  const remediation = `adapter upgrade ${agentName} --write`;

  const hardeningChecks: Array<{
    id: string;
    result: HardeningCheckResult;
  }> = [
    { id: "task_prepare_is_primary", result: checkTaskPrepareIsPrimary(instructionContent) },
    { id: "no_contract_antipatterns", result: checkNoContractAntipatterns(instructionContent) },
    { id: "activation_rules_documented", result: checkActivationRulesDocumented(instructionContent) },
  ];
  for (const { id, result } of hardeningChecks) {
    if (result.ok) {
      checks.push(pass(id, instructionEntry.path, result.details, hardeningSeverity));
    } else {
      checks.push(
        fail(
          id,
          instructionEntry.path,
          { ...result.details, remediation },
          hardeningSeverity,
        ),
      );
    }
  }

  // ----- per-file checksum match -----
  for (const entry of manifest.files) {
    let diskContent: string;
    try {
      diskContent = await readFile(join(cwd, entry.path), "utf8");
    } catch {
      checks.push(
        fail("file_checksum_match", entry.path, {
          reason: "file declared in manifest is missing on disk",
        }),
      );
      continue;
    }
    const actual = hashContent(diskContent);
    if (actual === entry.sha256) {
      checks.push(pass("file_checksum_match", entry.path));
    } else {
      checks.push(
        fail("file_checksum_match", entry.path, {
          expected_sha256: entry.sha256,
          actual_sha256: actual,
        }),
      );
    }
  }

  return { agent: agentName, compliant: isAdapterCompliant(checks), checks };
}
