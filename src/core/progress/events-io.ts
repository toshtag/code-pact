import { randomUUID } from "node:crypto";
import {
  linkOwned,
  mkdirOwned,
  listOwned,
  readOwnedText,
  removeOwned,
  writeOwnedTextExclusive,
} from "../project-fs/operations.ts";
import {
  resolveProgressEventDeletePath,
  resolveProgressEventReadPath,
  resolveProgressEventsDirListPath,
  resolveProgressEventsDirWritePath,
  resolveProgressEventWritePath,
  unbrand,
} from "../project-fs/authorities/project-config-authority.ts";
import { join } from "node:path";
import type { OwnedReadPath } from "../project-fs/branded-paths.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ProgressEvent } from "../schemas/progress-event.ts";
import {
  atCompact,
  computeEventId,
  eventFileName,
  normalizeAt,
} from "./event-id.ts";

/**
 * Per-event progress ledger.
 *
 * Each progress event is its own file under `.code-pact/state/events/`,
 * published atomically (write a temp file, then `link` it onto the final path —
 * see {@link writeEventFile}). There is no load / array-spread / whole-file
 * rewrite, so two concurrent writers produce two different files and neither is
 * lost, and two branches that each add events merge cleanly (distinct
 * filenames). The filename — `<at-compact>-<id>.yaml` — embeds the full content
 * id as its suffix, so a pre-existing final means the canonically identical event
 * is already on disk — idempotent success, not a clash.
 */

export const EVENTS_DIR_SEGMENTS = [".code-pact", "state", "events"];

export function eventsDir(cwd: string): string {
  return join(cwd, ...EVENTS_DIR_SEGMENTS);
}

async function resolveEventsDirForWrite(cwd: string) {
  try {
    return await resolveProgressEventsDirWritePath(cwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "PATH_OUTSIDE_PROJECT" ||
      code === "PATH_NOT_OWNED" ||
      code === "FS_AUTHORITY_FAILURE"
    ) {
      const e = new Error(
        `.code-pact/state/events is not a safe owned progress ledger path: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}

export async function resolveEventsDir(cwd: string) {
  try {
    return await resolveProgressEventsDirListPath(cwd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "PATH_OUTSIDE_PROJECT" ||
      code === "PATH_NOT_OWNED" ||
      code === "FS_AUTHORITY_FAILURE"
    ) {
      const e = new Error(
        `.code-pact/state/events is not a safe owned progress ledger path: ${(err as Error).message}`,
      );
      (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
      throw e;
    }
    throw err;
  }
}

function mapEventPathError(file: string, err: unknown): never {
  const code = (err as NodeJS.ErrnoException).code;
  if (
    code === "PATH_OUTSIDE_PROJECT" ||
    code === "PATH_NOT_OWNED" ||
    code === "FS_AUTHORITY_FAILURE"
  ) {
    const e = new Error(
      `.code-pact/state/events/${file} is not a safe owned progress ledger path: ${(err as Error).message}`,
    );
    (e as NodeJS.ErrnoException).code = "CONFIG_ERROR";
    throw e;
  }
  throw err;
}

async function resolveEventReadPath(cwd: string, file: string) {
  try {
    return await resolveProgressEventReadPath(cwd, file);
  } catch (err) {
    mapEventPathError(file, err);
  }
}

export type LoadedEventFile = {
  event: ProgressEvent;
  /** Content-derived id (recomputed; equals the filename id by construction). */
  id: string;
  /** Source filename, for diagnostics. */
  file: string;
};

/** Strict event-file name: `<at-compact>-<64-hex sha256>.yaml`. */
const EVENT_FILE_RE = /^(\d{8}T\d{9}Z)-([0-9a-f]{64})\.yaml$/;

/** Parse an event-file basename into its parts, or `null` if it is not one. */
export function parseEventFileName(
  file: string,
): { atCompact: string; id: string } | null {
  const m = EVENT_FILE_RE.exec(file);
  return m ? { atCompact: m[1]!, id: m[2]! } : null;
}

/**
 * Tag an event-file error with the diagnostic `code` that every consumer
 * (doctor, plan lint, branch-drift) maps straight through, so the same broken
 * file reports the same code on every surface:
 *  - `INVALID_YAML` — the body is not parseable YAML
 *  - `SCHEMA_ERROR` — it parses but is not a valid `ProgressEvent`
 *
 * The third code, `EVENT_FILE_ID_MISMATCH` (broken filename↔content bijection),
 * is emitted by {@link eventFileMismatch} with a literal assignment.
 */
function taggedEventError(
  code: "INVALID_YAML" | "SCHEMA_ERROR",
  message: string,
  file: string,
): NodeJS.ErrnoException {
  const err = new Error(
    `Event file ${file}: ${message}`,
  ) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function eventFileMismatch(
  message: string,
  file: string,
): NodeJS.ErrnoException {
  // Literal `.code =` assignment (not via taggedEventError's variable) so the
  // error-code-surface scan sees EVENT_FILE_ID_MISMATCH as an emitted code.
  const err = new Error(
    `Event file ${file}: ${message}`,
  ) as NodeJS.ErrnoException;
  err.code = "EVENT_FILE_ID_MISMATCH";
  return err;
}

/**
 * Read + parse + FULLY VALIDATE one event file against the filename↔content
 * bijection. This is the single source of validation truth, shared by
 * {@link readEventFiles} and {@link writeEventFile}'s `EEXIST` path so the
 * reader and writer can never diverge ("write succeeded, ledger broken"):
 *  - filename matches `<at-compact>-<full-id>.yaml`
 *  - body parses to a `ProgressEvent`
 *  - recomputed content id === filename id
 *  - `atCompact(event.at)` === filename at-compact prefix
 *  - stored `id`, if present, is the exact same string (a present-but-non-string
 *    or mismatched stored id is rejected; a missing stored id is allowed since
 *    the filename already carries the full id)
 */
/**
 * Validate an event file's raw CONTENT against its filename↔content bijection.
 * Content-based (no disk) so it is shared by every source — the workspace
 * reader and the git-tree reader (branch-drift) — guaranteeing identical
 * validation everywhere. Throws `EVENT_FILE_ID_MISMATCH` on any divergence.
 */
export function validateEventFileContent(
  file: string,
  raw: string,
): LoadedEventFile {
  const name = parseEventFileName(file);
  if (!name) throw eventFileMismatch("not a valid event-file name", file);
  let doc: Record<string, unknown> | null;
  try {
    doc = parseYaml(raw) as Record<string, unknown> | null;
  } catch (err) {
    // Unparseable YAML body — INVALID_YAML, matching the legacy file's surface.
    throw taggedEventError("INVALID_YAML", (err as Error).message, file);
  }
  // The stored `id` is not part of the event schema; strip before parsing.
  const { id: storedId, ...rest } = doc ?? {};
  const parsed = ProgressEvent.safeParse(rest);
  // Parses but is not a valid ProgressEvent — SCHEMA_ERROR, not EVENT_FILE_ID_MISMATCH.
  if (!parsed.success)
    throw taggedEventError("SCHEMA_ERROR", parsed.error.message, file);
  const event = parsed.data;
  const id = computeEventId(event);
  if (id !== name.id) {
    throw eventFileMismatch(
      `content id (${id}) does not match filename id (${name.id})`,
      file,
    );
  }
  if (atCompact(event.at) !== name.atCompact) {
    throw eventFileMismatch(
      `event at-compact (${atCompact(event.at)}) does not match filename prefix (${name.atCompact})`,
      file,
    );
  }
  if (storedId !== undefined && storedId !== id) {
    throw eventFileMismatch(
      `stored id (${JSON.stringify(storedId)}) does not match content id (${id})`,
      file,
    );
  }
  return { event, id, file };
}

async function readValidatedEventFile(
  path: OwnedReadPath,
  file: string,
): Promise<LoadedEventFile> {
  return validateEventFileContent(
    file,
    await readOwnedText(path),
  );
}

export type WrittenEvent = {
  id: string;
  path: string;
  /** True when the identical event was already on disk (idempotent no-op). */
  alreadyExisted: boolean;
};

/**
 * Write one event as `.code-pact/state/events/<at-compact>-<id>.yaml`. The
 * stored body is the validated event with `at` normalized to UTC plus its `id`.
 *
 * Crash-/race-safe publish: the body is written to a temp file in the same
 * directory (its name does NOT match `EVENT_FILE_RE`, so a concurrent
 * {@link readEventFiles} ignores an in-progress write), then published to the
 * final path with `link` — an atomic, **no-overwrite** create. A reader never
 * observes a half-written final file, and a pre-existing final is never silently
 * overwritten, so corruption fails closed instead of being hidden (this is why
 * `link`, not `rename`).
 *
 * Idempotent: if the final path already exists, it is re-validated with the SAME
 * invariant the reader uses — the identical event returns `alreadyExisted: true`;
 * anything else throws `EVENT_FILE_ID_MISMATCH`.
 */
export async function writeEventFile(
  cwd: string,
  event: ProgressEvent,
): Promise<WrittenEvent> {
  const parsed = ProgressEvent.parse(event); // fail closed on an invalid event
  const id = computeEventId(parsed);
  const file = eventFileName(parsed);
  const pathRead: OwnedReadPath = await resolveEventReadPath(cwd, file);
  await mkdirOwned(await resolveEventsDirForWrite(cwd), { recursive: true });
  const body = stringifyYaml({ ...parsed, at: normalizeAt(parsed.at), id });

  // Temp name is dot-prefixed (never matches EVENT_FILE_RE) and carries a random
  // uuid so it can't collide with a stale temp / reused pid; `wx` refuses to
  // reuse an existing temp rather than clobber it.
  const tmpFile = `.tmp-${process.pid}-${randomUUID()}-${file}`;
  // Outer try guarantees the temp is removed even if the temp write itself
  // fails partway; the inner try/catch handles ONLY `link`'s EEXIST (a temp
  // collision is impossible via the uuid, so its errors must propagate, not be
  // mistaken for "the final already exists").
  try {
    await writeOwnedTextExclusive(
      await resolveProgressEventWritePath(cwd, tmpFile),
      body,
    );
    try {
      const pathWrite = await resolveProgressEventWritePath(cwd, file);
      await linkOwned(
        await resolveProgressEventReadPath(cwd, tmpFile),
        pathWrite,
      ); // atomic, no-overwrite publish
      return { id, path: unbrand(pathWrite), alreadyExisted: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Final already exists. A valid event here necessarily hashes to our id
      // (the filename), so it IS the same event; corruption / wrong stored id /
      // mismatched prefix throws EVENT_FILE_ID_MISMATCH.
      await readValidatedEventFile(pathRead, file);
      return {
        id,
        path: unbrand(await resolveProgressEventWritePath(cwd, file)),
        alreadyExisted: true,
      };
    }
  } finally {
    await removeOwned(await resolveProgressEventDeletePath(cwd, tmpFile), {
      force: true,
    });
  }
}

/**
 * Read and FULLY VALIDATE every event file under `.code-pact/state/events/`.
 * Returns `[]` when the directory does not exist. Files whose names don't match
 * the event-file pattern are ignored (foreign/stray, not events); every file
 * that does match is validated by {@link readValidatedEventFile} (filename id,
 * content id, at-compact prefix, and stored id must all agree, else
 * `EVENT_FILE_ID_MISMATCH`). Throws on an unreadable / schema-invalid event
 * file (callers map to the usual INVALID_YAML / SCHEMA_ERROR surfaces).
 */
export async function readEventFiles(cwd: string): Promise<LoadedEventFile[]> {
  let names: string[];
  try {
    names = await listOwned(await resolveEventsDir(cwd));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: LoadedEventFile[] = [];
  for (const file of names.sort()) {
    if (!parseEventFileName(file)) continue; // not an event file — ignore
    out.push(
      await readValidatedEventFile(await resolveEventReadPath(cwd, file), file),
    );
  }
  return out;
}
