import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
 * Best-effort atomic replacement: write a temp file in the same directory,
 * then rename to the destination. Prevents partial-write corruption of
 * progress.yaml. Does NOT protect against concurrent writers — that is a
 * known v0.2 limitation noted in docs/cli-contract.md.
 */
export async function atomicWriteYaml(
  path: string,
  value: unknown,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, stringifyYaml(value), "utf8");
  await rename(tmp, path);
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
