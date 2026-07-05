import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadReadMatches } from "../../../../src/core/pack/loaders.ts";

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
