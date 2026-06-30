import { readFile, readdir, stat } from "../project-fs/index.ts";
import { parseFrontMatter } from "../pack/front-matter.ts";
import { resolveSymlinkFreeProjectPath } from "../path-safety.ts";
import { isDecisionRefPath, normalizeDecisionRefPath } from "../schemas/decision-ref.ts";
import { resolveRetiredDecisionGate } from "./decision-gate-archive.ts";

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
  return (await listLiveDecisionFiles(cwd)).paths;
}

/**
 * Files under `design/decisions/` that are NOT decisions and must be skipped by
 * every candidate scan (gate filename resolution + ADR quality checks): the
 * index, and the `decision prune` tombstone ledger. Without this, the lenient
 * "no status line → accepted" rule would misclassify the ledger as an accepted
 * ADR. See design/decisions/decision-lifecycle-rfc.md.
 */
export const NON_DECISION_FILES = new Set(["README.md", "PRUNED.md"]);

type LiveDecisionListing = {
  present: boolean;
  paths: string[];
};

function codedDecisionScanError(message: string, cause?: unknown): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = "DECISION_SCAN_UNREADABLE";
  if (cause !== undefined) {
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

/**
 * The shared LIVE `design/decisions/` directory-listing seam: returns whether
 * the dir is present and its decision filenames (with `NON_DECISION_FILES` —
 * the index + `PRUNED.md` ledger — filtered out). Like
 * {@link readDecisionAdrFiles} but also reports `present`. The gate
 * ({@link resolveDecisionGate} / {@link makeDecisionResolver}) and the lint
 * classify scans share this; the pack loader routes its listing onto it too
 * (step 2b), so the live directory read stops being duplicated.
 *
 * SCOPE — live `design/decisions/` ONLY; it must NOT consult `.code-pact/state`.
 * The design-docs-ephemeral retired-decision fallback (step 5) belongs in
 * gate-aware / lint-aware WRAPPERS that compose this seam, NEVER inside it —
 * otherwise the pack render and the ADR-quality scans (`loadDecisions` /
 * `loadDeclaredDecisions` / `classifyDecisionAdrs`) would start treating a
 * retired state record as a live decision body / quality target.
 *
 * Error contract (fail-closed): ENOENT/ENOTDIR → `{ present:false, entries:[] }`
 * (a roadmap with no decisions is a normal "no ADR" state); ANY OTHER error
 * THROWS — an unreadable decisions dir must never silently pass a gate. Optional
 * context-source callers (the pack loaders) wrap this in their own `catch → []`
 * to keep their degrade-on-any-error contract; that leniency stays at the call
 * site, not pushed down here.
 */
export async function listLiveDecisionFiles(
  cwd: string,
): Promise<LiveDecisionListing> {
  const out: string[] = [];

  async function walk(relDir: string): Promise<void> {
    let dirents: import("node:fs").Dirent[];
    let absDir: string;
    try {
      absDir = await resolveSymlinkFreeProjectPath(cwd, relDir);
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      if (relDir === "design/decisions" && isAbsentDecisionsDirError(error)) {
        throw error;
      }
      throw codedDecisionScanError(`Unable to list decision records under ${relDir}`, error);
    }

    for (const dirent of dirents) {
      const relPath = `${relDir}/${dirent.name}`;
      if (dirent.isSymbolicLink()) {
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(relPath);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (normalizeDecisionRefPath(relPath) === null) continue;
      out.push(relPath);
    }
  }

  try {
    await walk("design/decisions");
    return { present: true, paths: out.sort() };
  } catch (error) {
    if (isAbsentDecisionsDirError(error)) return { present: false, paths: [] };
    throw error;
  }
}

export async function readLiveDecisionDir(
  cwd: string,
): Promise<{ present: boolean; entries: string[] }> {
  const listing = await listLiveDecisionFiles(cwd);
  return { present: listing.present, entries: listing.paths };
}

/**
 * The single substring rule that decides whether an ADR filename resolves a
 * task id. Deliberately preserved compatibility: `"P1-T1"` also matches
 * `"P1-T10-decision.md"`. Changing it changes both consumers (the gate and
 * the `plan lint` advisory) at once.
 */
function matchesTaskId(filename: string, taskId: string): boolean {
  const basename = filename.split("/").pop() ?? filename;
  return basename.endsWith(".md") && basename.includes(taskId);
}

/**
 * True when `entries` contains an ADR whose filename resolves `taskId`.
 *
 * Filename-only predicate, shared by `verify` and `plan lint`.
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

/**
 * Whether the decision gate applies to a task — true when the task OR its
 * phase declares `requires_decision`. The single source of truth for "is this
 * task gated", shared by `verify`'s `checkDecision` and the scaffolder so
 * scaffolding never diverges from what `verify` actually blocks.
 */
export function isDecisionRequiredForTask(
  phase: { requires_decision?: boolean },
  task: { requires_decision?: boolean },
): boolean {
  return phase.requires_decision === true || task.requires_decision === true;
}

// ---------------------------------------------------------------------------
// Status-aware resolution
// ---------------------------------------------------------------------------

/** Status words that explicitly do NOT resolve the gate. */
const BLOCKING_STATUSES = new Set(["proposed", "draft", "rejected", "superseded"]);

/** Acceptance verdict for one ADR file's content. */
export type AdrAcceptance = "accepted" | "blocked" | "empty" | "unknown_status";

/**
 * Extends the content verdicts with the two I/O outcomes the gate can hit on a
 * declared `decision_refs` path: `missing` (no such file) and `unsafe_path`
 * (escapes the project root — `..`, an absolute path, or a symlink out). Both
 * are fail-closed: the gate does NOT resolve on them, and the file is never
 * read. The gate is self-enforcing — it does not rely on `plan lint`'s
 * `TASK_DECISION_REF_UNSAFE_PATH` advisory having run first.
 */
export type ConsideredAcceptance = AdrAcceptance | "missing" | "unsafe_path" | "unreadable";

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
 * Classify one ADR's content. Resolve order:
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

// ---------------------------------------------------------------------------
// Implementation commitments
// ---------------------------------------------------------------------------

/** One GFM task-list item under an ADR's `## Implementation commitments`. */
export type AdrCommitment = {
  /** The item text after the checkbox. */
  text: string;
  /** True for `- [x]` / `- [X]`; false for `- [ ]`. */
  done: boolean;
};

/**
 * Result of scanning an ADR body for its `## Implementation commitments`
 * section. `hasSection` distinguishes "no section at all" from "section present
 * but zero checkbox items" — both surface as `items: []`, but the lint and the
 * `task prepare` surface need to tell them apart.
 */
export type AdrCommitments = {
  hasSection: boolean;
  items: AdrCommitment[];
};

/** Matches an `## Implementation commitments` heading (exact h2, case-insensitive title). */
const COMMITMENTS_HEADING = /^\s*##\s+implementation commitments\s*$/i;
/** Any h2 — marks the end of the commitments section. */
const ANY_H2 = /^\s*##\s/;
/** A GFM task-list item: `- [ ] text` / `* [x] text`. */
const CHECKBOX_ITEM = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/;

/**
 * Parse an ADR's `## Implementation commitments` checkbox list. Pure and
 * deterministic (no I/O, no summarization) — mirrors {@link parseAdrStatus}:
 * normalize newlines, strip front-matter (so a `status:` key is never mistaken
 * for body), then scan the body. Reads the FIRST matching h2 section, from after
 * the heading to the next h2 or EOF, and extracts only GFM task-list items;
 * prose and blank lines in the section are ignored. `### ` (h3) does not match.
 */
export function parseAdrCommitments(content: string): AdrCommitments {
  const { body } = parseFrontMatter(normalizeNewlines(content));
  const lines = body.split("\n");

  const start = lines.findIndex((l) => COMMITMENTS_HEADING.test(l));
  if (start === -1) return { hasSection: false, items: [] };

  const items: AdrCommitment[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (ANY_H2.test(line)) break; // next section
    const m = line.match(CHECKBOX_ITEM);
    if (m) items.push({ text: m[2]!, done: m[1]!.toLowerCase() === "x" });
  }
  return { hasSection: true, items };
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

/**
 * Reads a repo-relative file through the owned project-path boundary. `ok`
 * carries the content; `missing` = no such file; `unsafe` = the path escapes
 * the project root OR traverses any symlink component. This is the gate's
 * fail-closed I/O primitive: an unsafe `decision_refs` path is never read.
 */
export type ReadResult =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "unsafe" }
  | { kind: "unreadable"; errorCode?: string };
type RelFileReader = (relPath: string) => Promise<ReadResult>;

function diskReader(cwd: string): RelFileReader {
  return async (relPath) => {
    // NAMESPACE guard (multi-layer defense): the decision read seam ONLY reads
    // .md decision records under `design/decisions/`. The Task/phase-import schemas
    // already hard-fail a `decision_refs: [.env]` at parse time, but this seam
    // re-validates so a value reaching here by any other route (legacy plan
    // YAML parsed before the schema tightened, a direct programmatic caller, a
    // future call site) can NEVER read `.env` / a credential file and have it
    // classified "accepted" or rendered into the pack. Out-of-namespace →
    // `unsafe` (never read). Filename-scan paths are canonical full paths under
    // `design/decisions/` and pass this; README/PRUNED are filtered upstream.
    const normalized = normalizeDecisionRefPath(relPath);
    if (normalized === null || !isDecisionRefPath(normalized)) {
      return { kind: "unsafe" };
    }
    let abs: string;
    try {
      // Structural path-safety + ownership guard. Throws on `..`, absolute
      // paths, drive letters, and any symlink component.
      abs = await resolveSymlinkFreeProjectPath(cwd, normalized);
    } catch {
      return { kind: "unsafe" };
    }
    try {
      const s = await stat(abs);
      if (!s.isFile()) {
        return { kind: "unreadable", errorCode: "ENOTFILE" };
      }
      return { kind: "ok", content: await readFile(abs, "utf8") };
    } catch (error) {
      if (isAbsentDecisionsDirError(error)) return { kind: "missing" };
      return {
        kind: "unreadable",
        errorCode:
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : undefined,
      };
    }
  };
}

/**
 * The shared LIVE per-file decision read seam. Reads one repo-relative path
 * through the project-root boundary, returning `ok` / `missing` / `unsafe`
 * (see {@link ReadResult}). This is the same primitive the gate uses; pack
 * loaders route their `design/decisions/*` reads onto it (step 2b) so the live
 * decision-read logic stops being duplicated.
 *
 * SCOPE — live files ONLY. This reads any SAFE project-root-relative path,
 * INCLUDING a nested ADR (`design/decisions/p3/adr.md`) — the gate resolves
 * nested `decision_refs` today. It must NOT consult `.code-pact/state`. The
 * design-docs-ephemeral retired-decision fallback (step 5) is added in
 * gate-aware / lint-aware WRAPPERS that compose this primitive — never inside
 * it, so the pack/quality consumers never start rendering or classifying a
 * retired `.code-pact/state` record. The step-5 wrappers must still honor exact
 * canonical-ref matching: a missing live `decision_refs` target is released only
 * by a state record for the same normalized `.md` path under `design/decisions/`.
 *
 * Error contract: ENOENT/ENOTDIR → `{ kind: "missing" }`; unsafe namespace or
 * symlink escapes → `{ kind: "unsafe" }`; non-regular/unreadable targets →
 * `{ kind: "unreadable" }`, not raw errno leakage.
 */
export async function readLiveDecisionFile(
  cwd: string,
  relPath: string,
): Promise<ReadResult> {
  return diskReader(cwd)(relPath);
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
    case "unsafe_path":
      return `${c.path} (unsafe path — escapes the project root)`;
    case "unreadable":
      return `${c.path} (unreadable decision file)`;
    default:
      return c.path;
  }
}

function listingErrorResolution(taskId: string, via: DecisionResolution["via"], error: unknown): DecisionResolution {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "DECISION_SCAN_UNREADABLE";
  return {
    resolved: false,
    considered: [],
    via,
    dirPresent: true,
    reason: `Unable to scan design/decisions/ for task "${taskId}" (${code})`,
  };
}

async function resolveWith(
  taskId: string,
  decisionRefs: string[] | undefined,
  dir: { present: boolean; entries: string[] },
  read: RelFileReader,
  // design-docs-ephemeral (step 5): optional gate-aware record fallback. On a
  // MISSING explicit decision_ref, this decides whether a retired decision's
  // `.code-pact/state` record releases it (it self-checks true-ENOENT live-wins).
  // ONLY the gate callers pass it; pack loaders pass nothing, so the live decision
  // read primitives stay live-only.
  releaseMissingRef?: (rawRef: string) => Promise<boolean>,
): Promise<DecisionResolution> {
  if (decisionRefs && decisionRefs.length > 0) {
    // Explicit references are a strong contract: ALL must be accepted.
    const considered: ConsideredAdr[] = [];
    for (const ref of decisionRefs) {
      const path = toPosix(ref);
      const r = await read(ref);
      if (r.kind === "unsafe") {
        // Fail-closed: an escaping path is never read and never resolves.
        considered.push({ path, status: null, accepted: false, acceptance: "unsafe_path" });
        continue;
      }
      if (r.kind === "missing") {
        // A retired decision whose live `.md` is gone may still resolve from an
        // accepted decision-state record (step 5). The hook self-checks true-ENOENT,
        // so a present-but-inaccessible file never reaches here as a record release.
        if (releaseMissingRef && (await releaseMissingRef(ref))) {
          considered.push({ path, status: null, accepted: true, acceptance: "accepted" });
        } else {
          considered.push({ path, status: null, accepted: false, acceptance: "missing" });
        }
        continue;
      }
      if (r.kind === "unreadable") {
        considered.push({ path, status: null, accepted: false, acceptance: "unreadable" });
        continue;
      }
      const { acceptance, status } = classifyAdr(r.content);
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
    const rel = f;
    const r = await read(rel);
    if (r.kind !== "ok") {
      // Internally-constructed path, so this is a race (file removed between
      // readdir and read) or a symlink out — either way it does not resolve.
      considered.push({
        path: rel,
        status: null,
        accepted: false,
        acceptance:
          r.kind === "unsafe"
            ? "unsafe_path"
            : r.kind === "unreadable"
              ? "unreadable"
              : "missing",
      });
      continue;
    }
    const { acceptance, status } = classifyAdr(r.content);
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
  if (decisionRefs && decisionRefs.length > 0) {
    return resolveWith(
      taskId,
      decisionRefs,
      { present: true, entries: [] },
      diskReader(cwd),
      (ref) => resolveRetiredDecisionGate(cwd, ref).then((x) => x.kind === "released"),
    );
  }
  let dir: { present: boolean; entries: string[] };
  try {
    dir = await readLiveDecisionDir(cwd);
  } catch (error) {
    return listingErrorResolution(taskId, "filename-scan", error);
  }
  return resolveWith(taskId, decisionRefs, dir, diskReader(cwd), (ref) =>
    resolveRetiredDecisionGate(cwd, ref).then((x) => x.kind === "released"),
  );
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
  let dir: { present: boolean; entries: string[] } | null = null;
  let listingError: unknown = null;
  try {
    dir = await readLiveDecisionDir(cwd);
  } catch (error) {
    listingError = error;
  }
  const cache = new Map<string, ReadResult>();
  const base = diskReader(cwd);
  const cachedRead: RelFileReader = async (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath)!;
    const content = await base(relPath);
    cache.set(relPath, content);
    return content;
  };
  return {
    resolve: (taskId, decisionRefs) => {
      if (decisionRefs && decisionRefs.length > 0) {
        return resolveWith(
          taskId,
          decisionRefs,
          { present: true, entries: [] },
          cachedRead,
          (ref) => resolveRetiredDecisionGate(cwd, ref).then((x) => x.kind === "released"),
        );
      }
      if (dir === null) {
        return Promise.resolve(
          listingErrorResolution(
            taskId,
            "filename-scan",
            listingError,
          ),
        );
      }
      return resolveWith(taskId, decisionRefs, dir, cachedRead, (ref) =>
        resolveRetiredDecisionGate(cwd, ref).then((x) => x.kind === "released"),
      );
    },
  };
}

/**
 * Classify every ADR markdown file in `design/decisions/`. Reads each `.md`
 * entry and runs the pure {@link classifyAdr}, returning per-file acceptance
 * plus the parsed status word and its source (frontmatter wins over the bold
 * `**Status:**` line). Powers the `ADR_STATUS_UNRECOGNIZED` lint advisory.
 * Non-`.md` entries (e.g. `.DS_Store`) are ignored; returns `[]` when the
 * decisions directory is absent.
 *
 * Scope: recursive scan of regular `.md` decision records under
 * `design/decisions/`. The same canonical path contract is used by the gate,
 * context pack, retire/prune, and archive fallback, so quality advisories cover
 * nested ADR paths as first-class decision records.
 */
export async function classifyDecisionAdrs(cwd: string): Promise<
  {
    file: string;
    acceptance: AdrAcceptance;
    status: string | null;
    statusSource: AdrStatus["source"];
  }[]
> {
  const out: {
    file: string;
    acceptance: AdrAcceptance;
    status: string | null;
    statusSource: AdrStatus["source"];
  }[] = [];
  for (const path of await readDecisionAdrFiles(cwd)) {
    // Route through the project-contained read seam (resolveWithinProject) and
    // degrade on any error: a `design/decisions` symlinked outside the project
    // is `unsafe` → skip, and an UNREADABLE entry — e.g. a directory named
    // `*.md` planted by a hostile repo (readFile → EISDIR) — is caught and
    // skipped rather than crashing this advisory classifier with an uncoded
    // errno (exit 3). Best-effort surface, like the pack/lint decision loaders.
    let content: string;
    try {
      const r = await readLiveDecisionFile(cwd, path);
      if (r.kind !== "ok") continue;
      content = r.content;
    } catch {
      continue;
    }
    const { acceptance, status } = classifyAdr(content);
    out.push({
      file: path,
      acceptance,
      status: status.word,
      statusSource: status.source,
    });
  }
  return out;
}
