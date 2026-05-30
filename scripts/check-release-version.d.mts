// Type declarations for check-release-version.mjs (consumed by the unit test;
// the script itself runs as plain Node ESM).

export function parseSemver(v: string): [number, number, number] | null;
export function semverLte(a: string, b: string): boolean;
export function firstReleasedVersion(changelog: string): string | null;
export function checkReleaseVersion(root: string): string[];
