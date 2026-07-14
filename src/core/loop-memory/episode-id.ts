import { createHash } from "node:crypto";
import { canonicalJson } from "../content-addressed-store/canonical-json.ts";
import type { LoopMemoryEpisode } from "./episode-schema.ts";

export const LOOP_MEMORY_FILENAME_PATTERN =
  /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{16}\.json$/;

export function canonicalLoopMemoryEpisode(episode: LoopMemoryEpisode): string {
  return canonicalJson(episode);
}

export function loopMemoryEpisodeDigest(episode: LoopMemoryEpisode): string {
  return createHash("sha256")
    .update(canonicalLoopMemoryEpisode(episode))
    .digest("hex");
}

export function utcBasicTimestamp(date: Date): string {
  const iso = date.toISOString();
  return iso
    .replace(/-/g, "")
    .replace(/:/g, "")
    .replace(".", "")
    .replace("Z", "Z");
}

export function loopMemoryEpisodeFilename(episode: LoopMemoryEpisode): string {
  return `${utcBasicTimestamp(new Date(episode.recorded_at))}-${loopMemoryEpisodeDigest(episode).slice(0, 16)}.json`;
}

export function isLoopMemoryEpisodeFilename(filename: string): boolean {
  return LOOP_MEMORY_FILENAME_PATTERN.test(filename);
}
