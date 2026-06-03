import { createHash } from "node:crypto";
import type { ProgressEvent } from "../schemas/progress-event.ts";

/**
 * Collaboration-safe event identity (collaboration-safe-state RFC, B5).
 *
 * A progress event's identity is a content hash of its canonical payload, so
 * the same logical event always hashes to the same id. That makes legacy↔file
 * dedup (B3) and idempotent migration (B4) free, and makes the per-event-file
 * filename a bijection with the id: a filename collision happens iff two events
 * are *canonically identical* (same canonical payload), so a pre-existing final
 * file means the canonically identical event is already on disk (idempotent
 * success, B1) — never a distinct-event clash.
 *
 * The canonical payload MUST be pinned exactly or the id is not reproducible:
 *  - every persisted event field EXCEPT `id`; `at` is included
 *  - `at` normalized to UTC ISO-8601 with milliseconds (…Z) before hashing, so
 *    the same instant written with different offsets hashes identically
 *  - object keys sorted recursively; absent/`undefined` optional fields omitted
 *    (never serialized as `null` — `null` is schema-invalid and rejected by
 *    `ProgressEvent.parse` upstream, never normalized here)
 *  - array element order preserved
 *  - hash input is canonical JSON (UTF-8); YAML formatting is never hashed
 */

/** Normalize an ISO-8601 timestamp (any offset) to UTC ISO-8601 ms (`…Z`). */
export function normalizeAt(at: string): string {
  return new Date(at).toISOString();
}

/** Stable JSON: keys sorted recursively, `undefined` omitted, arrays in order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/**
 * The single canonical hash input for an event (RFC B5: `canonicalizeEvent` is
 * the only producer): its persisted fields with `at` normalized to UTC. `id` is
 * never part of the payload (it is the output).
 */
export function canonicalizeEvent(event: ProgressEvent): string {
  return canonicalJson({ ...event, at: normalizeAt(event.at) });
}

/** Full 64-char sha256 hex digest of the canonical event payload. */
export function computeEventId(event: ProgressEvent): string {
  return createHash("sha256").update(canonicalizeEvent(event), "utf8").digest("hex");
}

/**
 * `at` rendered compactly (`YYYYMMDDTHHMMSSsssZ`) from the normalized UTC value,
 * for a human-browsable, roughly-chronological `ls`. Fully content-determined.
 */
export function atCompact(at: string): string {
  return normalizeAt(at).replace(/[-:]/g, "").replace(".", "");
}

/**
 * Event-file name `<at-compact>-<full-id>.yaml`. The full digest (not a
 * truncated prefix) makes the filename a bijection with the id.
 */
export function eventFileName(event: ProgressEvent): string {
  return `${atCompact(event.at)}-${computeEventId(event)}.yaml`;
}
