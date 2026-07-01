import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveInstructionWritePath,
  resolvePhaseWritePath,
} from "../../../src/core/project-fs/index.ts";
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
});
