// Type declarations for npm-pack-json.mjs (consumed by the unit test; the
// script itself runs as plain Node ESM).

export interface PackRecord {
  name: string;
  version: string;
  filename: string;
}

export function extractPackRecord(
  payload: unknown,
  expected: { expectedName?: string; expectedVersion?: string },
): PackRecord;
