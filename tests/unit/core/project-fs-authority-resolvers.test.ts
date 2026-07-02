import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveInstructionWritePath,
  resolvePhaseWritePath,
} from "../../../src/core/project-fs/index.ts";
import {
  resolveArchiveOwnedWritePath,
  resolveArchiveOwnedPathSync,
} from "../../../src/core/archive/paths.ts";
import { resolveProjectTreeListPath } from "../../../src/core/project-fs/authorities/project-config-authority.ts";
import {
  readOwnedText,
  listProjectTreeDirents,
} from "../../../src/core/project-fs/operations.ts";
import { resolveNoFollowFlag } from "../../../src/core/project-fs/raw-internal.ts";

async function withTempProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), "code-pact-authority-"));
  try {
    return await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("project-fs authority resolvers", () => {
  it("rejects phase write authority outside design/phases", async () => {
    await withTempProject(async cwd => {
      await expect(resolvePhaseWritePath(cwd, "design/roadmap.yaml")).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
      await expect(resolvePhaseWritePath(cwd, "design/foo.yaml")).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
      await expect(
        resolvePhaseWritePath(cwd, "design/decisions/foo.yaml"),
      ).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
      await expect(
        resolvePhaseWritePath(cwd, ".code-pact/state/foo.yaml"),
      ).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
    });
  });

  it("rejects instruction write authority outside fixed instruction files", async () => {
    await withTempProject(async cwd => {
      for (const path of [
        "design/decisions/PRUNED.md",
        "design/decisions/README.md",
        "design/decisions/foo.md",
        "design/rules/foo.md",
      ]) {
        await expect(resolveInstructionWritePath(cwd, path)).rejects.toMatchObject({
          code: "PATH_NOT_OWNED",
        });
      }
    });
  });

  it("refuses O_NOFOLLOW fallback when the platform flag is unavailable", () => {
    expect(() => resolveNoFollowFlag(undefined)).toThrow(
      /O_NOFOLLOW is not supported/,
    );
    try {
      resolveNoFollowFlag(undefined);
      throw new Error("resolveNoFollowFlag unexpectedly passed");
    } catch (err) {
      expect(err).toMatchObject({ code: "ENOSYS" });
    }
  });

  it("rejects archive authority outside the archive namespace", async () => {
    await withTempProject(async cwd => {
      await expect(resolveArchiveOwnedWritePath(cwd, ".env")).rejects.toMatchObject({
        code: "CONFIG_ERROR",
      });
      expect(() => resolveArchiveOwnedPathSync(cwd, "design/roadmap.yaml")).toThrow(
        /outside the archive authority namespace/,
      );
    });
  });

  it("keeps project tree listing separate from file read authority", async () => {
    await withTempProject(async cwd => {
      const tree = await resolveProjectTreeListPath(cwd, ".");
      await expect(listProjectTreeDirents(tree)).resolves.toEqual([]);
      await expect(
        readOwnedText(
          // @ts-expect-error ProjectTreeListPath is list-only and must not read files.
          tree,
        ),
      ).rejects.toThrow();
    });
  });
});
