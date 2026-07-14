import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "../../../src/core/content-addressed-store/canonical-json.ts";
import {
  LOOP_MEMORY_RETENTION_LIMITS,
  applyLoopMemoryRetention,
  planLoopMemoryRetention,
  pruneLoopMemoryEpisodes,
} from "../../../src/core/loop-memory/retention.ts";
import {
  MAX_EPISODE_BYTES,
  LoopMemoryEpisodeSchema,
  type LoopMemoryEpisode,
  parseLoopMemoryEpisode,
} from "../../../src/core/loop-memory/episode-schema.ts";
import {
  utcBasicTimestamp,
} from "../../../src/core/loop-memory/episode-id.ts";
import {
  scanLoopMemoryEpisodes,
  storeLoopMemoryEpisode,
} from "../../../src/core/loop-memory/episode-store.ts";
import { loopMemoryStatus } from "../../../src/core/loop-memory/status.ts";

let dir: string;

type EpisodeOverrides = Omit<
  Partial<LoopMemoryEpisode>,
  "task" | "execution" | "verification"
> & {
  task?: Partial<LoopMemoryEpisode["task"]>;
  execution?: Partial<LoopMemoryEpisode["execution"]>;
  verification?: Partial<LoopMemoryEpisode["verification"]>;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-pact-loop-memory-"));
  await mkdir(join(dir, ".code-pact"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function episode(
  overrides: EpisodeOverrides = {},
  recordedAt = "2026-07-14T12:01:02.345Z",
): LoopMemoryEpisode {
  const base: LoopMemoryEpisode = {
    schema_version: 1,
    recorded_at: recordedAt,
    kind: "verification_failed",
    task: {
      phase_id: "P58",
      task_id: "P58-T2",
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
      evidence_ref: `evidence:sha256:${"b".repeat(64)}`,
    },
  };
  return {
    ...base,
    ...overrides,
    task: { ...base.task, ...overrides.task },
    execution: { ...base.execution, ...overrides.execution },
    verification:
      overrides.verification?.ok === true
        ? (overrides.verification as LoopMemoryEpisode["verification"])
        : { ...base.verification, ...overrides.verification },
  };
}

function passed(recordedAt = "2026-07-14T12:01:02.345Z"): LoopMemoryEpisode {
  return episode(
    {
      kind: "verification_passed",
      verification: { ok: true },
    },
    recordedAt,
  );
}

async function writeRawEpisode(filename: string, content: string): Promise<void> {
  await mkdir(join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes"), {
    recursive: true,
  });
  await writeFile(
    join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", filename),
    content,
    "utf8",
  );
}

describe("loop memory episode schema", () => {
  it("accepts success and failure episodes", () => {
    expect(LoopMemoryEpisodeSchema.parse(passed()).verification.ok).toBe(true);
    expect(LoopMemoryEpisodeSchema.parse(episode()).verification.ok).toBe(false);
  });

  it("rejects failure fields on success episodes", () => {
    expect(() =>
      LoopMemoryEpisodeSchema.parse({
        ...passed(),
        verification: {
          ok: true,
          failure_kind: "command_failed",
        },
      }),
    ).toThrow();
  });

  it("rejects failures without failure kind and unknown fields", () => {
    expect(() =>
      LoopMemoryEpisodeSchema.parse({
        ...episode(),
        verification: { ok: false },
      }),
    ).toThrow();

    expect(() =>
      LoopMemoryEpisodeSchema.parse({
        ...episode(),
        prompt: "never store prompts",
      }),
    ).toThrow();
  });

  it("rejects oversized commands, absolute paths, and oversized episodes", () => {
    expect(() =>
      LoopMemoryEpisodeSchema.parse(
        episode({ verification: { failed_command: "x".repeat(513) } }),
      ),
    ).toThrow();
    expect(() =>
      LoopMemoryEpisodeSchema.parse(
        episode({ verification: { failed_command: "node /tmp/outside.js" } }),
      ),
    ).toThrow();

    const huge = episode({
      verification: {
        failed_command: "x".repeat(512),
        failed_check: "y".repeat(128),
        failure_fingerprint: `sha256:${"c".repeat(64)}`,
        evidence_ref: `evidence:sha256:${"d".repeat(64)}`,
      },
      task: { task_id: "T".repeat(MAX_EPISODE_BYTES) },
    });
    expect(() => parseLoopMemoryEpisode(huge)).toThrow(/exceeds/);
  });
});

describe("loop memory store", () => {
  it("stores canonical one-record JSON and treats same-byte collision as idempotent", async () => {
    const first = await storeLoopMemoryEpisode(dir, episode());
    const second = await storeLoopMemoryEpisode(dir, episode());

    expect(second.filename).toBe(first.filename);
    expect(first.filename).toMatch(/^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{16}\.json$/);
    const raw = await readFile(
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", first.filename),
      "utf8",
    );
    expect(raw).toBe(canonicalJson(episode()));
  });

  it("rejects different bytes at the same filename", async () => {
    const stored = await storeLoopMemoryEpisode(dir, episode());
    await writeRawEpisode(stored.filename, canonicalJson({ ...episode(), schema_version: 1 }));
    await writeFile(
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", stored.filename),
      canonicalJson({ ...episode(), task: { ...episode().task, task_id: "P58-T9" } }),
      "utf8",
    );

    await expect(storeLoopMemoryEpisode(dir, episode())).rejects.toThrow(
      /filename collision/,
    );
  });

  it("isolates malformed, non-canonical, and unsafe files during scan", async () => {
    const stored = await storeLoopMemoryEpisode(dir, episode());
    await writeRawEpisode("not-an-episode.json", "{}");
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:03.345Z"))}-1111111111111111.json`,
      "{bad",
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:04.345Z"))}-2222222222222222.json`,
      JSON.stringify(episode({}, "2026-07-14T12:01:04.345Z")),
    );

    const scan = await scanLoopMemoryEpisodes(dir);
    expect(scan.episodes.map(e => e.filename)).toEqual([stored.filename]);
    expect(scan.corrupt.map(c => c.reason).sort()).toEqual([
      "invalid_filename",
      "invalid_json",
      "schema_invalid",
    ]);
  });

  it("rejects cache root and episode directory symlinks before writing outside project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-loop-memory-outside-"));
    await symlink(outside, join(dir, ".code-pact", "cache"));
    try {
      await expect(storeLoopMemoryEpisode(dir, episode())).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), "code-pact-loop-memory-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "code-pact-loop-memory-dir-"));
    await mkdir(join(dir, ".code-pact", "cache", "loop-memory", "v1"), {
      recursive: true,
    });
    await symlink(
      outsideDir,
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes"),
    );
    try {
      await expect(storeLoopMemoryEpisode(dir, episode())).rejects.toMatchObject({
        code: "PATH_NOT_OWNED",
      });
      await expect(readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("loop memory retention", () => {
  async function storedEpisodes(count: number, make: (i: number) => LoopMemoryEpisode) {
    const out = [];
    for (let i = 0; i < count; i += 1) {
      out.push(await storeLoopMemoryEpisode(dir, make(i)));
    }
    return out;
  }

  it("plans age, per-task, per-fingerprint, count, and byte removals deterministically", async () => {
    const old = await storeLoopMemoryEpisode(
      dir,
      episode({}, "2026-01-01T00:00:00.000Z"),
    );
    const perTask = await storedEpisodes(9, i =>
      episode(
        {
          verification: {
            failure_fingerprint: `sha256:${String(i).repeat(64).slice(0, 64)}`,
          },
        },
        `2026-07-14T00:00:0${i}.000Z`,
      ),
    );
    const perFingerprint = await storedEpisodes(5, i =>
      episode(
        {
          task: { task_id: `P58-T${i + 10}` },
          verification: {
            failure_fingerprint: `sha256:${"f".repeat(64)}`,
          },
        },
        `2026-07-14T00:01:0${i}.000Z`,
      ),
    );

    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    const byReason = new Map(plan.remove.map(c => [c.episode.filename, c.reason]));

    expect(byReason.get(old.filename)).toBe("expired");
    expect(byReason.get(perTask[0]!.filename)).toBe("over_task_limit");
    expect(byReason.get(perFingerprint[0]!.filename)).toBe("over_fingerprint_limit");
  });

  it("caps total count, preserves protected new episode, and applies only candidates", async () => {
    const base = Date.parse("2026-07-14T00:00:00.000Z");
    const episodes = await storedEpisodes(
      LOOP_MEMORY_RETENTION_LIMITS.maxEpisodes + 1,
      i =>
        episode(
          {
            task: { task_id: `P58-T${i}` },
            verification: {
              failure_fingerprint: `sha256:${i.toString(16).padStart(64, "0")}`,
            },
          },
          new Date(base + i * 1000).toISOString(),
        ),
    );
    const protectedEpisode = episodes[0]!;
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
      protectedFilename: protectedEpisode.filename,
    });

    expect(plan.remove.some(c => c.episode.filename === protectedEpisode.filename)).toBe(false);
    expect(plan.keep).toHaveLength(LOOP_MEMORY_RETENTION_LIMITS.maxEpisodes);

    await applyLoopMemoryRetention(dir, plan);
    const after = await scanLoopMemoryEpisodes(dir);
    expect(after.episodes).toHaveLength(LOOP_MEMORY_RETENTION_LIMITS.maxEpisodes);
    expect(after.episodes.some(e => e.filename === protectedEpisode.filename)).toBe(true);
  });

  it("dry-runs by default and reports status without episode bodies", async () => {
    await storeLoopMemoryEpisode(dir, episode({}, "2026-01-01T00:00:00.000Z"));
    await storeLoopMemoryEpisode(dir, passed("2026-07-14T12:00:00.000Z"));

    const dry = await pruneLoopMemoryEpisodes(dir, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(dry.remove).toHaveLength(1);
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(2);

    const status = await loopMemoryStatus(dir, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(status).toMatchObject({
      schema_version: 1,
      episode_count: 2,
      failure_count: 1,
      success_count: 1,
      expired_count: 1,
      corrupt_count: 0,
    });
    expect(JSON.stringify(status)).not.toContain("pnpm test:unit");

    await pruneLoopMemoryEpisodes(dir, {
      write: true,
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(1);
  });
});
