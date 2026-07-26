import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { currentVerificationState } from "../../../src/core/verification-ledger.ts";
import * as projectFs from "../../../src/core/project-fs/index.ts";
import * as boundedCommand from "../../../src/core/process/bounded-command.ts";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function setupRepo(dir: string): Promise<void> {
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "tracked.ts"), "initial\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "initial"]);
}

describe("currentVerificationState", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "code-pact-verification-ledger-"));
    await setupRepo(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("changes digest when tracked file content changes", async () => {
    const before = await currentVerificationState(dir);
    await writeFile(join(dir, "src", "tracked.ts"), "changed\n", "utf8");

    const after = await currentVerificationState(dir);

    expect(after.workingTreeDiffDigest).not.toBe(before.workingTreeDiffDigest);
  });

  it("changes digest when staged file content changes", async () => {
    await writeFile(join(dir, "src", "tracked.ts"), "staged-a\n", "utf8");
    git(dir, ["add", "src/tracked.ts"]);
    const stagedA = await currentVerificationState(dir);

    await writeFile(join(dir, "src", "tracked.ts"), "staged-b\n", "utf8");
    git(dir, ["add", "src/tracked.ts"]);
    const stagedB = await currentVerificationState(dir);

    expect(stagedB.workingTreeDiffDigest).not.toBe(
      stagedA.workingTreeDiffDigest,
    );
  });

  it("changes digest when an untracked file is created", async () => {
    const before = await currentVerificationState(dir);
    await writeFile(join(dir, "src", "new.ts"), "one\n", "utf8");

    const after = await currentVerificationState(dir);

    expect(after.workingTreeDiffDigest).not.toBe(before.workingTreeDiffDigest);
  });

  it("changes digest when the same untracked path changes content", async () => {
    await writeFile(join(dir, "src", "new.ts"), "one\n", "utf8");
    const one = await currentVerificationState(dir);

    await writeFile(join(dir, "src", "new.ts"), "two\n", "utf8");
    const two = await currentVerificationState(dir);

    expect(two.workingTreeDiffDigest).not.toBe(one.workingTreeDiffDigest);
  });

  it("changes digest when an untracked file is deleted", async () => {
    await writeFile(join(dir, "src", "new.ts"), "one\n", "utf8");
    const withFile = await currentVerificationState(dir);

    await rm(join(dir, "src", "new.ts"));
    const withoutFile = await currentVerificationState(dir);

    expect(withoutFile.workingTreeDiffDigest).not.toBe(
      withFile.workingTreeDiffDigest,
    );
  });

  it("hashes untracked symlink target text without reading the target", async () => {
    const external = await mkdtemp(join(tmpdir(), "code-pact-symlink-target-"));
    const externalA = join(external, "outside-a.txt");
    const externalB = join(external, "outside-b.txt");
    await writeFile(externalA, "outside-one\n", "utf8");
    await writeFile(externalB, "outside-two\n", "utf8");
    try {
      try {
        await symlink(externalA, join(dir, "src", "link"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw error;
      }
      const targetA = await currentVerificationState(dir);

      await rm(join(dir, "src", "link"));
      await symlink(externalB, join(dir, "src", "link"));
      const targetB = await currentVerificationState(dir);
      expect(targetB.workingTreeDiffDigest).not.toBe(
        targetA.workingTreeDiffDigest,
      );

      await rm(join(dir, "src", "link"));
      await symlink(externalA, join(dir, "src", "link"));
      const targetAAgain = await currentVerificationState(dir);
      await writeFile(externalA, "outside-mutated\n", "utf8");
      const targetContentChanged = await currentVerificationState(dir);
      expect(targetContentChanged.workingTreeDiffDigest).toBe(
        targetAAgain.workingTreeDiffDigest,
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  it("ignores verification ledger cache changes", async () => {
    const before = await currentVerificationState(dir);
    await mkdir(join(dir, ".code-pact", "cache", "verification-runs"), {
      recursive: true,
    });
    await writeFile(
      join(dir, ".code-pact", "cache", "verification-runs", "ledger.jsonl"),
      "{\"ok\":true}\n",
      "utf8",
    );

    const after = await currentVerificationState(dir);

    expect(after.workingTreeDiffDigest).toBe(before.workingTreeDiffDigest);
  });

  it("fails closed outside a Git repository", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "code-pact-non-git-"));
    try {
      await expect(currentVerificationState(nonGit)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_UNAVAILABLE",
        operation: "git rev-parse HEAD",
      });
    } finally {
      await rm(nonGit, { recursive: true, force: true });
    }
  });

  it("fails closed when Git state commands fail", async () => {
    await rm(join(dir, ".git"), { recursive: true, force: true });
    await mkdir(join(dir, ".git"));

    await expect(currentVerificationState(dir)).rejects.toMatchObject({
      code: "VERIFICATION_STATE_UNAVAILABLE",
    });
  });

  it("changes digest for a change after a diff larger than the capture limit", async () => {
    // "a.txt" sorts before "z.txt", so its diff fills the generic 1 MiB stdout
    // capture before Git ever emits the z.txt hunk.
    const filler = `${"line padding padding padding padding".repeat(2)}\n`;
    await writeFile(join(dir, "src", "a.txt"), "", "utf8");
    await writeFile(join(dir, "src", "z.txt"), "z0\n", "utf8");
    git(dir, ["add", "."]);
    git(dir, ["commit", "--quiet", "-m", "large-diff-base"]);
    await writeFile(
      join(dir, "src", "a.txt"),
      filler.repeat(Math.ceil((2 * 1024 * 1024) / filler.length)),
      "utf8",
    );

    await writeFile(join(dir, "src", "z.txt"), "z1\n", "utf8");
    const first = await currentVerificationState(dir);

    await writeFile(join(dir, "src", "z.txt"), "z2\n", "utf8");
    const second = await currentVerificationState(dir);

    expect(second.workingTreeDiffDigest).not.toBe(first.workingTreeDiffDigest);
  });

  it("keeps a diff larger than the capture limit available rather than failing closed", async () => {
    const filler = `${"line padding padding padding padding".repeat(2)}\n`;
    await writeFile(
      join(dir, "src", "tracked.ts"),
      filler.repeat(Math.ceil((2 * 1024 * 1024) / filler.length)),
      "utf8",
    );

    const state = await currentVerificationState(dir);

    expect(state.workingTreeDiffDigest).toMatch(/^[0-9a-f]{64}$/);
    // The digest is the only retained representation of that output.
    expect(JSON.stringify(state).length).toBeLessThan(1024);
  });

  it("fails closed when untracked hashing exceeds its deadline", async () => {
    await writeFile(join(dir, "src", "new.ts"), "one\n", "utf8");
    const hashSpy = vi
      .spyOn(projectFs, "hashOwnedRegularFileSha256")
      .mockImplementation(async () => {
        const error = new Error("hashing exceeded its deadline");
        (error as NodeJS.ErrnoException).code = "ETIMEDOUT";
        throw error;
      });

    try {
      await expect(currentVerificationState(dir)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_UNAVAILABLE",
        operation: "hash untracked file content",
        timed_out: true,
      });
    } finally {
      hashSpy.mockRestore();
    }
  });

  it("fails closed when untracked hashing is aborted", async () => {
    await writeFile(join(dir, "src", "new.ts"), "one\n", "utf8");
    const hashSpy = vi
      .spyOn(projectFs, "hashOwnedRegularFileSha256")
      .mockImplementation(async () => {
        const error = new Error("hashing was aborted");
        (error as NodeJS.ErrnoException).code = "ABORT_ERR";
        throw error;
      });

    try {
      await expect(currentVerificationState(dir)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_UNAVAILABLE",
        operation: "hash untracked file content",
        aborted: true,
      });
    } finally {
      hashSpy.mockRestore();
    }
  });

  it("fails closed when a captured Git command truncates its output", async () => {
    const runSpy = vi
      .spyOn(boundedCommand, "runBoundedCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "0".repeat(40),
        stderr: "",
        stdoutTruncated: true,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
        elapsedMs: 1,
      });

    try {
      await expect(currentVerificationState(dir)).rejects.toMatchObject({
        code: "VERIFICATION_STATE_UNAVAILABLE",
        operation: "git rev-parse HEAD",
      });
    } finally {
      runSpy.mockRestore();
    }
  });

  it("fails closed for unsupported untracked file types", async () => {
    const fifoPath = join(dir, "src", "pipe");
    const created = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    if (created.status !== 0) return;
    const listed = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z", "--", "src/pipe"],
      { cwd: dir, encoding: "utf8" },
    );
    if (!listed.stdout.includes("src/pipe")) return;

    await expect(currentVerificationState(dir)).rejects.toMatchObject({
      code: "VERIFICATION_STATE_UNAVAILABLE",
      operation: "hash untracked entry",
    });
  });
});
