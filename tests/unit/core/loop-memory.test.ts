import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalJson } from "../../../src/core/content-addressed-store/canonical-json.ts";
import {
  LOOP_MEMORY_RETENTION_LIMITS,
  __setAfterRetentionPreflightForTests,
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
  loopMemoryEpisodeFilename,
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
  __setAfterRetentionPreflightForTests(null);
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

async function writeRawEpisode(
  filename: string,
  content: string | Buffer,
): Promise<void> {
  await mkdir(join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes"), {
    recursive: true,
  });
  const path = join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", filename);
  if (typeof content === "string") {
    await writeFile(path, content, "utf8");
  } else {
    await writeFile(path, content);
  }
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

  it("uses plan identity and task type schemas for episode task identity", () => {
    expect(() =>
      LoopMemoryEpisodeSchema.parse(episode({ task: { phase_id: "../P58" } })),
    ).toThrow();
    expect(() =>
      LoopMemoryEpisodeSchema.parse(episode({ task: { task_id: "P58/T2" } })),
    ).toThrow();
    expect(() =>
      LoopMemoryEpisodeSchema.parse(
        episode({ task: { task_type: "security" as LoopMemoryEpisode["task"]["task_type"] } }),
      ),
    ).toThrow();
    expect(LoopMemoryEpisodeSchema.parse(episode()).task).toMatchObject({
      phase_id: "P58",
      task_id: "P58-T2",
      task_type: "feature",
    });
  });

  it("rejects oversized commands, absolute paths, evidence_ref, and oversized episodes", () => {
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
    for (const command of [
      "--config=/tmp/config.json",
      "cat >/tmp/config.json",
      "cat </tmp/config.json",
      "node `/tmp/script.js`",
      "--config=[/tmp/config.json]",
      "open file:///tmp/config.json",
      'node "/tmp/script.js"',
      "--path=C:\\work\\file.ts",
      "--path=C:/work/file.ts",
      "\\\\server\\share\\file",
      "//server/share/file",
    ]) {
      expect(() =>
        LoopMemoryEpisodeSchema.parse(
          episode({ verification: { failed_command: command } }),
        ),
      ).toThrow();
    }
    expect(
      LoopMemoryEpisodeSchema.parse(
        episode({ verification: { failed_command: "pnpm vitest run tests/unit/foo.test.ts" } }),
      ).verification.failed_command,
    ).toBe("pnpm vitest run tests/unit/foo.test.ts");
    expect(() =>
      LoopMemoryEpisodeSchema.parse({
        ...episode(),
        verification: {
          ...episode().verification,
          evidence_ref: `evidence:sha256:${"b".repeat(64)}`,
        },
      }),
    ).toThrow();

    const huge = episode({
      verification: {
        failed_command: "x".repeat(512),
        failed_check: "y".repeat(128),
        failure_fingerprint: `sha256:${"c".repeat(64)}`,
      },
      task: { task_id: "T".repeat(MAX_EPISODE_BYTES) },
    });
    expect(() => parseLoopMemoryEpisode(huge)).toThrow(/exceeds/);
  });

  it("accepts only canonical UTC recorded_at timestamps", () => {
    expect(LoopMemoryEpisodeSchema.parse(episode({}, "2026-07-14T12:01:02.345Z")).recorded_at).toBe(
      "2026-07-14T12:01:02.345Z",
    );
    for (const recordedAt of [
      "2026-99-99T99:99:99.999Z",
      "2026-02-31T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-07-14T24:00:00.000Z",
      "2026-07-14T12:01:02Z",
      "2026-07-14T12:01:02.345+09:00",
    ]) {
      expect(() =>
        LoopMemoryEpisodeSchema.parse(episode({}, recordedAt)),
      ).toThrow();
    }
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

  it("treats oversized same-filename content as a closed collision", async () => {
    const stored = await storeLoopMemoryEpisode(dir, episode());
    await writeRawEpisode(stored.filename, "{".padEnd(MAX_EPISODE_BYTES + 1, "x"));

    await expect(storeLoopMemoryEpisode(dir, episode())).rejects.toThrow(
      /filename collision/,
    );
  });

  it("treats invalid UTF-8 same-filename content as a closed collision", async () => {
    const stored = await storeLoopMemoryEpisode(dir, episode());
    await writeRawEpisode(stored.filename, Buffer.from([0xff]));

    await expect(storeLoopMemoryEpisode(dir, episode())).rejects.toThrow(
      /filename collision/,
    );
  });

  it("rejects invalid UTF-8 bytes before JSON and identity checks", async () => {
    const filename = `${utcBasicTimestamp(new Date("2026-07-14T12:01:06.345Z"))}-4444444444444444.json`;
    const replacementEpisode = episode(
      { verification: { failed_command: "bad \uFFFD byte" } },
      "2026-07-14T12:01:06.345Z",
    );
    const replacementRaw = canonicalJson(replacementEpisode);
    const replacementBytes = Buffer.from(replacementRaw, "utf8");
    const replacementAt = replacementBytes.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    expect(replacementAt).toBeGreaterThanOrEqual(0);
    const spoofedBytes = Buffer.from(replacementBytes);
    spoofedBytes[replacementAt] = 0xff;
    spoofedBytes[replacementAt + 1] = 0xff;
    spoofedBytes[replacementAt + 2] = 0xff;

    await writeRawEpisode(filename, Buffer.from([0xff]));
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:07.345Z"))}-5555555555555555.json`,
      Buffer.from([0xc0, 0xaf]),
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:08.345Z"))}-6666666666666666.json`,
      Buffer.from([0xe2, 0x82]),
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:09.345Z"))}-7777777777777777.json`,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(canonicalJson(episode({}, "2026-07-14T12:01:09.345Z"))),
      ]),
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:10.345Z"))}-8888888888888888.json`,
      spoofedBytes,
    );

    const scan = await scanLoopMemoryEpisodes(dir);

    expect(scan.episodes).toHaveLength(0);
    expect(scan.corrupt.map(c => c.reason).sort()).toEqual([
      "invalid_json",
      "invalid_utf8",
      "invalid_utf8",
      "invalid_utf8",
      "invalid_utf8",
    ]);
  });

  it("isolates malformed, oversized, non-canonical, identity-mismatched, and unsafe files during scan", async () => {
    const stored = await storeLoopMemoryEpisode(dir, episode());
    await writeRawEpisode("not-an-episode.json", "{}");
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:02.346Z"))}-aaaaaaaaaaaaaaaa.json`,
      "{".padEnd(MAX_EPISODE_BYTES + 1, "x"),
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:03.345Z"))}-1111111111111111.json`,
      "{bad",
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:04.345Z"))}-2222222222222222.json`,
      JSON.stringify(episode({}, "2026-07-14T12:01:04.345Z")),
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:05.345Z"))}-3333333333333333.json`,
      canonicalJson(episode({}, "2026-07-14T12:01:05.345Z")),
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:06.345Z"))}-4444444444444444.json`,
      canonicalJson(episode({}, "2026-99-99T99:99:99.999Z")),
    );

    const scan = await scanLoopMemoryEpisodes(dir);
    expect(scan.episodes.map(e => e.filename)).toEqual([stored.filename]);
    expect(scan.corrupt.map(c => c.reason).sort()).toEqual([
      "identity_mismatch",
      "invalid_filename",
      "invalid_json",
      "oversized",
      "schema_invalid",
      "schema_invalid",
    ]);
    expect(scan.corrupt.find(c => c.reason === "oversized")?.bytes).toBeGreaterThan(
      MAX_EPISODE_BYTES,
    );
  });

  it("treats a valid episode renamed to another valid filename as identity mismatch", async () => {
    const source = episode({}, "2026-07-14T12:01:05.345Z");
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:01:05.345Z"))}-3333333333333333.json`,
      canonicalJson(source),
    );

    const scan = await scanLoopMemoryEpisodes(dir);

    expect(scan.episodes).toHaveLength(0);
    expect(scan.corrupt).toEqual([
      {
        filename: `${utcBasicTimestamp(new Date("2026-07-14T12:01:05.345Z"))}-3333333333333333.json`,
        reason: "identity_mismatch",
        bytes: Buffer.byteLength(canonicalJson(source), "utf8"),
      },
    ]);
    expect(loopMemoryEpisodeFilename(source)).not.toBe(scan.corrupt[0]!.filename);
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

  it("reports nonregular episode entries without following or reading them", async () => {
    const outside = await mkdtemp(join(tmpdir(), "code-pact-loop-memory-target-"));
    const target = join(outside, "target.json");
    await writeFile(target, canonicalJson(episode()), "utf8");
    const symlinkName = `${utcBasicTimestamp(new Date("2026-07-14T12:02:00.000Z"))}-aaaaaaaaaaaaaaaa.json`;
    const directoryName = `${utcBasicTimestamp(new Date("2026-07-14T12:02:01.000Z"))}-bbbbbbbbbbbbbbbb.json`;
    await mkdir(join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes"), {
      recursive: true,
    });
    await symlink(
      target,
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", symlinkName),
    );
    await mkdir(
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", directoryName),
    );
    try {
      const scan = await scanLoopMemoryEpisodes(dir);

      expect(scan.episodes).toHaveLength(0);
      expect(scan.corrupt).toEqual([
        {
          filename: symlinkName,
          reason: "non_regular",
          entry_kind: "symlink",
        },
        {
          filename: directoryName,
          reason: "non_regular",
          entry_kind: "directory",
        },
      ]);
      expect(JSON.stringify(await loopMemoryStatus(dir))).not.toContain(target);
    } finally {
      await rm(outside, { recursive: true, force: true });
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
  }, 10_000);

  it("counts protected episodes inside per-task retention caps", async () => {
    const sameTask = await storedEpisodes(
      LOOP_MEMORY_RETENTION_LIMITS.maxEpisodesPerTask + 1,
      i =>
        episode(
          {
            task: { task_id: "P58-T-protected-task" },
            verification: {
              failure_fingerprint: `sha256:${i.toString(16).padStart(64, "0")}`,
            },
          },
          new Date(Date.parse("2026-07-14T00:00:00.000Z") + i * 1000).toISOString(),
        ),
    );
    const protectedEpisode = sameTask[0]!;
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
      protectedFilename: protectedEpisode.filename,
    });

    expect(plan.remove.some(c => c.episode.filename === protectedEpisode.filename)).toBe(false);
    expect(plan.remove.filter(c => c.reason === "over_task_limit")).toHaveLength(1);
    expect(plan.keep.filter(e => e.episode.task.task_id === "P58-T-protected-task"))
      .toHaveLength(LOOP_MEMORY_RETENTION_LIMITS.maxEpisodesPerTask);
    expect(plan.keep.some(e => e.filename === protectedEpisode.filename)).toBe(true);
  });

  it("counts protected episodes inside per-fingerprint retention caps", async () => {
    const fingerprint = `sha256:${"f".repeat(64)}`;
    const sameFingerprint = await storedEpisodes(
      LOOP_MEMORY_RETENTION_LIMITS.maxEpisodesPerFingerprint + 1,
      i =>
        episode(
          {
            task: { task_id: `P58-T-protected-fingerprint-${i}` },
            verification: {
              failure_fingerprint: fingerprint,
            },
          },
          new Date(Date.parse("2026-07-14T00:00:00.000Z") + i * 1000).toISOString(),
        ),
    );
    const protectedEpisode = sameFingerprint[0]!;
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
      protectedFilename: protectedEpisode.filename,
    });

    expect(plan.remove.some(c => c.episode.filename === protectedEpisode.filename)).toBe(false);
    expect(plan.remove.filter(c => c.reason === "over_fingerprint_limit")).toHaveLength(1);
    expect(
      plan.keep.filter(e => e.episode.verification.failure_fingerprint === fingerprint),
    ).toHaveLength(LOOP_MEMORY_RETENTION_LIMITS.maxEpisodesPerFingerprint);
    expect(plan.keep.some(e => e.filename === protectedEpisode.filename)).toBe(true);
  });

  it("does not delete any candidate when retention preflight sees changed bytes", async () => {
    const first = await storeLoopMemoryEpisode(
      dir,
      episode({}, "2026-01-01T00:00:00.000Z"),
    );
    const second = await storeLoopMemoryEpisode(
      dir,
      episode({ task: { task_id: "P58-T9" } }, "2026-01-01T00:00:01.000Z"),
    );
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    await writeRawEpisode(second.filename, canonicalJson({
      ...second.episode,
      task: { ...second.episode.task, task_id: "P58-T10" },
    }));

    await expect(applyLoopMemoryRetention(dir, plan)).rejects.toMatchObject({
      code: "MEMORY_PRUNE_CONFLICT",
    });

    const after = await scanLoopMemoryEpisodes(dir);
    expect(after.episodes.map(e => e.filename)).toContain(first.filename);
  });

  it("treats oversized retention candidates as prune conflicts without deleting", async () => {
    const old = await storeLoopMemoryEpisode(
      dir,
      episode({}, "2026-01-01T00:00:00.000Z"),
    );
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    await writeRawEpisode(old.filename, "{".padEnd(MAX_EPISODE_BYTES + 1, "x"));

    await expect(applyLoopMemoryRetention(dir, plan)).rejects.toMatchObject({
      code: "MEMORY_PRUNE_CONFLICT",
    });
    await expect(
      readFile(
        join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", old.filename),
        "utf8",
      ),
    ).resolves.toHaveLength(MAX_EPISODE_BYTES + 1);
  });

  it("treats invalid UTF-8 retention candidates as prune conflicts", async () => {
    const old = await storeLoopMemoryEpisode(
      dir,
      episode({}, "2026-01-01T00:00:00.000Z"),
    );
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    await writeRawEpisode(old.filename, Buffer.from([0xff]));

    await expect(applyLoopMemoryRetention(dir, plan)).rejects.toMatchObject({
      code: "MEMORY_PRUNE_CONFLICT",
    });
    const after = await scanLoopMemoryEpisodes(dir);
    expect(after.corrupt).toEqual([
      {
        filename: old.filename,
        reason: "invalid_utf8",
      },
    ]);
  });

  it("treats concurrent deletion after retention preflight as idempotent", async () => {
    const old = await storeLoopMemoryEpisode(
      dir,
      episode({}, "2026-01-01T00:00:00.000Z"),
    );
    const scan = await scanLoopMemoryEpisodes(dir);
    const plan = planLoopMemoryRetention(scan.episodes, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    __setAfterRetentionPreflightForTests(async () => {
      await unlink(
        join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", old.filename),
      );
    });

    await expect(applyLoopMemoryRetention(dir, plan)).resolves.toBeUndefined();
    expect((await scanLoopMemoryEpisodes(dir)).episodes).toHaveLength(0);
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

  it("reports known corrupt bytes and unmeasured corrupt entries separately", async () => {
    const invalidJson = "{bad";
    const schemaInvalid = canonicalJson({
      ...episode({}, "2026-07-14T12:03:00.000Z"),
      task: { ...episode().task, task_id: "../unsafe" },
    });
    const identitySource = canonicalJson(episode({}, "2026-07-14T12:03:01.000Z"));
    const oversized = "{".padEnd(MAX_EPISODE_BYTES + 1, "x");
    await writeRawEpisode("not-an-episode.json", "{}");
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:03:00.000Z"))}-1111111111111111.json`,
      schemaInvalid,
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:03:01.000Z"))}-2222222222222222.json`,
      identitySource,
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:03:02.000Z"))}-3333333333333333.json`,
      invalidJson,
    );
    await writeRawEpisode(
      `${utcBasicTimestamp(new Date("2026-07-14T12:03:03.000Z"))}-4444444444444444.json`,
      oversized,
    );
    const symlinkName = `${utcBasicTimestamp(new Date("2026-07-14T12:03:04.000Z"))}-5555555555555555.json`;
    const target = join(dir, ".code-pact", "cache", "loop-memory", "v1", "target.json");
    await writeFile(target, canonicalJson(episode()), "utf8");
    await symlink(
      target,
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", symlinkName),
    );

    const status = await loopMemoryStatus(dir, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(status.corrupt_count).toBe(6);
    expect(status.corrupt_bytes).toBe(
      Buffer.byteLength(schemaInvalid, "utf8") +
        Buffer.byteLength(identitySource, "utf8") +
        Buffer.byteLength(invalidJson, "utf8") +
        Buffer.byteLength(oversized, "utf8"),
    );
    expect(status.corrupt_unmeasured_count).toBe(2);
    expect(JSON.stringify(status)).not.toContain("target.json");
    expect(JSON.stringify(status)).not.toContain("pnpm test:unit");
  });

  it("does not include corrupt nonregular entries in prune candidates or delete them", async () => {
    await storeLoopMemoryEpisode(dir, episode({}, "2026-01-01T00:00:00.000Z"));
    const symlinkName = `${utcBasicTimestamp(new Date("2026-07-14T12:04:00.000Z"))}-aaaaaaaaaaaaaaaa.json`;
    const target = join(dir, ".code-pact", "cache", "loop-memory", "v1", "target.json");
    await writeFile(target, canonicalJson(episode()), "utf8");
    await symlink(
      target,
      join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", symlinkName),
    );

    const dry = await pruneLoopMemoryEpisodes(dir, {
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(dry.remove).toHaveLength(1);

    await pruneLoopMemoryEpisodes(dir, {
      write: true,
      now: new Date("2026-07-14T12:00:00.000Z"),
    });
    expect(
      (
        await lstat(
          join(dir, ".code-pact", "cache", "loop-memory", "v1", "episodes", symlinkName),
        )
      ).isSymbolicLink(),
    ).toBe(true);
    const after = await scanLoopMemoryEpisodes(dir);
    expect(after.episodes).toHaveLength(0);
    expect(after.corrupt).toHaveLength(1);
  });
});
