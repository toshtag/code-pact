import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  parseSemver,
  semverLte,
  firstReleasedVersion,
  checkReleaseVersion,
} from "../../../scripts/check-release-version.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("parseSemver", () => {
  it("parses X.Y.Z", () => {
    expect(parseSemver("1.26.0")).toEqual([1, 26, 0]);
  });
  it("returns null for non-semver", () => {
    expect(parseSemver("Unreleased")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("semverLte", () => {
  it.each([
    ["1.26.0", "1.26.0", true],
    ["1.25.0", "1.26.0", true],
    ["1.26.0", "1.27.0", true],
    ["1.27.0", "1.26.0", false],
    ["2.0.0", "1.26.0", false],
    ["1.26.1", "1.26.0", false],
  ])("semverLte(%s, %s) === %s", (a, b, expected) => {
    expect(semverLte(a, b)).toBe(expected);
  });
});

describe("firstReleasedVersion", () => {
  it("skips [Unreleased] and returns the first released section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Something",
      "",
      "## [1.26.0] — 2026-05-30",
      "",
      "## [1.25.0] — 2026-05-28",
    ].join("\n");
    expect(firstReleasedVersion(changelog)).toBe("1.26.0");
  });
  it("returns null when there is no released section", () => {
    expect(firstReleasedVersion("# Changelog\n\n## [Unreleased]\n")).toBeNull();
  });
});

describe("checkReleaseVersion — against the real repo", () => {
  it("reports no problems (release surfaces are consistent)", () => {
    const problems = checkReleaseVersion(repoRoot);
    expect(problems).toEqual([]);
  });
});
