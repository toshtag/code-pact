import { describe, it, expect, vi } from "vitest";
import {
  checkReleaseTag,
  firstReleasedVersion,
} from "../../../scripts/check-release-tag.mjs";

const basePkg = { name: "code-pact", version: "2.0.1" };
const baseChangelog =
  "# Changelog\n\n## [Unreleased]\n\n## [2.0.1] — 2026-07-02\n";

function makeGithubApi(overrides = {}) {
  const refResponse = { object: { type: "tag", sha: "tagobj123" } };
  const tagObjectResponse = {
    object: { sha: "abc123" },
    verification: { verified: true },
    ...overrides,
  };
  return vi.fn(async (_repo, path) => {
    if (path.startsWith("git/ref/")) return refResponse;
    if (path.startsWith("git/tags/")) return tagObjectResponse;
    throw new Error(`unexpected API path: ${path}`);
  });
}

function makeGitRunner(shouldFail = false) {
  return vi.fn(() => {
    if (shouldFail) throw new Error("git merge-base failed");
    return Buffer.from("");
  });
}

describe("firstReleasedVersion", () => {
  it("skips [Unreleased] and returns the first released section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "## [2.0.1] — 2026-07-02",
    ].join("\n");
    expect(firstReleasedVersion(changelog)).toBe("2.0.1");
  });

  it("returns null when there is no released section", () => {
    expect(firstReleasedVersion("# Changelog\n\n## [Unreleased]\n")).toBeNull();
  });
});

describe("checkReleaseTag", () => {
  it("succeeds when tag matches package version and all checks pass", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: makeGithubApi(),
      gitRunner: makeGitRunner(),
      registryCheck: async () => "absent",
    });
    expect(result.ok).toBe(true);
    expect(result.versionExists).toBe(false);
    expect(result.registryState).toBe("absent");
  });

  it("fails when not triggered by a tag", async () => {
    const result = await checkReleaseTag({
      refType: "branch",
      refName: "main",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not triggered by a tag");
  });

  it("fails when tag name does not match package version", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.0",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not match package version");
  });

  it("fails when required env is missing", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "",
      sha: "",
      repository: "",
      token: "",
      pkg: basePkg,
      changelog: baseChangelog,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("required GitHub environment is missing");
  });

  it("fails for lightweight tag (ref.object.type !== 'tag')", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: vi.fn(async () => ({
        object: { type: "commit", sha: "abc123" },
      })),
      gitRunner: makeGitRunner(),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("annotated signed tag");
  });

  it("fails when GitHub verification is false", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: makeGithubApi({
        verification: { verified: false, reason: "unknown_signature" },
      }),
      gitRunner: makeGitRunner(),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not verified");
  });

  it("fails when tag commit != GITHUB_SHA", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: makeGithubApi({
        object: { sha: "different_sha" },
        verification: { verified: true },
      }),
      gitRunner: makeGitRunner(),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not point at GITHUB_SHA");
  });

  it("fails when commit is not on origin/main", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: makeGithubApi(),
      gitRunner: makeGitRunner(true),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not an ancestor of origin/main");
  });

  it("fails when GitHub API errors", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: vi.fn(async () => {
        throw new Error("GitHub API git/ref returned 500");
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("GitHub API error");
  });

  it("fails when CHANGELOG version does not match package version", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: "# Changelog\n\n## [Unreleased]\n\n## [2.0.0] — 2026-06-01\n",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("CHANGELOG");
  });

  it("fails when npm registry already has the version", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: makeGithubApi(),
      gitRunner: makeGitRunner(),
      registryCheck: async () => "exists",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("RELEASE_VERSION_ALREADY_EXISTS");
    expect(result.versionExists).toBe(true);
    expect(result.registryState).toBe("exists");
  });

  it("fails closed when the registry probe returns an error", async () => {
    const result = await checkReleaseTag({
      refType: "tag",
      refName: "v2.0.1",
      sha: "abc123",
      repository: "toshtag/code-pact",
      token: "test-token",
      pkg: basePkg,
      changelog: baseChangelog,
      githubApi: makeGithubApi(),
      gitRunner: makeGitRunner(),
      registryCheck: async () => "error",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("REGISTRY_PROBE_ERROR");
    expect(result.versionExists).toBe(false);
    expect(result.registryState).toBe("error");
  });
});
