import { describe, it, expect } from "vitest";
import {
  majorOf,
  parseChangelog,
  partitionByMajor,
  planArchive,
  renderChangelog,
  majorsFromPointer,
  archiveMajorsOnDisk,
  archiveConflicts,
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

describe("rolling archive across majors (no dropped pointers)", () => {
  // A CHANGELOG already on v2 work, with v1.x still inline and an EXISTING pointer to the v0 archive.
  const V2 = `# Changelog

## [Unreleased]

- wip

## [2.0.0] — 2026-08-01

- v2 ga

## [1.5.0] — 2026-07-01

- a v1 thing

## Older versions

Releases before the current major are archived (moved verbatim, not deleted):

- v0.x — [docs/maintainers/history/CHANGELOG-0.md](docs/maintainers/history/CHANGELOG-0.md)
`;

  it("majorsFromPointer reads majors from an existing pointer block", () => {
    expect(majorsFromPointer("- v0.x — [x](docs/maintainers/history/CHANGELOG-0.md)\n- v1.x — [y](docs/maintainers/history/CHANGELOG-1.md)")).toEqual([0, 1]);
  });

  it("archiving v1.x at currentMajor=2 KEEPS the existing v0.x pointer (union, not replace)", () => {
    const plan = planArchive(V2, 2);
    expect(plan.changed).toBe(true);
    expect(plan.archive.map((a: { major: number }) => a.major)).toEqual([1]);
    // both archives are discoverable from the main CHANGELOG
    expect(plan.newChangelog).toContain("CHANGELOG-1.md");
    expect(plan.newChangelog).toContain("CHANGELOG-0.md"); // <- not dropped
    expect(plan.newChangelog).not.toContain("## [1.5.0]"); // v1 moved out
    // a single pointer block, listing both majors descending
    expect(plan.newChangelog.match(/## Older versions/g)).toHaveLength(1);
  });
});

describe("archive discovery invariant (no orphaned archive files)", () => {
  it("archiveMajorsOnDisk parses CHANGELOG-<n>.md filenames (ignoring others)", () => {
    expect(archiveMajorsOnDisk(["CHANGELOG-0.md", "CHANGELOG-1.md", "README.md", "post-1.26-x.md"])).toEqual([0, 1]);
  });

  it("re-links an orphaned archive: a file on disk not in the pointer is added (pointer-only write, no section move)", () => {
    // CHANGELOG with only the current major + Unreleased, NO pointer — but CHANGELOG-0.md exists on disk (orphan).
    const noPointer = `# Changelog\n\n## [Unreleased]\n\n- wip\n\n## [1.0.0] — 2026-05-01\n\n- ga\n`;
    const plan = planArchive(noPointer, 1, [0]);
    expect(plan.changed).toBe(true); // the pointer is missing → out of date
    expect(plan.archive).toHaveLength(0); // nothing inline to move — pointer-only fix
    expect(plan.newChangelog).toContain("## Older versions");
    expect(plan.newChangelog).toContain("CHANGELOG-0.md");
  });

  it("is a no-op when every on-disk archive is already linked", () => {
    const linked = planArchive(`# Changelog\n\n## [1.0.0] — 2026-05-01\n\n- ga\n`, 1, [0]).newChangelog;
    expect(planArchive(linked, 1, [0]).changed).toBe(false);
  });
});

describe("archiveConflicts (refuse to overwrite a different existing archive)", () => {
  const archive = [{ major: 0, path: "history/CHANGELOG-0.md", content: "FULL", versions: [] }];

  it("absent target → no conflict (fresh create)", () => {
    expect(archiveConflicts(archive, () => null)).toEqual([]);
  });
  it("identical existing target → no conflict (re-applying a partial run)", () => {
    expect(archiveConflicts(archive, () => "FULL")).toEqual([]);
  });
  it("different existing target → conflict (would lose history)", () => {
    expect(archiveConflicts(archive, () => "only a leaked fragment")).toEqual(["history/CHANGELOG-0.md"]);
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
