import { pruneLoopMemoryEpisodes } from "../core/loop-memory/retention.ts";

export type MemoryPruneResult = {
  write: boolean;
  before: {
    episode_count: number;
    total_bytes: number;
  };
  would_remove: {
    episode_count: number;
    total_bytes: number;
  };
  after: {
    episode_count: number;
    total_bytes: number;
  };
};

export async function runMemoryPrune(
  cwd: string,
  opts: { write?: boolean } = {},
): Promise<MemoryPruneResult> {
  const write = opts.write === true;
  const result = await pruneLoopMemoryEpisodes(cwd, { write });
  return {
    write,
    before: result.before,
    would_remove: {
      episode_count: result.remove.length,
      total_bytes: result.remove.reduce(
        (sum, candidate) => sum + candidate.episode.bytes,
        0,
      ),
    },
    after: result.after,
  };
}

export function formatMemoryPrune(result: MemoryPruneResult): string {
  return [
    result.write ? "Pruned local loop memory." : "Dry run: local loop memory prune.",
    `Before: ${result.before.episode_count} episode(s), ${result.before.total_bytes} bytes`,
    `Would remove: ${result.would_remove.episode_count} episode(s), ${result.would_remove.total_bytes} bytes`,
    `After: ${result.after.episode_count} episode(s), ${result.after.total_bytes} bytes`,
  ].join("\n");
}
