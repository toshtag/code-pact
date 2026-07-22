import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { canonicalJson } from "./content-addressed-store/canonical-json.ts";
import {
  TaskRegistrationSpec as TaskRegistrationSpecSchema,
  type TaskRegistrationSpec,
} from "./schemas/task-registration-spec.ts";
import type { Task } from "./schemas/task.ts";

export type { TaskRegistrationSpec };

function arraysEqual(
  a: unknown[] | undefined,
  b: unknown[] | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

type FieldDiffOptions = {
  includeStatus: boolean;
};

function registrationFieldDiffs(
  expected: Task,
  actual: Task,
  options: FieldDiffOptions,
): string[] {
  const fields: string[] = [];
  if (expected.id !== actual.id) fields.push("id");
  if (expected.type !== actual.type) fields.push("type");
  if (expected.ambiguity !== actual.ambiguity) fields.push("ambiguity");
  if (expected.risk !== actual.risk) fields.push("risk");
  if (expected.context_size !== actual.context_size)
    fields.push("context_size");
  if (expected.write_surface !== actual.write_surface)
    fields.push("write_surface");
  if (expected.verification_strength !== actual.verification_strength)
    fields.push("verification_strength");
  if (expected.expected_duration !== actual.expected_duration)
    fields.push("expected_duration");
  if (options.includeStatus && expected.status !== actual.status)
    fields.push("status");
  if (expected.description !== actual.description) fields.push("description");
  if (expected.requires_decision !== actual.requires_decision)
    fields.push("requires_decision");
  if (!arraysEqual(expected.depends_on, actual.depends_on))
    fields.push("depends_on");
  if (!arraysEqual(expected.decision_refs, actual.decision_refs))
    fields.push("decision_refs");
  if (!arraysEqual(expected.reads, actual.reads)) fields.push("reads");
  if (!arraysEqual(expected.writes, actual.writes)) fields.push("writes");
  if (!arraysEqual(expected.acceptance_refs, actual.acceptance_refs))
    fields.push("acceptance_refs");
  return fields;
}

/**
 * Lock-time full comparison between a strict task-registration spec and the
 * stored phase task. Every registration field, including `status` and the
 * presence/value of `requires_decision`, must match.
 *
 * - `status` is included: a spec-locked task must be `planned` at lock time.
 * - Empty arrays are treated as different from missing fields.
 * - `requires_decision: false` and a missing field are different.
 */
export function lockTimeRegistrationChangedFields(
  expected: Task,
  actual: Task,
): string[] {
  return registrationFieldDiffs(expected, actual, { includeStatus: true });
}

/**
 * Post-lock drift comparison. The `status` lifecycle field is excluded so that
 * `planned → started → done` transitions do not trigger drift. All other fields
 * are compared exactly, including `requires_decision` presence.
 *
 * - `requires_decision: false` and a missing field are different.
 * - Empty arrays are treated as different from missing fields.
 */
export function postLockRegistrationChangedFields(
  expected: Task,
  actual: Task,
): string[] {
  return registrationFieldDiffs(expected, actual, { includeStatus: false });
}

/**
 * Build the canonical UTF-8 JSON representation of a task registration
 * contract without mutating the input.
 *
 * - Top-level key order is canonicalized by `canonicalJson`.
 * - Array order is preserved as-is; `depends_on` is NOT sorted.
 * - `status` is included because lock-time registration must be `planned`.
 * - `requires_decision` is preserved as-is; `undefined` (field missing) and
 *   `false` (explicitly false) produce different canonical forms.
 * - Explicit empty arrays are kept; missing optional arrays are omitted,
 *   so "empty array" and "field omitted" produce different digests.
 * - `undefined` values are filtered out by `canonicalJson`.
 */
export function canonicalTaskRegistration(phaseId: string, task: Task): string {
  const registration: {
    schema_version: number;
    phase_id: string;
    task: Record<string, unknown>;
  } = {
    schema_version: 1,
    phase_id: phaseId,
    task: {
      id: task.id,
      type: task.type,
      ambiguity: task.ambiguity,
      risk: task.risk,
      context_size: task.context_size,
      write_surface: task.write_surface,
      verification_strength: task.verification_strength,
      expected_duration: task.expected_duration,
      status: task.status,
      description: task.description,
      requires_decision: task.requires_decision,
      depends_on: task.depends_on,
      decision_refs: task.decision_refs,
      reads: task.reads,
      writes: task.writes,
      acceptance_refs: task.acceptance_refs,
    },
  };
  return canonicalJson(registration);
}

/**
 * SHA-256 lowercase hex digest of the canonical task registration contract.
 */
export function taskRegistrationDigest(phaseId: string, task: Task): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalTaskRegistration(phaseId, task), "utf8"))
    .digest("hex");
}

/**
 * Parse a strict task-registration spec from a YAML string.
 *
 * Throws a `CONFIG_ERROR`-coded error when the YAML is not well-formed or the
 * schema rejects the input (missing field, unknown key, wrong type, etc.).
 */
export function parseTaskRegistrationSpec(raw: string): TaskRegistrationSpec {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = new Error(`Invalid task spec YAML: ${message}`);
    (error as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw error;
  }

  const result = TaskRegistrationSpecSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      i => `${i.path.join(".")}: ${i.message}`,
    );
    const error = new Error(
      `Invalid task registration spec: ${issues.join("; ")}`,
    );
    (error as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw error;
  }
  return result.data;
}
