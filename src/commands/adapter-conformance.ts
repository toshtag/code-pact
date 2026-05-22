import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SupportedAgent } from "../core/agents.ts";
import {
  AGENT_CONTRACT_AXIS_HEADINGS,
  AGENT_CONTRACT_SECTION_HEADING,
  DIAGNOSTIC_REQUIRED_SURFACES,
  LIFECYCLE_REQUIRED_SURFACES,
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

export type ConformanceCheck = {
  id: string;
  status: ConformanceCheckStatus;
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
): ConformanceCheck {
  const c: ConformanceCheck = { id, status: "pass" };
  if (file !== undefined) c.file = file;
  if (details !== undefined) c.details = details;
  return c;
}

function fail(
  id: string,
  file?: string,
  details?: Record<string, unknown>,
): ConformanceCheck {
  const c: ConformanceCheck = { id, status: "fail" };
  if (file !== undefined) c.file = file;
  if (details !== undefined) c.details = details;
  return c;
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

  const compliant = checks.every((c) => c.status === "pass");
  return { agent: agentName, compliant, checks };
}
