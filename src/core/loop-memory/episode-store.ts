import { atomicCreateTextExclusive } from "../../io/atomic-text.ts";
import {
  listOwnedDirents,
  readOwnedText,
  unlinkOwned,
} from "../project-fs/index.ts";
import {
  resolveLoopMemoryEpisodeDeletePath,
  resolveLoopMemoryEpisodeReadPath,
  resolveLoopMemoryEpisodeWritePath,
  resolveLoopMemoryEpisodesDirectoryReadPath,
} from "../project-fs/index.ts";
import {
  canonicalLoopMemoryEpisode,
  isLoopMemoryEpisodeFilename,
  loopMemoryEpisodeFilename,
} from "./episode-id.ts";
import {
  parseLoopMemoryEpisode,
  safeParseLoopMemoryEpisode,
  type LoopMemoryEpisode,
} from "./episode-schema.ts";
import { loopMemoryConflict, loopMemoryInvalid } from "./memory-errors.ts";

export type StoredLoopMemoryEpisode = {
  filename: string;
  bytes: number;
  raw: string;
  episode: LoopMemoryEpisode;
};

export type CorruptLoopMemoryEpisode = {
  filename: string;
  reason: "invalid_filename" | "read_failed" | "invalid_json" | "schema_invalid";
  system_code?: string;
};

export type LoopMemoryScan = {
  episodes: StoredLoopMemoryEpisode[];
  corrupt: CorruptLoopMemoryEpisode[];
};

export async function storeLoopMemoryEpisode(
  cwd: string,
  episode: LoopMemoryEpisode,
): Promise<StoredLoopMemoryEpisode> {
  const parsed = parseLoopMemoryEpisode(episode);
  const raw = canonicalLoopMemoryEpisode(parsed);
  const filename = loopMemoryEpisodeFilename(parsed);

  try {
    const writePath = await resolveLoopMemoryEpisodeWritePath(cwd, filename);
    await atomicCreateTextExclusive(writePath, raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const readPath = await resolveLoopMemoryEpisodeReadPath(cwd, filename);
    const existing = await readOwnedText(readPath);
    if (existing !== raw) {
      throw loopMemoryConflict("loop-memory episode filename collision");
    }
  }

  return { filename, bytes: Buffer.byteLength(raw, "utf8"), raw, episode: parsed };
}

export async function scanLoopMemoryEpisodes(cwd: string): Promise<LoopMemoryScan> {
  let dirents: import("node:fs").Dirent[];
  try {
    const listPath = await resolveLoopMemoryEpisodesDirectoryReadPath(cwd);
    dirents = await listOwnedDirents(listPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { episodes: [], corrupt: [] };
    }
    throw error;
  }

  const episodes: StoredLoopMemoryEpisode[] = [];
  const corrupt: CorruptLoopMemoryEpisode[] = [];

  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const filename = dirent.name;
    if (!isLoopMemoryEpisodeFilename(filename)) {
      corrupt.push({ filename, reason: "invalid_filename" });
      continue;
    }

    let raw: string;
    try {
      const readPath = await resolveLoopMemoryEpisodeReadPath(cwd, filename);
      raw = await readOwnedText(readPath);
    } catch (error) {
      corrupt.push({
        filename,
        reason: "read_failed",
        system_code: (error as NodeJS.ErrnoException).code,
      });
      continue;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      corrupt.push({ filename, reason: "invalid_json" });
      continue;
    }

    const parsed = safeParseLoopMemoryEpisode(decoded);
    if (!parsed.success) {
      corrupt.push({ filename, reason: "schema_invalid" });
      continue;
    }

    const canonical = canonicalLoopMemoryEpisode(parsed.data);
    if (canonical !== raw) {
      corrupt.push({ filename, reason: "schema_invalid" });
      continue;
    }

    episodes.push({
      filename,
      bytes: Buffer.byteLength(raw, "utf8"),
      raw,
      episode: parsed.data,
    });
  }

  episodes.sort(compareStoredEpisodes);
  corrupt.sort((a, b) => a.filename.localeCompare(b.filename));
  return { episodes, corrupt };
}

export function compareStoredEpisodes(
  a: StoredLoopMemoryEpisode,
  b: StoredLoopMemoryEpisode,
): number {
  const recorded = a.episode.recorded_at.localeCompare(b.episode.recorded_at);
  if (recorded !== 0) return recorded;
  return a.filename.localeCompare(b.filename);
}

export async function deleteStoredLoopMemoryEpisode(
  cwd: string,
  episode: StoredLoopMemoryEpisode,
): Promise<void> {
  const readPath = await resolveLoopMemoryEpisodeReadPath(cwd, episode.filename);
  const current = await readOwnedText(readPath);
  if (current !== episode.raw) {
    throw loopMemoryInvalid("loop-memory episode changed before prune");
  }
  const deletePath = await resolveLoopMemoryEpisodeDeletePath(cwd, episode.filename);
  await unlinkOwned(deletePath);
}
