import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter } from "../pack/front-matter.ts";

/**
 * True when `error` means `design/decisions/` simply is not there
 * (`ENOENT`) or is not a directory (`ENOTDIR`) — the normal "no ADR" state.
 * Exported so the rethrow policy can be tested without mocking `readdir`.
 */
export function isAbsentDecisionsDirError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

/**
 * Reads the filenames in `design/decisions/`.
 *
 * Returns `[]` when the directory is absent — a roadmap that has not
 * recorded any decisions is a normal "no ADR" state. Any other error
 * (permissions, a broken path) is rethrown: silently swallowing it would
 * convert a real environment problem into a spurious
 * `TASK_DECISION_UNRESOLVED` advisory.
 */
export async function readDecisionAdrFiles(cwd: string): Promise<string[]> {
  return (await readDecisionsDir(cwd)).entries;
}

/** Like {@link readDecisionAdrFiles} but also reports whether the dir exists. */
async function readDecisionsDir(
  cwd: string,
): Promise<{ present: boolean; entries: string[] }> {
  try {
    return { present: true, entries: await readdir(join(cwd, "design", "decisions")) };
  } catch (error) {
    if (isAbsentDecisionsDirError(error)) return { present: false, entries: [] };
    throw error;
  }
}

/**
 * The single substring rule that decides whether an ADR filename resolves a
 * task id. Deliberately preserved compatibility: `"P1-T1"` also matches
 * `"P1-T10-decision.md"`. Changing it changes both consumers (the gate and
 * the `plan lint` advisory) at once.
 */
function matchesTaskId(filename: string, taskId: string): boolean {
  return filename.endsWith(".md") && filename.includes(taskId);
}

/**
 * True when `entries` contains an ADR whose filename resolves `taskId`.
 *
 * Filename-only predicate, shared by `verify` and `plan lint` since v0.x.
 * Status-aware resolution ({@link resolveDecisionGate}) layers on top of this
 * same substring rule; this export is kept for the characterization tests
 * that pin the substring-collision compat.
 */
export function hasDecisionAdrForTaskId(
  entries: string[],
  taskId: string,
): boolean {
  return entries.some((f) => matchesTaskId(f, taskId));
}

// ---------------------------------------------------------------------------
// Status-aware resolution (RFC §3-C)
// ---------------------------------------------------------------------------

/** Status words that explicitly do NOT resolve the gate. */
const BLOCKING_STATUSES = new Set(["proposed", "draft", "rejected", "superseded"]);

/** Acceptance verdict for one ADR file's content. */
export type AdrAcceptance = "accepted" | "blocked" | "empty" | "unknown_status";

/** Adds the I/O-absent case for a declared `decision_refs` path. */
export type ConsideredAcceptance = AdrAcceptance | "missing";

export type AdrStatus = {
  /** First token after the status label, lowercased; null when none found. */
  word: string | null;
  source: "frontmatter" | "bold-line" | "none";
};

function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Extract an ADR's declared status. Frontmatter `status:` wins over the
 * markdown `**Status:** <word>` bold line when both are present (frontmatter
 * is the more explicit, machine-intended channel). Returns the first token
 * (e.g. "accepted" from `accepted (P16, 2026-05)`), lowercased.
 */
export function parseAdrStatus(content: string): AdrStatus {
  const text = normalizeNewlines(content);

  const { frontMatter } = parseFrontMatter(text);
  const fmStatus = frontMatter.status;
  if (typeof fmStatus === "string" && fmStatus.trim().length > 0) {
    return { word: firstToken(fmStatus), source: "frontmatter" };
  }

  // `**Status:** accepted (P16, 2026-05)` — capture the first non-space run,
  // then strip a glued trailing paren/comma.
  const m = text.match(/^\s*\*\*Status:\*\*\s*(\S+)/im);
  if (m) {
    return { word: firstToken(m[1]!), source: "bold-line" };
  }

  return { word: null, source: "none" };
}

function firstToken(raw: string): string {
  return raw
    .trim()
    .split(/[\s(),]/)[0]!
    .toLowerCase();
}

/**
 * Classify one ADR's content. Resolve order (RFC §3-C):
 *   empty file              → "empty"        (never resolves; "空 ADR は不通過")
 *   no status line          → "accepted"     (lenient backward-compat — the ONLY lenient case)
 *   status == accepted      → "accepted"
 *   status ∈ blocking set   → "blocked"
 *   explicit unknown status → "unknown_status" (does NOT resolve — closes the typo hole)
 */
export function classifyAdr(content: string): {
  acceptance: AdrAcceptance;
  status: AdrStatus;
} {
  if (normalizeNewlines(content).trim().length === 0) {
    return { acceptance: "empty", status: { word: null, source: "none" } };
  }
  const status = parseAdrStatus(content);
  if (status.word === null) return { acceptance: "accepted", status };
  if (status.word === "accepted") return { acceptance: "accepted", status };
  if (BLOCKING_STATUSES.has(status.word)) return { acceptance: "blocked", status };
  return { acceptance: "unknown_status", status };
}

export type ConsideredAdr = {
  /** Repo-root-relative POSIX path. */
  path: string;
  /** Parsed status word, or null when none. */
  status: string | null;
  accepted: boolean;
  acceptance: ConsideredAcceptance;
};

export type DecisionResolution = {
  /** True iff the gate resolves (semantics differ by `via`). */
  resolved: boolean;
  considered: ConsideredAdr[];
  /** Which source drove resolution. */
  via: "decision_refs" | "filename-scan";
  /** Whether `design/decisions/` exists (for the dir-missing message). */
  dirPresent: boolean;
  /** Human reason naming which ADR and why (used when not resolved). */
  reason: string;
};

/** Reads a repo-relative file; returns null when it does not exist. */
type RelFileReader = (relPath: string) => Promise<string | null>;

function diskReader(cwd: string): RelFileReader {
  return async (relPath) => {
    try {
      return await readFile(join(cwd, relPath), "utf8");
    } catch (error) {
      if (isAbsentDecisionsDirError(error)) return null;
      throw error;
    }
  };
}

function whyNotAccepted(c: ConsideredAdr): string {
  switch (c.acceptance) {
    case "blocked":
      return `${c.path} is "${c.status}" (needs "accepted")`;
    case "empty":
      return `${c.path} is empty`;
    case "unknown_status":
      return `${c.path} has unrecognized status "${c.status}"`;
    case "missing":
      return `${c.path} (file not found)`;
    default:
      return c.path;
  }
}

async function resolveWith(
  taskId: string,
  decisionRefs: string[] | undefined,
  dir: { present: boolean; entries: string[] },
  read: RelFileReader,
): Promise<DecisionResolution> {
  if (decisionRefs && decisionRefs.length > 0) {
    // Explicit references are a strong contract: ALL must be accepted.
    const considered: ConsideredAdr[] = [];
    for (const ref of decisionRefs) {
      const path = toPosix(ref);
      const content = await read(ref);
      if (content === null) {
        considered.push({ path, status: null, accepted: false, acceptance: "missing" });
        continue;
      }
      const { acceptance, status } = classifyAdr(content);
      considered.push({
        path,
        status: status.word,
        accepted: acceptance === "accepted",
        acceptance,
      });
    }
    const resolved = considered.length > 0 && considered.every((c) => c.accepted);
    const failing = considered.filter((c) => !c.accepted).map(whyNotAccepted);
    return {
      resolved,
      considered,
      via: "decision_refs",
      dirPresent: dir.present,
      reason: resolved
        ? `all decision_refs for "${taskId}" are accepted`
        : `decision_refs for "${taskId}" not all accepted: ${failing.join("; ")}`,
    };
  }

  // Filename scan: any accepted match resolves (preserves substring-collision compat).
  const considered: ConsideredAdr[] = [];
  for (const f of dir.entries.filter((e) => matchesTaskId(e, taskId))) {
    const rel = `design/decisions/${f}`;
    const content = (await read(rel)) ?? "";
    const { acceptance, status } = classifyAdr(content);
    considered.push({
      path: rel,
      status: status.word,
      accepted: acceptance === "accepted",
      acceptance,
    });
  }
  const resolved = considered.some((c) => c.accepted);
  let reason: string;
  if (resolved) {
    reason = `${considered.find((c) => c.accepted)!.path} is "accepted"`;
  } else if (considered.length === 0) {
    reason = dir.present
      ? `No ADR found for task "${taskId}" in design/decisions/`
      : `design/decisions/ does not exist but requires_decision is true`;
  } else {
    reason = considered.map(whyNotAccepted).join("; ");
  }
  return { resolved, considered, via: "filename-scan", dirPresent: dir.present, reason };
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

/**
 * Resolve the decision gate for a single task. When `decisionRefs` is
 * non-empty, every referenced ADR must be accepted; otherwise the gate
 * resolves if any filename-matching ADR in `design/decisions/` is accepted.
 * Shared by `verify`'s `checkDecision` and `task record-done` so they cannot
 * diverge.
 */
export async function resolveDecisionGate(
  cwd: string,
  taskId: string,
  decisionRefs?: string[],
): Promise<DecisionResolution> {
  const dir = await readDecisionsDir(cwd);
  return resolveWith(taskId, decisionRefs, dir, diskReader(cwd));
}

/**
 * Batch variant for `plan lint`: reads `design/decisions/` once and memoizes
 * file reads across the N tasks in a lint run, so the gate logic is shared
 * with `verify`/`record-done` (identical `classifyAdr` + `matchesTaskId`)
 * without re-reading the directory per task.
 */
export async function makeDecisionResolver(
  cwd: string,
): Promise<{ resolve(taskId: string, decisionRefs?: string[]): Promise<DecisionResolution> }> {
  const dir = await readDecisionsDir(cwd);
  const cache = new Map<string, string | null>();
  const base = diskReader(cwd);
  const cachedRead: RelFileReader = async (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath)!;
    const content = await base(relPath);
    cache.set(relPath, content);
    return content;
  };
  return {
    resolve: (taskId, decisionRefs) =>
      resolveWith(taskId, decisionRefs, dir, cachedRead),
  };
}
