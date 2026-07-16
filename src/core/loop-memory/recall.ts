import {
  scanLoopMemoryEpisodes,
  type StoredLoopMemoryEpisode,
} from "./episode-store.ts";

export type ExactFailureRecall = {
  exact_match_count: number;
  last_observed_at: string;
} | null;

const FAILURE_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;

export function recallExactFailureFromEpisodes(
  episodes: readonly StoredLoopMemoryEpisode[],
  failureFingerprint: string | undefined,
): ExactFailureRecall {
  if (
    failureFingerprint === undefined ||
    !FAILURE_FINGERPRINT_RE.test(failureFingerprint)
  ) {
    return null;
  }

  let exactMatchCount = 0;
  let lastObservedAt: string | undefined;
  for (const stored of episodes) {
    const episode = stored.episode;
    if (episode.kind !== "verification_failed") continue;
    if (episode.verification.failure_fingerprint !== failureFingerprint) continue;
    exactMatchCount += 1;
    if (lastObservedAt === undefined || episode.recorded_at > lastObservedAt) {
      lastObservedAt = episode.recorded_at;
    }
  }

  if (exactMatchCount === 0 || lastObservedAt === undefined) return null;
  return {
    exact_match_count: exactMatchCount,
    last_observed_at: lastObservedAt,
  };
}

export async function recallExactFailure(
  cwd: string,
  failureFingerprint: string | undefined,
): Promise<ExactFailureRecall> {
  if (
    failureFingerprint === undefined ||
    !FAILURE_FINGERPRINT_RE.test(failureFingerprint)
  ) {
    return null;
  }
  const scan = await scanLoopMemoryEpisodes(cwd);
  return recallExactFailureFromEpisodes(scan.episodes, failureFingerprint);
}
