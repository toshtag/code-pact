import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadReadMatches } from "../../../../src/core/pack/loaders.ts";
import {
  makeReadDirectoryCountsProjection,
  type ReadGlobMatches,
  type RenderedSection,
} from "../../../../src/core/pack/formatters/markdown.ts";

const execFileAsync = promisify(execFile);

async function withRepo(
  fn: (dir: string, track: (paths: string[]) => Promise<void>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "code-pact-pack-loaders-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await fn(dir, async (paths) => {
      await execFileAsync("git", ["add", ...paths], { cwd: dir });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(dir: string, path: string): Promise<void> {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), "x\n", "utf8");
}

describe("loadReadMatches", () => {
  it("matches only Git tracked files", async () => {
    await withRepo(async (dir, track) => {
      await touch(dir, "src/app.ts");
      await touch(dir, ".env");
      await touch(dir, "private.txt");
      await touch(dir, ".local/x");
      await track(["src/app.ts"]);

      const matches = await loadReadMatches(dir, ["**"]);
      expect(matches).toEqual([{ glob: "**", matches: ["src/app.ts"] }]);
    });
  });

  it("allows tracked .env by explicit Git authority", async () => {
    await withRepo(async (dir, track) => {
      await touch(dir, ".env");
      await track([".env"]);

      const matches = await loadReadMatches(dir, [".env"]);
      expect(matches).toEqual([{ glob: ".env", matches: [".env"] }]);
    });
  });

  it("fails closed outside a Git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "code-pact-pack-loaders-nongit-"));
    try {
      await expect(loadReadMatches(dir, ["**"])).rejects.toMatchObject({
        code: "TASK_READS_UNAVAILABLE",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function renderedReadsSection(entries: readonly ReadGlobMatches[]): RenderedSection {
  const lines = ["## Declared read surface", ""];
  for (const entry of entries) {
    lines.push(`- \`${entry.glob}\``);
    if (entry.matches.length === 0) {
      lines.push("  - _(no current matches on disk)_");
    } else {
      for (const match of entry.matches) lines.push(`  - \`${match}\``);
    }
  }
  lines.push("");
  return { name: "reads", lines };
}

describe("makeReadDirectoryCountsProjection", () => {
  it("groups matches by direct parent directory with deterministic counts", () => {
    const entries: ReadGlobMatches[] = [
      {
        glob: "**/*.ts",
        matches: [
          "README.ts",
          ...Array.from({ length: 20 }, (_, index) =>
            `src/core/file-${String(index).padStart(2, "0")}.ts`
          ),
          ...Array.from({ length: 15 }, (_, index) =>
            `src/file-${String(index).padStart(2, "0")}.ts`
          ),
          ...Array.from({ length: 10 }, (_, index) =>
            `tests/unit/file-${String(index).padStart(2, "0")}.ts`
          ),
        ],
      },
    ];

    const projection = makeReadDirectoryCountsProjection(
      entries,
      renderedReadsSection(entries),
    );

    expect(projection).not.toBeNull();
    expect(projection!.kind).toBe("read_directory_counts");
    expect(projection!.projected.lines).toEqual([
      "## Declared read surface",
      "",
      "This is a deterministic parent-directory count projection.",
      "The exact original file list is represented by Deferred Context and can be retrieved after materialization.",
      "",
      "- `**/*.ts`",
      "  - 46 matches across 4 directories",
      "  - `./` — 1 file",
      "  - `src/` — 15 files",
      "  - `src/core/` — 20 files",
      "  - `tests/unit/` — 10 files",
      "",
    ]);
    expect(projection!.projected.details).toMatchObject({
      projection_kind: "read_directory_counts",
      glob_count: 1,
      match_count: 46,
      directory_count: 4,
      saved_bytes: projection!.originalBytes - projection!.projectedBytes,
    });
  });

  it("falls back when the projected section is not smaller", () => {
    const entries: ReadGlobMatches[] = [
      { glob: "src/a.ts", matches: ["src/a.ts"] },
    ];
    expect(
      makeReadDirectoryCountsProjection(entries, renderedReadsSection(entries)),
    ).toBeNull();
  });

  it("orders projected directories by locale-independent code-unit order", () => {
    const dirs = ["A", "Z", "a", "z", "ä", "日本語", "_"];
    const entries: ReadGlobMatches[] = [
      {
        glob: "**/*",
        matches: dirs.flatMap(dir =>
          Array.from({ length: 20 }, (_, index) =>
            `${dir}/file-${String(index).padStart(2, "0")}.ts`
          )
        ),
      },
    ];

    const projection = makeReadDirectoryCountsProjection(
      entries,
      renderedReadsSection(entries),
    );

    expect(projection).not.toBeNull();
    const directoryLines = projection!.projected.lines.filter(line =>
      line.includes(" — 20 files")
    );
    expect(directoryLines).toEqual([
      "  - `A/` — 20 files",
      "  - `Z/` — 20 files",
      "  - `_/` — 20 files",
      "  - `a/` — 20 files",
      "  - `z/` — 20 files",
      "  - `ä/` — 20 files",
      "  - `日本語/` — 20 files",
    ]);
  });
});
