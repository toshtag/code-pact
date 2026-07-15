import {
  compareStoredEpisodes,
  deleteStoredLoopMemoryEpisode,
  readCurrentStoredEpisodeBytes,
  scanLoopMemoryEpisodes,
  type StoredLoopMemoryEpisode,
} from "./episode-store.ts";
import { loopMemoryPruneConflict } from "./memory-errors.ts";

export const LOOP_MEMORY_RETENTION_LIMITS = {
  maxEpisodes: 256,
  maxTotalBytes: 2 * 1024 * 1024,
  maxEpisodeBytes: 8 * 1024,
  maxAgeDays: 90,
  maxEpisodesPerTask: 8,
  maxEpisodesPerFingerprint: 4,
} as const;

export type LoopMemoryRetentionReason =
  | "expired"
  | "over_task_limit"
  | "over_fingerprint_limit"
  | "over_episode_limit"
  | "over_total_bytes";

export type LoopMemoryRetentionCandidate = {
  episode: StoredLoopMemoryEpisode;
  reason: LoopMemoryRetentionReason;
};

export type LoopMemoryRetentionPlan = {
  keep: StoredLoopMemoryEpisode[];
  remove: LoopMemoryRetentionCandidate[];
};

let afterRetentionPreflightForTests: (() => void | Promise<void>) | null = null;

export function __setAfterRetentionPreflightForTests(
  hook: (() => void | Promise<void>) | null,
): void {
  afterRetentionPreflightForTests = hook;
}

function addCandidate(
  candidates: Map<string, LoopMemoryRetentionCandidate>,
  episode: StoredLoopMemoryEpisode,
  reason: LoopMemoryRetentionReason,
  protectedFilename?: string,
): void {
  if (episode.filename === protectedFilename) return;
  if (!candidates.has(episode.filename)) {
    candidates.set(episode.filename, { episode, reason });
  }
}

function newestFilenamesWithProtected(
  group: StoredLoopMemoryEpisode[],
  limit: number,
  protectedFilename?: string,
): Set<string> {
  if (limit <= 0) return new Set();
  if (protectedFilename === undefined || !group.some(e => e.filename === protectedFilename)) {
    return new Set(group.slice(-limit).map(e => e.filename));
  }

  const keep = new Set<string>([protectedFilename]);
  for (const episode of [...group].reverse()) {
    if (keep.size >= limit) break;
    if (episode.filename === protectedFilename) continue;
    keep.add(episode.filename);
  }
  return keep;
}

export function planLoopMemoryRetention(
  episodes: StoredLoopMemoryEpisode[],
  opts: {
    now?: Date;
    protectedFilename?: string;
  } = {},
): LoopMemoryRetentionPlan {
  const now = opts.now ?? new Date();
  const candidates = new Map<string, LoopMemoryRetentionCandidate>();
  const sorted = [...episodes].sort(compareStoredEpisodes);
  const cutoff = now.getTime() - LOOP_MEMORY_RETENTION_LIMITS.maxAgeDays * 86_400_000;

  for (const episode of sorted) {
    if (new Date(episode.episode.recorded_at).getTime() < cutoff) {
      addCandidate(candidates, episode, "expired", opts.protectedFilename);
    }
  }

  const byTask = new Map<string, StoredLoopMemoryEpisode[]>();
  for (const episode of sorted) {
    const key = episode.episode.task.task_id;
    byTask.set(key, [...(byTask.get(key) ?? []), episode]);
  }
  for (const group of byTask.values()) {
    const keepNames = newestFilenamesWithProtected(
      group,
      LOOP_MEMORY_RETENTION_LIMITS.maxEpisodesPerTask,
      opts.protectedFilename,
    );
    for (const episode of group) {
      if (!keepNames.has(episode.filename)) {
        addCandidate(candidates, episode, "over_task_limit", opts.protectedFilename);
      }
    }
  }

  const byFingerprint = new Map<string, StoredLoopMemoryEpisode[]>();
  for (const episode of sorted) {
    const fingerprint = episode.episode.verification.failure_fingerprint;
    if (fingerprint === undefined) continue;
    byFingerprint.set(fingerprint, [...(byFingerprint.get(fingerprint) ?? []), episode]);
  }
  for (const group of byFingerprint.values()) {
    const keepNames = newestFilenamesWithProtected(
      group,
      LOOP_MEMORY_RETENTION_LIMITS.maxEpisodesPerFingerprint,
      opts.protectedFilename,
    );
    for (const episode of group) {
      if (!keepNames.has(episode.filename)) {
        addCandidate(
          candidates,
          episode,
          "over_fingerprint_limit",
          opts.protectedFilename,
        );
      }
    }
  }

  let survivors = sorted.filter(e => !candidates.has(e.filename));
  if (survivors.length > LOOP_MEMORY_RETENTION_LIMITS.maxEpisodes) {
    let survivorCount = survivors.length;
    for (const episode of survivors) {
      if (survivorCount <= LOOP_MEMORY_RETENTION_LIMITS.maxEpisodes) break;
      if (episode.filename === opts.protectedFilename) continue;
      addCandidate(candidates, episode, "over_episode_limit", opts.protectedFilename);
      survivorCount -= 1;
    }
  }

  survivors = sorted.filter(e => !candidates.has(e.filename));
  let totalBytes = survivors.reduce((sum, episode) => sum + episode.bytes, 0);
  for (const episode of survivors) {
    if (totalBytes <= LOOP_MEMORY_RETENTION_LIMITS.maxTotalBytes) break;
    addCandidate(candidates, episode, "over_total_bytes", opts.protectedFilename);
    if (episode.filename !== opts.protectedFilename) {
      totalBytes -= episode.bytes;
    }
  }

  const remove = [...candidates.values()].sort((a, b) =>
    compareStoredEpisodes(a.episode, b.episode),
  );
  const removeNames = new Set(remove.map(candidate => candidate.episode.filename));
  const keep = sorted.filter(episode => !removeNames.has(episode.filename));
  return { keep, remove };
}

export async function applyLoopMemoryRetention(
  cwd: string,
  plan: LoopMemoryRetentionPlan,
): Promise<void> {
  for (const candidate of plan.remove) {
    let current: string | undefined;
    try {
      current = await readCurrentStoredEpisodeBytes(cwd, candidate.episode);
    } catch {
      throw loopMemoryPruneConflict("loop-memory retention candidate changed before prune");
    }
    if (current === undefined || current !== candidate.episode.raw) {
      throw loopMemoryPruneConflict("loop-memory retention candidate changed before prune");
    }
  }
  if (afterRetentionPreflightForTests) await afterRetentionPreflightForTests();

  for (const candidate of plan.remove) {
    await deleteStoredLoopMemoryEpisode(cwd, candidate.episode);
  }
}

export async function pruneLoopMemoryEpisodes(
  cwd: string,
  opts: { write?: boolean; now?: Date } = {},
): Promise<{
  before: { episode_count: number; total_bytes: number };
  remove: LoopMemoryRetentionCandidate[];
  after: { episode_count: number; total_bytes: number };
}> {
  const scan = await scanLoopMemoryEpisodes(cwd);
  const plan = planLoopMemoryRetention(scan.episodes, { now: opts.now });
  if (opts.write === true) {
    await applyLoopMemoryRetention(cwd, plan);
    const afterScan = await scanLoopMemoryEpisodes(cwd);
    return {
      before: {
        episode_count: scan.episodes.length,
        total_bytes: scan.episodes.reduce((sum, episode) => sum + episode.bytes, 0),
      },
      remove: plan.remove,
      after: {
        episode_count: afterScan.episodes.length,
        total_bytes: afterScan.episodes.reduce((sum, episode) => sum + episode.bytes, 0),
      },
    };
  }
  return {
    before: {
      episode_count: scan.episodes.length,
      total_bytes: scan.episodes.reduce((sum, episode) => sum + episode.bytes, 0),
    },
    remove: plan.remove,
    after: {
      episode_count: plan.keep.length,
      total_bytes: plan.keep.reduce((sum, episode) => sum + episode.bytes, 0),
    },
  };
}
