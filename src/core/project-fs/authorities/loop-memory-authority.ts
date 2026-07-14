import {
  resolveAndBrandDeleteForAuthority,
  resolveAndBrandListForAuthority,
  resolveAndBrandReadForAuthority,
  resolveAndBrandWriteForAuthority,
} from "../authority-resolvers.ts";
import type {
  OwnedDeletePath,
  OwnedListPath,
  OwnedReadPath,
  OwnedWritePath,
} from "../branded-paths.ts";
import { isLoopMemoryEpisodeFilename } from "../../loop-memory/episode-id.ts";

export const LOOP_MEMORY_EPISODES_REL_DIR =
  ".code-pact/cache/loop-memory/v1/episodes";

function episodeRelPath(filename: string): string {
  if (!isLoopMemoryEpisodeFilename(filename)) {
    const error = new Error("path is not in an owned namespace");
    (error as NodeJS.ErrnoException).code = "PATH_NOT_OWNED";
    throw error;
  }
  return `${LOOP_MEMORY_EPISODES_REL_DIR}/${filename}`;
}

export async function resolveLoopMemoryEpisodesDirectoryReadPath(
  cwd: string,
): Promise<OwnedListPath> {
  return resolveAndBrandListForAuthority(
    cwd,
    LOOP_MEMORY_EPISODES_REL_DIR,
    path => path === LOOP_MEMORY_EPISODES_REL_DIR,
  );
}

export async function resolveLoopMemoryEpisodeReadPath(
  cwd: string,
  filename: string,
): Promise<OwnedReadPath> {
  const relPath = episodeRelPath(filename);
  return resolveAndBrandReadForAuthority(cwd, relPath, path => path === relPath);
}

export async function resolveLoopMemoryEpisodeWritePath(
  cwd: string,
  filename: string,
): Promise<OwnedWritePath> {
  const relPath = episodeRelPath(filename);
  return resolveAndBrandWriteForAuthority(cwd, relPath, path => path === relPath);
}

export async function resolveLoopMemoryEpisodeDeletePath(
  cwd: string,
  filename: string,
): Promise<OwnedDeletePath> {
  const relPath = episodeRelPath(filename);
  return resolveAndBrandDeleteForAuthority(cwd, relPath, path => path === relPath);
}
