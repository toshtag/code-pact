import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMemoryPrune } from "../../../src/commands/memory-prune.ts";
import { runMemoryStatus } from "../../../src/commands/memory-status.ts";
import { storeLoopMemoryEpisode } from "../../../src/core/loop-memory/episode-store.ts";
import type { LoopMemoryEpisode } from "../../../src/core/loop-memory/episode-schema.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-memory-command-"));
  await mkdir(join(dir, ".code-pact"), { recursive: true });
});

afterEach(async () => {
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
});
