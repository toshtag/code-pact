import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { atomicWriteText } from "../../io/atomic-text.ts";
import {
  ProgressLog,
  type ProgressEvent,
} from "../schemas/progress-event.ts";

export const PROGRESS_PATH_SEGMENTS = [".code-pact", "state", "progress.yaml"];

export function progressPath(cwd: string): string {
  return join(cwd, ...PROGRESS_PATH_SEGMENTS);
}

export type LoadedProgress = {
  raw: string;
  log: ProgressLog;
  path: string;
};

/**
 * Read and Zod-parse the progress log. Throws if the file is missing or
 * does not satisfy the schema; callers should map errors to the
 * appropriate CLI error code.
 */
export async function loadProgressLog(cwd: string): Promise<LoadedProgress> {
  const path = progressPath(cwd);
  const raw = await readFile(path, "utf8");
  const log = ProgressLog.parse(parseYaml(raw) as unknown);
  return { raw, log, path };
}

/**
 * Atomic YAML write — serializes `value` then delegates to `atomicWriteText`.
 * Kept as a thin wrapper so progress-log writers do not need to know about
 * the serialization step separately.
 */
export async function atomicWriteYaml(
  path: string,
  value: unknown,
): Promise<void> {
  await atomicWriteText(path, stringifyYaml(value));
}

/**
 * Append a single ProgressEvent to progress.yaml under .code-pact/state/.
 * Loads, appends, and atomically writes back. Returns the loaded log so
 * callers can reuse it without re-reading.
 */
export async function appendEvent(
  cwd: string,
  event: ProgressEvent,
): Promise<{ path: string; nextLog: ProgressLog }> {
  const { log, path } = await loadProgressLog(cwd);
  const nextLog: ProgressLog = { events: [...log.events, event] };
  await atomicWriteYaml(path, nextLog);
  return { path, nextLog };
}
