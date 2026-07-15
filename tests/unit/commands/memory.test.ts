import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdMemory } from "../../../src/cli/commands/memory.ts";
import { runMemoryPrune } from "../../../src/commands/memory-prune.ts";
import { runMemoryStatus } from "../../../src/commands/memory-status.ts";
import { storeLoopMemoryEpisode } from "../../../src/core/loop-memory/episode-store.ts";
import type { LoopMemoryEpisode } from "../../../src/core/loop-memory/episode-schema.ts";
import { __setAfterRetentionPreflightForTests } from "../../../src/core/loop-memory/retention.ts";

let dir: string;
let originalCwd: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  dir = await mkdtemp(join(tmpdir(), "code-pact-memory-command-"));
  await mkdir(join(dir, ".code-pact"), { recursive: true });
});

afterEach(async () => {
  process.chdir(originalCwd);
  __setAfterRetentionPreflightForTests(null);
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function episode(recordedAt: string): LoopMemoryEpisode {
  return {
    schema_version: 1,
    recorded_at: recordedAt,
    kind: "verification_failed",
    task: {
      phase_id: "P58",
      task_id: "P58-T4",
      task_type: "feature",
    },
    execution: {
      lifecycle_mode: "full_loop",
      repair_mode: "bounded",
    },
    verification: {
      ok: false,
      failure_kind: "command_failed",
      failure_fingerprint: `sha256:${"a".repeat(64)}`,
      failed_check: "commands",
      failed_command: "pnpm test:unit",
    },
  };
}

describe("memory commands", () => {
  it("status reports aggregate counts without episode bodies", async () => {
    await storeLoopMemoryEpisode(dir, episode("2026-07-14T12:00:00.000Z"));

    const status = await runMemoryStatus(dir);

    expect(status).toMatchObject({
      schema_version: 1,
      episode_count: 1,
      failure_count: 1,
      success_count: 0,
      unique_task_count: 1,
      unique_fingerprint_count: 1,
      corrupt_count: 0,
    });
    expect(JSON.stringify(status)).not.toContain("pnpm test:unit");
  });

  it("prune is dry-run by default and --write applies candidates", async () => {
    await storeLoopMemoryEpisode(dir, episode("2026-01-01T00:00:00.000Z"));

    const dryRun = await runMemoryPrune(dir);
    expect(dryRun.write).toBe(false);
    expect(dryRun.would_remove.episode_count).toBe(1);
    expect((await runMemoryStatus(dir)).episode_count).toBe(1);

    const write = await runMemoryPrune(dir, { write: true });
    expect(write.write).toBe(true);
    expect(write.would_remove.episode_count).toBe(1);
    expect((await runMemoryStatus(dir)).episode_count).toBe(0);
  });

  it("emits JSON error envelopes for unsafe cache roots", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-memory-outside-"));
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await rm(join(dir, ".code-pact", "cache"), { recursive: true, force: true });
      await symlink(outside, join(dir, ".code-pact", "cache"));
      process.chdir(dir);

      const exit = await cmdMemory(["status", "--json"], "en-US", false);

      expect(exit).toBe(1);
      const envelope = JSON.parse(writes.join(""));
      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: "MEMORY_PATH_UNSAFE",
          message: "Local loop-memory cache path is unsafe.",
        },
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("emits prune conflict metadata as JSON without human guidance or paths", async () => {
    const old = await storeLoopMemoryEpisode(dir, episode("2026-01-01T00:00:00.000Z"));
    __setAfterRetentionPreflightForTests(async () => {
      await writeFile(
        join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", old.filename),
        Buffer.from([0xff]),
      );
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    process.chdir(dir);

    const exit = await cmdMemory(["prune", "--write", "--json"], "en-US", false);

    expect(exit).toBe(1);
    expect(stderr.join("")).toBe("");
    const text = stdout.join("");
    const envelope = JSON.parse(text);
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "MEMORY_PRUNE_CONFLICT",
        message: "Local loop-memory retention candidates changed before deletion.",
      },
      data: {
        partial_applied: false,
        deleted_count: 0,
      },
    });
    expect(text).not.toContain(old.filename);
    expect(text).not.toContain(dir);
    expect(text).not.toContain("code-pact memory status");
  });
});
