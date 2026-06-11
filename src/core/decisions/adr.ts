import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontMatter } from "../pack/front-matter.ts";
import { resolveWithinProject } from "../path-safety.ts";
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
  return (await readLiveDecisionDir(cwd)).entries;
}

/**
 * Files under `design/decisions/` that are NOT decisions and must be skipped by
 * every candidate scan (gate filename resolution + ADR quality checks): the
 * index, and the `decision prune` tombstone ledger. Without this, the lenient
 * "no status line → accepted" rule would misclassify the ledger as an accepted
 * ADR. See design/decisions/decision-lifecycle-rfc.md.
 */
export const NON_DECISION_FILES = new Set(["README.md", "PRUNED.md"]);

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
export async function readLiveDecisionDir(
  cwd: string,
): Promise<{ present: boolean; entries: string[] }> {
  try {
    const entries = await readdir(join(cwd, "design", "decisions"));
    return { present: true, entries: entries.filter((e) => !NON_DECISION_FILES.has(e)) };
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
export type ConsideredAcceptance = AdrAcceptance | "missing" | "unsafe_path";

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
 * Reads a repo-relative file through the project-root boundary. `ok` carries
 * the content; `missing` = no such file; `unsafe` = the path escapes the
 * project root (`..`, absolute, Windows drive, or an existing-ancestor symlink
 * that resolves outside `cwd`). This is the gate's fail-closed I/O primitive:
 * an unsafe `decision_refs` path is never read.
 */
export type ReadResult =
  | { kind: "ok"; content: string }
  | { kind: "missing" }
  | { kind: "unsafe" };
type RelFileReader = (relPath: string) => Promise<ReadResult>;

function diskReader(cwd: string): RelFileReader {
  return async (relPath) => {
    let abs: string;
    try {
      // Structural path-safety + symlink-escape guard. Throws on `..`,
      // absolute paths, drive letters, and ancestors that realpath outside cwd.
      abs = await resolveWithinProject(cwd, relPath);
    } catch {
      return { kind: "unsafe" };
    }
    try {
      return { kind: "ok", content: await readFile(abs, "utf8") };
    } catch (error) {
      if (isAbsentDecisionsDirError(error)) return { kind: "missing" };
      throw error;
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
 * retired `.code-pact/state` record. And note the SCOPE MISMATCH the step-5
 * wrappers must honor: a `.code-pact/state` decision-state record is top-level
 * `design/decisions/*.md` EXACT-MATCH only, so a nested `decision_refs` with no
 * live file must stay fail-closed — never resolved from a state record.
 *
 * Error contract: ENOENT/ENOTDIR → `{ kind: "missing" }` (no file at that path
 * — `isAbsentDecisionsDirError` covers both); ANY OTHER read error THROWS
 * (matching the gate's fail-closed stance). Callers that are OPTIONAL context
 * sources (the pack loaders) must wrap this in their own `catch → skip` to
 * preserve their degrade-on-any-error contract; they must NOT push that leniency
 * down here.
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
    default:
      return c.path;
  }
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
    const rel = `design/decisions/${f}`;
    const r = await read(rel);
    if (r.kind !== "ok") {
      // Internally-constructed path, so this is a race (file removed between
      // readdir and read) or a symlink out — either way it does not resolve.
      considered.push({
        path: rel,
        status: null,
        accepted: false,
        acceptance: r.kind === "unsafe" ? "unsafe_path" : "missing",
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
  const dir = await readLiveDecisionDir(cwd);
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
  const dir = await readLiveDecisionDir(cwd);
  const cache = new Map<string, ReadResult>();
  const base = diskReader(cwd);
  const cachedRead: RelFileReader = async (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath)!;
    const content = await base(relPath);
    cache.set(relPath, content);
    return content;
  };
  return {
    resolve: (taskId, decisionRefs) =>
      resolveWith(taskId, decisionRefs, dir, cachedRead, (ref) =>
        resolveRetiredDecisionGate(cwd, ref).then((x) => x.kind === "released"),
      ),
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
 * Scope (deliberate): this is a **flat, top-level** scan of `design/decisions/`
 * — it does not recurse into subdirectories. The decision *gate*
 * ({@link resolveDecisionGate}) reads nested `decision_refs` paths (e.g.
 * `design/decisions/p3/adr.md`) just fine, so a nested ADR with a typo'd status
 * still BLOCKS the gate correctly; only the `ADR_STATUS_UNRECOGNIZED` advisory
 * — which warns about the typo before you hit the block — does not see nested
 * files yet. Recursing here is a possible future refinement; it was left out of
 * the trust-hardening RFC to avoid a behavior change at release time.
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
  for (const name of await readDecisionAdrFiles(cwd)) {
    if (!name.endsWith(".md")) continue;
    const content = await readFile(
      join(cwd, "design", "decisions", name),
      "utf8",
    );
    const { acceptance, status } = classifyAdr(content);
    out.push({
      file: `design/decisions/${name}`,
      acceptance,
      status: status.word,
      statusSource: status.source,
    });
  }
  return out;
}
