import { scanLoopMemoryEpisodes, type StoredLoopMemoryEpisode } from "./episode-store.ts";
import { planLoopMemoryRetention } from "./retention.ts";

export type LoopMemoryStatus = {
  schema_version: 1;
  episode_count: number;
  total_bytes: number;
  oldest_recorded_at?: string;
  newest_recorded_at?: string;
  failure_count: number;
  success_count: number;
  unique_task_count: number;
  unique_fingerprint_count: number;
  expired_count: number;
  over_task_limit_count: number;
  over_fingerprint_limit_count: number;
  corrupt_count: number;
  corrupt_bytes: number;
  corrupt_unmeasured_count: number;
};

function minMaxRecordedAt(episodes: StoredLoopMemoryEpisode[]): {
  oldest_recorded_at?: string;
  newest_recorded_at?: string;
} {
  if (episodes.length === 0) return {};
  return {
    oldest_recorded_at: episodes[0]!.episode.recorded_at,
    newest_recorded_at: episodes[episodes.length - 1]!.episode.recorded_at,
  };
}

export async function loopMemoryStatus(
  cwd: string,
  opts: { now?: Date } = {},
): Promise<LoopMemoryStatus> {
  const scan = await scanLoopMemoryEpisodes(cwd);
  const plan = planLoopMemoryRetention(scan.episodes, { now: opts.now });
  const taskIds = new Set(scan.episodes.map(e => e.episode.task.task_id));
  const fingerprints = new Set(
    scan.episodes
      .map(e => e.episode.verification.failure_fingerprint)
      .filter((v): v is string => v !== undefined),
  );
  const removeByReason = new Map<string, number>();
  for (const candidate of plan.remove) {
    removeByReason.set(
      candidate.reason,
      (removeByReason.get(candidate.reason) ?? 0) + 1,
    );
  }

  return {
    schema_version: 1,
    episode_count: scan.episodes.length,
    total_bytes: scan.episodes.reduce((sum, episode) => sum + episode.bytes, 0),
    ...minMaxRecordedAt(scan.episodes),
    failure_count: scan.episodes.filter(e => !e.episode.verification.ok).length,
    success_count: scan.episodes.filter(e => e.episode.verification.ok).length,
    unique_task_count: taskIds.size,
    unique_fingerprint_count: fingerprints.size,
    expired_count: removeByReason.get("expired") ?? 0,
    over_task_limit_count: removeByReason.get("over_task_limit") ?? 0,
    over_fingerprint_limit_count: removeByReason.get("over_fingerprint_limit") ?? 0,
    corrupt_count: scan.corrupt.length,
    corrupt_bytes: scan.corrupt.reduce((sum, episode) => sum + (episode.bytes ?? 0), 0),
    corrupt_unmeasured_count: scan.corrupt.filter(episode => episode.bytes === undefined).length,
  };
}
