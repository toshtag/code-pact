import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPublicMdLinks } from "../../../scripts/check-public-md-links.ts";

// The GitHub-clickable view: a Markdown link whose target .md file is absent on
// disk is a 404 for a human, regardless of any `.code-pact/state` record. This is
// the COMPLEMENT of the record-aware `check-doc-links`.

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function tree(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "public-md-"));
  await mkdir(join(dir, "docs", "maintainers", "history"), { recursive: true });
  await mkdir(join(dir, "design", "decisions"), { recursive: true });
  return dir;
}
const w = (dir: string, rel: string, body: string) => writeFile(join(dir, rel), body, "utf8");

describe("checkPublicMdLinks — disk-only clickable view", () => {
  it("flags a clickable link to a missing .md file", async () => {
    root = await tree();
    await w(root, "README.md", "# P\n\nSee [the RFC](design/decisions/gone-rfc.md).\n");
    const problems = checkPublicMdLinks(root);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("gone-rfc.md");
    expect(problems[0]).toContain("README.md:3");
  });

  it("passes when the target .md exists", async () => {
    root = await tree();
    await w(root, "design/decisions/live-rfc.md", "# Live\n");
    await w(root, "README.md", "# P\n\nSee [the RFC](design/decisions/live-rfc.md).\n");
    expect(checkPublicMdLinks(root)).toEqual([]);
  });

  it("does NOT flag a link inside a fenced code block (illustrative)", async () => {
    root = await tree();
    await w(root, "README.md", "# P\n\n```md\n[example](design/decisions/foo-rfc.md)\n```\n");
    expect(checkPublicMdLinks(root)).toEqual([]);
  });

  it("does NOT flag a link inside an inline code span", async () => {
    root = await tree();
    await w(root, "README.md", "# P\n\nReference `[x](design/decisions/foo-rfc.md)` as text.\n");
    expect(checkPublicMdLinks(root)).toEqual([]);
  });

  it("skips external + bare-anchor links", async () => {
    root = await tree();
    await w(root, "README.md", "# P\n\n[ext](https://example.com/x.md) and [a](#section).\n");
    expect(checkPublicMdLinks(root)).toEqual([]);
  });

  it("excludes the archived CHANGELOG history (verbatim point-in-time links)", async () => {
    root = await tree();
    await w(root, "docs/maintainers/history/CHANGELOG-1.md", "# v1.x\n\n[gone](../../../design/decisions/since-moved.md)\n");
    expect(checkPublicMdLinks(root)).toEqual([]);
  });

  it("DOES scan a non-CHANGELOG history doc (only the CHANGELOG archive is exempt)", async () => {
    root = await tree();
    await w(root, "docs/maintainers/history/backlog.md", "# Backlog\n\n[gone](../../../design/decisions/since-moved.md)\n");
    const problems = checkPublicMdLinks(root);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("since-moved.md");
  });

  it("checks CHANGELOG.md (the gap that motivated this check)", async () => {
    root = await tree();
    await w(root, "CHANGELOG.md", "# Changelog\n\n## [2.0.0]\n\nSee [x](design/decisions/retired-rfc.md).\n");
    const problems = checkPublicMdLinks(root);
    expect(problems.some((p) => p.includes("CHANGELOG.md") && p.includes("retired-rfc.md"))).toBe(true);
  });
});
