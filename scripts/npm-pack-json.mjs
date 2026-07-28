#!/usr/bin/env node
// Canonical reader for `npm pack --json` metadata.
//
// npm changed this payload's shape across a major version, and the publish
// workflow accepts both majors (`npm >= 11.5.1`), so both shapes reach the
// release pipeline. Measured against this package on 2026-07-28:
//
//   npm 11.16.0 -> [ { id, name, version, filename, files, ... } ]
//   npm 12.0.0  -> { "code-pact": { id, name, version, filename, ... } }
//
// The record itself is identical; only the container differs. Every consumer
// reads it through `extractPackRecord` so the accepted npm range and the
// parser cannot drift apart again — a version gate that admits an npm whose
// output nothing can parse is a release-integrity defect, not a local
// toolchain quirk.
//
// The reader is fail-closed. An unrecognized container, an ambiguous record
// count, a package that is not the one being released, or a filename that is
// not a bare `.tgz` basename all throw. Nothing falls back to reading index 0.

import { isAbsolute } from "node:path";

/** Windows drive-qualified path (`C:\...`), which `isAbsolute` misses on POSIX. */
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Select the single pack record from either supported container shape.
 *
 * @param {unknown} payload - parsed `npm pack --json` output
 * @param {string} expectedName - package name being released
 * @returns {unknown} the raw record, not yet validated
 */
function selectRecord(payload, expectedName) {
  if (payload === null || typeof payload !== "object") {
    throw new Error(
      `pack JSON must be an array (npm <= 11) or an object keyed by package name (npm >= 12), got ${payload === null ? "null" : typeof payload}`,
    );
  }

  if (Array.isArray(payload)) {
    if (payload.length !== 1) {
      throw new Error(
        `pack JSON array holds ${payload.length} record(s); exactly 1 is required`,
      );
    }
    return payload[0];
  }

  const keys = Object.keys(payload);
  if (keys.length !== 1) {
    throw new Error(
      `pack JSON object holds ${keys.length} record(s); exactly 1 is required`,
    );
  }
  if (keys[0] !== expectedName) {
    throw new Error(
      `pack JSON object is keyed by "${keys[0]}", expected "${expectedName}"`,
    );
  }
  return payload[keys[0]];
}

/**
 * Reject anything that is not a bare `<name>.tgz` basename.
 *
 * The value is interpolated into a shell `mv` by the publish workflow, so an
 * absolute path, a traversal segment, or a nested path is refused here rather
 * than trusted downstream.
 *
 * @param {string} filename
 */
function assertSafeTarballName(filename) {
  if (filename.includes("\0")) {
    throw new Error("pack JSON filename contains a NUL byte");
  }
  if (isAbsolute(filename) || WINDOWS_DRIVE_PREFIX.test(filename)) {
    throw new Error(
      `pack JSON filename "${filename}" is an absolute path; a bare basename is required`,
    );
  }
  const segments = filename.split(/[\\/]/);
  if (segments.some(segment => segment === "..")) {
    throw new Error(
      `pack JSON filename "${filename}" contains a path traversal segment`,
    );
  }
  if (segments.length !== 1) {
    throw new Error(
      `pack JSON filename "${filename}" is a nested path; a bare basename is required`,
    );
  }
  if (filename === "." || filename === "") {
    throw new Error(`pack JSON filename "${filename}" is not a file name`);
  }
  if (!filename.endsWith(".tgz")) {
    throw new Error(`pack JSON filename "${filename}" is not a .tgz tarball`);
  }
}

/**
 * Read the canonical pack record out of either npm payload shape.
 *
 * @param {unknown} payload - parsed `npm pack --json` output
 * @param {object} expected
 * @param {string} expected.expectedName - package name from the repository
 * @param {string} expected.expectedVersion - version from the repository
 * @returns {{name: string, version: string, filename: string}}
 * @throws {Error} on any unrecognized, ambiguous, mismatched, or unsafe input
 */
export function extractPackRecord(payload, expected = {}) {
  const { expectedName, expectedVersion } = expected;
  if (typeof expectedName !== "string" || expectedName === "") {
    throw new Error("expectedName is required");
  }
  if (typeof expectedVersion !== "string" || expectedVersion === "") {
    throw new Error("expectedVersion is required");
  }

  const record = selectRecord(payload, expectedName);
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("pack JSON record is not an object");
  }

  const { name, version, filename } = record;
  if (typeof name !== "string" || name === "") {
    throw new Error("pack JSON record has no name");
  }
  if (typeof version !== "string" || version === "") {
    throw new Error("pack JSON record has no version");
  }
  if (typeof filename !== "string" || filename === "") {
    throw new Error("pack JSON record has no filename");
  }
  if (name !== expectedName) {
    throw new Error(
      `pack JSON record is for package "${name}", expected "${expectedName}"`,
    );
  }
  if (version !== expectedVersion) {
    throw new Error(
      `pack JSON record is for version "${version}", expected "${expectedVersion}"`,
    );
  }
  assertSafeTarballName(filename);

  return { name, version, filename };
}
