import { describe, it, expect } from "vitest";
import {
  majorOf,
  parseChangelog,
  partitionByMajor,
  planArchive,
  renderChangelog,
} from "../../../scripts/changelog-archive.mjs";
import { extractReleaseNotes } from "../../../scripts/release-notes.mjs";

const SAMPLE = `# Changelog

Preamble line.

---

## [Unreleased]

### Added

- wip

## [1.2.0] — 2026-06-01

### Added

- a current-major thing ([#90])

[#90]: https://example.com/90

## [1.0.0] — 2026-05-01

- ga

## [0.9.0-alpha.0] — 2026-04-01

- old thing ([#44])

[#44]: https://example.com/44

## [0.1.0-alpha.0] — 2026-03-01

- first
`;

describe("majorOf", () => {
  it("reads the leading major", () => {
    expect(majorOf("1.2.0")).toBe(1);
    expect(majorOf("0.9.0-alpha.0")).toBe(0);
    expect(majorOf("Unreleased")).toBeNull();
  });
});

describe("parseChangelog", () => {
  it("splits preamble + version blocks; Unreleased has no major", () => {
    const { preamble, blocks } = parseChangelog(SAMPLE);
    expect(preamble).toContain("# Changelog");
    const versions = blocks.map((b) => b.version);
    expect(versions).toEqual([null, "1.2.0", "1.0.0", "0.9.0-alpha.0", "0.1.0-alpha.0"]);
    expect(blocks[0]!.major).toBeNull(); // Unreleased
    expect(blocks[1]!.major).toBe(1);
    expect(blocks[3]!.major).toBe(0);
    // a block carries its trailing reference defs
    expect(blocks[1]!.text).toContain("[#90]: https://example.com/90");
    expect(blocks[3]!.text).toContain("[#44]: https://example.com/44");
  });
});

describe("partitionByMajor", () => {
  it("keeps current major + version-less blocks; archives older majors grouped", () => {
    const { blocks } = parseChangelog(SAMPLE);
    const { kept, archivedByMajor } = partitionByMajor(blocks, 1);
    expect(kept.map((b) => b.version)).toEqual([null, "1.2.0", "1.0.0"]);
    expect([...archivedByMajor.keys()]).toEqual([0]);
    expect(archivedByMajor.get(0)!.map((b) => b.version)).toEqual(["0.9.0-alpha.0", "0.1.0-alpha.0"]);
  });
});

describe("planArchive", () => {
  it("moves older majors out, leaves a pointer, and keeps refs with their section", () => {
    const plan = planArchive(SAMPLE, 1);
    expect(plan.changed).toBe(true);
    expect(plan.archive).toHaveLength(1);
    const entry = plan.archive[0]!;
    expect(entry.path).toBe("docs/maintainers/history/CHANGELOG-0.md");
    // archived content carries the 0.x sections + their defs
    expect(entry.content).toContain("## [0.9.0-alpha.0]");
    expect(entry.content).toContain("[#44]: https://example.com/44");
    // new CHANGELOG drops the 0.x sections, keeps 1.x + a pointer
    expect(plan.newChangelog).not.toContain("## [0.9.0-alpha.0]");
    expect(plan.newChangelog).toContain("## [1.2.0]");
    expect(plan.newChangelog).toContain("## Older versions");
    expect(plan.newChangelog).toContain("CHANGELOG-0.md");
    // the current-major refs stay inline
    expect(plan.newChangelog).toContain("[#90]: https://example.com/90");
  });

  it("is idempotent: re-planning the archived CHANGELOG makes no further change", () => {
    const once = planArchive(SAMPLE, 1).newChangelog;
    const twice = planArchive(once, 1);
    expect(twice.changed).toBe(false);
    expect(twice.newChangelog).toBe(once); // no duplicate pointer
  });

  it("nothing to do when only the current major + Unreleased are present", () => {
    const onlyCurrent = `# Changelog\n\n## [Unreleased]\n\n- wip\n\n## [1.0.0] — 2026-05-01\n\n- ga\n`;
    expect(planArchive(onlyCurrent, 1).changed).toBe(false);
  });
});

describe("renderChangelog", () => {
  it("does not duplicate the pointer when one already exists among kept blocks", () => {
    const { preamble, blocks } = parseChangelog(planArchive(SAMPLE, 1).newChangelog);
    const { kept } = partitionByMajor(blocks, 1);
    const rendered = renderChangelog(preamble, kept, [0]);
    expect(rendered.match(/## Older versions/g)).toHaveLength(1);
  });
});

describe("extractReleaseNotes", () => {
  it("returns the version section body, stopping at the next heading", () => {
    const notes = extractReleaseNotes(SAMPLE, "1.2.0");
    expect(notes).toContain("a current-major thing");
    expect(notes).toContain("[#90]:");
    expect(notes).not.toContain("## [1.0.0]");
    expect(notes).not.toContain("## [Unreleased]");
  });

  it("returns null for a version with no section", () => {
    expect(extractReleaseNotes(SAMPLE, "9.9.9")).toBeNull();
  });
});
