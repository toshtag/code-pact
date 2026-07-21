import {
  MAX_EXECUTOR_OUTPUT_BYTES,
  MAX_NEW_TEXT_BYTES,
  MAX_REASON_BYTES,
  type OneShotExecutorOutput,
} from "./types.ts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const REPLACE_EXACT_KEYS = new Set([
  "kind",
  "expected_file_sha256",
  "old_text",
  "new_text",
]);
const BLOCKED_KEYS = new Set(["kind", "reason"]);

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function assertObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extraKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
): string[] {
  return Object.keys(value).filter(k => !allowed.has(k));
}

/** Validate and normalize a one-shot executor output.
 *
 * This is the controller-level boundary: every executor (external process or
 * custom adapter) returns `unknown` and this function is the single point that
 * turns it into a typed, bounded contract. Callers receive a plain object and
 * must still apply the edit and re-check the working tree.
 */
export function parseOneShotExecutorOutput(
  value: unknown,
  opts?: { maxSerializedBytes?: number },
): OneShotExecutorOutput {
  const maxSerializedBytes = opts?.maxSerializedBytes ?? MAX_EXECUTOR_OUTPUT_BYTES;

  if (!assertObject(value)) {
    throw schemaError("executor output is not a JSON object", "EXECUTOR_SCHEMA_MISMATCH");
  }

  const serialized = JSON.stringify(value);
  if (byteLength(serialized) > maxSerializedBytes) {
    throw schemaError(
      `executor output exceeds ${maxSerializedBytes} bytes`,
      "EXECUTOR_OUTPUT_TOO_LARGE",
    );
  }

  const kind = value.kind;
  if (kind !== "replace_exact" && kind !== "blocked") {
    throw schemaError(
      `executor output kind "${String(kind)}" is not allowed`,
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  if (kind === "blocked") {
    const extras = extraKeys(value, BLOCKED_KEYS);
    if (extras.length > 0) {
      throw schemaError(
        `blocked output has unknown keys: ${extras.join(", ")}`,
        "EXECUTOR_SCHEMA_MISMATCH",
      );
    }
    const reason = value.reason;
    if (typeof reason !== "string" || reason.length === 0) {
      throw schemaError(
        "blocked output requires a non-empty string reason",
        "EXECUTOR_SCHEMA_MISMATCH",
      );
    }
    const reasonBytes = byteLength(reason);
    if (reasonBytes > MAX_REASON_BYTES) {
      throw schemaError(
        `blocked reason exceeds ${MAX_REASON_BYTES} bytes`,
        "EXECUTOR_SCHEMA_MISMATCH",
      );
    }
    return { kind: "blocked", reason };
  }

  const extras = extraKeys(value, REPLACE_EXACT_KEYS);
  if (extras.length > 0) {
    throw schemaError(
      `replace_exact output has unknown keys: ${extras.join(", ")}`,
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  const expected_file_sha256 = value.expected_file_sha256;
  const old_text = value.old_text;
  const new_text = value.new_text;

  if (
    typeof expected_file_sha256 !== "string" ||
    typeof old_text !== "string" ||
    typeof new_text !== "string"
  ) {
    throw schemaError(
      "replace_exact output requires expected_file_sha256, old_text, and new_text strings",
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  if (!SHA256_PATTERN.test(expected_file_sha256)) {
    throw schemaError(
      "expected_file_sha256 must be 64 lowercase hex characters",
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  if (old_text.length === 0) {
    throw schemaError(
      "replace_exact output requires a non-empty old_text",
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  if (byteLength(new_text) > MAX_NEW_TEXT_BYTES) {
    throw schemaError(
      `new_text exceeds ${MAX_NEW_TEXT_BYTES} bytes`,
      "EXECUTOR_SCHEMA_MISMATCH",
    );
  }

  return {
    kind: "replace_exact",
    expected_file_sha256,
    old_text,
    new_text,
  };
}

function schemaError(message: string, code: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}
