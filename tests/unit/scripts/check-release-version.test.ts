import { afterEach, describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

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

describe("checkReleaseVersion — release surfaces", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  // Minimal tree carrying every surface checkReleaseVersion reads, all at 9.9.9.
  async function buildTree(over: { changelog?: string; docVersion?: string } = {}): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "crv-"));
    const v = "9.9.9";
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: v }), "utf8");
    await writeFile(join(dir, "CHANGELOG.md"), over.changelog ?? `# Changelog\n\n## [Unreleased]\n\n## [${v}] — 2026-06-18\n`, "utf8");
    await writeFile(join(dir, "README.md"), `# Project\n\nnpm install code-pact@${over.docVersion ?? v}\n`, "utf8");
    await mkdir(join(dir, "src", "core", "adapters"), { recursive: true });
    await writeFile(join(dir, "src/core/adapters/conformance-spec.ts"), `export const RECOMMENDATION_CONSUMPTION_FROM_VERSION = "1.0.0";\n`, "utf8");
    return dir;
  }

  it("passes when changelog, docs, and threshold match package.json", async () => {
    root = await buildTree();
    expect(checkReleaseVersion(root)).toEqual([]);
  });

  it("flags stale docs examples", async () => {
    root = await buildTree({ docVersion: "1.2.3" });
    const problems = checkReleaseVersion(root);
    expect(problems.some((p) => p.includes("code-pact@1.2.3"))).toBe(true);
  });
});
