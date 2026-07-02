import {
  readOwnedText,
  statOwned,
  unlinkOwned,
} from "../project-fs/operations.ts";
import {
  PruneSourcePath,
  resolvePruneSourceDeletePath,
  resolvePruneSourceReadPath,
  resolvePruneSourceWritePath,
  resolvePrunedLedgerReadPath,
  resolvePrunedLedgerWritePath,
} from "../project-fs/authorities/prune-authority.ts";
import type { OwnedReadPath, OwnedWritePath } from "../project-fs/branded-paths.ts";
import {
  atomicWriteText,
  atomicReplaceExistingText,
  type ExpectedState,
} from "../../io/atomic-text.ts";
import {
  collectInboundLinks,
  type InboundLinkScan,
  type LinkRewriteItem,
} from "./link-collector.ts";
import {
  buildAppendedLedger,
  findPrunedRow,
  type PrunedLedgerRow,
} from "./pruned-ledger.ts";

/**
 * One inbound link whose live state no longer matches the plan at write time —
 * the working tree changed between the collector's read and the executor's
 * re-read (a concurrent edit, or a plan from a stale invocation). Any one of
 * these aborts the whole prune with zero writes (fail-closed). The target
 * record disappearing/becoming unreadable is recorded the same way.
 */
export type PruneStaleSpan = {
  source_file: string;
  line: number;
  column: number;
  /** What the plan expected at (line, column) — the collected `raw_link`. */
  expected: string;
  /** What is actually on disk there now (or a marker describing the divergence). */
  found: string;
};

/** Thrown by {@link applyPrune} when re-validation fails — the executor wrote nothing. */
export class PrunePlanStaleError extends Error {
  readonly stale: PruneStaleSpan[];
  constructor(stale: PruneStaleSpan[]) {
    super(
      `prune plan is stale: ${stale.length} item(s) no longer match the working tree — re-run decision prune`,
    );
    this.name = "PrunePlanStaleError";
    this.stale = stale;
  }
}

/** Which commit step failed — for the `DECISION_PRUNE_WRITE_FAILED` envelope. */
export type PruneWritePhase =
  | "append_ledger"
  | "rewrite_links"
  | "delete_record";

/**
 * Thrown when a disk write fails AFTER preflight passed (rename/unlink I/O
 * error — disk full, permissions, a path that became a directory). Distinct
 * from {@link PrunePlanStaleError} (a plan/tree mismatch caught before any
 * write): this is an I/O failure during the commit. `partial_applied` is the
 * honest signal of whether any mutation already landed.
 */
export class PruneWriteError extends Error {
  readonly phase: PruneWritePhase;
  readonly partial_applied: boolean;
  readonly detail: string;
  constructor(
    phase: PruneWritePhase,
    partial_applied: boolean,
    detail: string,
  ) {
    super(
      `decision prune --write failed during ${phase} (partial_applied=${partial_applied}): ${detail}`,
    );
    this.name = "PruneWriteError";
    this.phase = phase;
    this.partial_applied = partial_applied;
    this.detail = detail;
  }
}

/** One inbound link the executor rewrote in place, for the result envelope. */
export type AppliedRewrite = {
  source_file: string;
  line: number;
  column: number;
  rewrite_action: "tombstone" | "delink";
  /** The span removed (the collected `raw_link`). */
  before: string;
  /** The text written in its place. */
  after: string;
};

export type PruneApplyResult = {
  removed_file: string;
  link_rewrites_applied: AppliedRewrite[];
  ledger_row: string;
  /** `appended` — a new tombstone row was written; `already_recorded` — the decision was already in the ledger (idempotent retry), nothing appended. */
  ledger_action: "appended" | "already_recorded";
};

export type PruneApplyInput = {
  /** The decision record to delete (the plan's `remove_file`). */
  remove_file: string;
  /** The collected inbound links to rewrite (the plan's `link_rewrite.items`). */
  items: LinkRewriteItem[];
  /** The ledger row to append once preflight passes and before the record is deleted. */
  ledger: PrunedLedgerRow;
  /**
   * The exact target bytes the eligibility verdict was computed from. The target
   * must still be byte-identical at apply time and again just before deletion —
   * so an in-place edit (accepted → proposed, a new open commitment, a rewritten
   * body) at the same inode cannot get a now-ineligible record deleted.
   */
  expected_target_content: string;
};

/** `delink` keeps the visible label; an empty label collapses to nothing. */
function delinkText(item: LinkRewriteItem): string {
  return item.link_text;
}

/**
 * `tombstone` (a README decision-index row) strikes the label in place and
 * marks it pruned — removing the LINK (so check:doc-links has nothing to
 * resolve to the now-deleted file) while leaving a visible, dead row. An empty
 * label collapses to the bare marker.
 */
function tombstoneText(item: LinkRewriteItem): string {
  return item.link_text.trim() === ""
    ? "(pruned)"
    : `~~${item.link_text}~~ (pruned)`;
}

function replacementFor(item: LinkRewriteItem): string {
  return item.rewrite_action === "tombstone"
    ? tombstoneText(item)
    : delinkText(item);
}

/** Char offset where each `/\r?\n/`-split line begins — matches the collector's split. */
function lineStartOffsets(content: string): number[] {
  const starts = [0];
  const re = /\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) starts.push(m.index + m[0]!.length);
  return starts;
}

/** Full-tuple identity of a collected item — any field change makes it a different plan. */
function itemKey(it: LinkRewriteItem): string {
  return JSON.stringify([
    it.source_file,
    it.line,
    it.column,
    it.raw_link,
    it.raw_href,
    it.link_text,
    it.normalized_target,
    it.link_kind,
    it.rewrite_action,
  ]);
}

/**
 * Diff the plan against a FRESH collection of the live tree. The plan must
 * describe the live tree exactly: a shifted span, a link reclassified (e.g.
 * newly wrapped in a code span or image — which a byte-slice check alone would
 * miss), a removed link, a NEW inbound link the plan would not rewrite (and so
 * would leave dangling after deletion), or a source that became
 * unreadable / reference-style all produce stale spans.
 */
function diffPlanAgainstLive(
  planned: LinkRewriteItem[],
  live: InboundLinkScan,
): PruneStaleSpan[] {
  const out: PruneStaleSpan[] = [];
  const liveKeys = new Set(live.items.map(itemKey));
  const planKeys = new Set(planned.map(itemKey));
  for (const it of planned) {
    if (!liveKeys.has(itemKey(it))) {
      out.push({
        source_file: it.source_file,
        line: it.line,
        column: it.column,
        expected: it.raw_link,
        found: "<no longer a collected inbound link at this span>",
      });
    }
  }
  for (const it of live.items) {
    if (!planKeys.has(itemKey(it))) {
      out.push({
        source_file: it.source_file,
        line: it.line,
        column: it.column,
        expected: "<inbound link not in the plan>",
        found: it.raw_link,
      });
    }
  }
  for (const iss of live.issues) {
    out.push({
      source_file: iss.source_file,
      line: iss.line ?? 0,
      column: 0,
      expected: "<a rewritable inbound-link plan>",
      found: `<${iss.reason}>`,
    });
  }
  return out;
}

function groupBySource(
  items: LinkRewriteItem[],
): Map<string, LinkRewriteItem[]> {
  const byFile = new Map<string, LinkRewriteItem[]>();
  for (const it of items) {
    const arr = byFile.get(it.source_file);
    if (arr) arr.push(it);
    else byFile.set(it.source_file, [it]);
  }
  return byFile;
}

function errDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code ?? (err instanceof Error ? err.message : String(err));
}

type TargetCheck =
  | { ok: true; abs: OwnedReadPath; ino: number; dev: number }
  | { ok: false; found: string };

/**
 * Verify the target record is STILL the same readable regular file with the same
 * bytes the verdict was computed from, and is STILL inside the project. Used
 * identically at preflight, just before the first write, and just before the
 * delete — one helper so the invariant can't drift between copies.
 *
 *  - **`resolveWithinProject` is re-run every call** (not a cached abs path), so an
 *    ancestor directory swapped for a symlink that escapes the repo after preflight
 *    is caught at commit time — `--write` only ever touches repo-internal files.
 *  - Reads CONTENT FIRST, then `stat`s, so a path swapped for a coincidentally-
 *    matching file cannot slip past the inode check (the inode/dev comparison is
 *    the last filesystem read before the caller acts).
 *
 * `expectedIno`/`expectedDev` are omitted on the first (preflight) call, which
 * establishes them.
 */
async function inspectTarget(
  cwd: string,
  relPath: string,
  expectedContent: string,
  expectedIno?: number,
  expectedDev?: number,
): Promise<TargetCheck> {
  let abs: OwnedReadPath;
  try {
    abs = await resolvePruneSourceReadPath(cwd, PruneSourcePath.parse(relPath));
  } catch {
    return { ok: false, found: "<path now escapes the project root>" };
  }
  let content: string;
  try {
    content = await readOwnedText(abs);
  } catch (err) {
    return {
      ok: false,
      found:
        errDetail(err) === "ENOENT"
          ? "<missing>"
          : `<unreadable: ${errDetail(err)}>`,
    };
  }
  if (content !== expectedContent)
    return { ok: false, found: "<record content changed since the verdict>" };
  let st;
  try {
    st = await statOwned(abs);
  } catch (err) {
    return {
      ok: false,
      found:
        errDetail(err) === "ENOENT"
          ? "<missing>"
          : `<unreadable: ${errDetail(err)}>`,
    };
  }
  if (!st.isFile())
    return {
      ok: false,
      found: st.isDirectory() ? "<directory>" : "<not a regular file>",
    };
  if (
    expectedIno !== undefined &&
    (st.ino !== expectedIno || st.dev !== expectedDev)
  ) {
    return {
      ok: false,
      found: "<record replaced since the verdict (inode changed)>",
    };
  }
  return { ok: true, abs, ino: st.ino, dev: st.dev };
}

type PendingRewrite = {
  rel: string;
  /** The exact bytes read in preflight (1c) — the source is refused if it no longer matches at write time. */
  original: string;
  /** The rewritten bytes to commit. */
  content: string;
  applied: AppliedRewrite[];
};

/**
 * Test-only seams to drive the commit-phase failure paths deterministically
 * (a concurrent edit, a vanished record) without depending on OS permissions.
 * Never set in production — `runDecisionPruneWrite` passes none.
 */
export type ApplyPruneHooks = {
  /** Invoked at the start of the commit phase, before the pre-write target re-check. */
  beforeLedgerWrite?: () => Promise<void>;
  /** Invoked just before the ledger commit (after the target re-check; e.g. remove design/decisions/ to test a vanished parent). */
  beforeLedgerCommit?: () => Promise<void>;
  /** Invoked just before a source file's write-time re-read (e.g. mutate it to simulate a concurrent edit). */
  beforeSourceWrite?: (rel: string) => Promise<void>;
  /** Invoked just before the record's delete (e.g. remove it to simulate a concurrent unlink). */
  beforeDelete?: () => Promise<void>;
};

/**
 * Execute a `decision prune` plan. The plan MUST come from the same collector
 * run as the dry-run; this re-validates against the live tree and refuses a
 * plan that no longer matches (no markdown is re-parsed — the collected spans
 * are applied verbatim).
 *
 * Cross-file atomicity is impossible on POSIX without a journal, so the design
 * goal is "**a failure never leaves a broken-link or `validate`-breaking
 * state**", achieved by doing all fallible reads/computes first and committing
 * in the least-harmful order:
 *
 *  - **Phase 1 — preflight (NO writes).** The target must still be a readable
 *    regular file; the plan must still describe the live tree exactly; every
 *    span must still byte-match; the ledger's next content is read+computed.
 *    Any plan/tree divergence → {@link PrunePlanStaleError}; an unreadable
 *    ledger → {@link PruneWriteError} (`append_ledger`, `partial_applied:false`).
 *    Nothing is written.
 *  - **Phase 2 — commit, least-harmful order.** (a) write the ledger FIRST — a
 *    row for a still-present record is benign (the status-aware check only
 *    consults the ledger once the file is absent), so a ledger failure here
 *    leaves docs byte-identical; (b) rewrite inbound links (atomic per file,
 *    back-to-front); (c) delete the record LAST (the only irreversible step).
 *    A commit-time I/O failure throws {@link PruneWriteError} carrying the phase
 *    and whether anything already landed.
 */
export async function applyPrune(
  cwd: string,
  input: PruneApplyInput,
  hooks: ApplyPruneHooks = {},
): Promise<PruneApplyResult> {
  // ── Phase 1: preflight — NO writes ──

  // 1a. The target must still be an in-project, readable, regular file whose
  // CONTENT matches the verdict bytes — an in-place edit (accepted → proposed, a
  // new open commitment, a rewritten body) keeps the inode but invalidates the
  // eligibility; an ancestor symlinked out of the repo would escape the boundary.
  // This establishes the inode/dev re-checked before the first write and the delete.
  const t0 = await inspectTarget(
    cwd,
    input.remove_file,
    input.expected_target_content,
  );
  if (!t0.ok) {
    throw new PrunePlanStaleError([
      {
        source_file: input.remove_file,
        line: 0,
        column: 0,
        expected: "<the decision record unchanged since the verdict>",
        found: t0.found,
      },
    ]);
  }
  const targetIno = t0.ino;
  const targetDev = t0.dev;

  // 1b. Re-collect inbound links; the plan must describe the live tree exactly.
  const live = await collectInboundLinks(cwd, input.remove_file);
  const drift = diffPlanAgainstLive(input.items, live);
  if (drift.length > 0) throw new PrunePlanStaleError(drift);

  // 1c. Re-read each source, confirm every span still byte-matches, and compute
  // the rewritten content (closes the residual window after the re-collect).
  const byFile = groupBySource(input.items);
  const stale: PruneStaleSpan[] = [];
  const pending: PendingRewrite[] = [];
  for (const [file, its] of byFile) {
    let abs: OwnedReadPath;
    let content: string;
    try {
      abs = await resolvePruneSourceReadPath(cwd, PruneSourcePath.parse(file));
      content = await readOwnedText(abs);
    } catch {
      for (const it of its) {
        stale.push({
          source_file: file,
          line: it.line,
          column: it.column,
          expected: it.raw_link,
          found: "<source no longer readable>",
        });
      }
      continue;
    }
    const starts = lineStartOffsets(content);
    let fileOk = true;
    for (const it of its) {
      const lineStart = starts[it.line - 1];
      if (lineStart === undefined) {
        stale.push({
          source_file: file,
          line: it.line,
          column: it.column,
          expected: it.raw_link,
          found: "<line no longer exists>",
        });
        fileOk = false;
        continue;
      }
      const off = lineStart + (it.column - 1);
      const found = content.slice(off, off + it.raw_link.length);
      if (found !== it.raw_link) {
        stale.push({
          source_file: file,
          line: it.line,
          column: it.column,
          expected: it.raw_link,
          found,
        });
        fileOk = false;
      }
    }
    if (!fileOk) continue;
    const edits = its
      .map(it => ({
        off: starts[it.line - 1]! + (it.column - 1),
        len: it.raw_link.length,
        after: replacementFor(it),
        it,
      }))
      .sort((a, b) => b.off - a.off); // highest offset first → earlier edits never shift later spans
    let out = content;
    const appliedHere: AppliedRewrite[] = [];
    for (const e of edits) {
      out = out.slice(0, e.off) + e.after + out.slice(e.off + e.len);
      appliedHere.push({
        source_file: file,
        line: e.it.line,
        column: e.it.column,
        rewrite_action: e.it.rewrite_action,
        before: e.it.raw_link,
        after: e.after,
      });
    }
    pending.push({
      rel: file,
      original: content,
      content: out,
      applied: appliedHere,
    });
  }
  if (stale.length > 0) throw new PrunePlanStaleError(stale);

  // 1d. Read+compute the ledger's next content (the fallible ledger READ done
  // before any write). A non-ENOENT read error is a write-capability failure.
  let prepared;
  try {
    prepared = await buildAppendedLedger(cwd, input.ledger);
  } catch (err) {
    throw new PruneWriteError("append_ledger", false, errDetail(err));
  }

  // ── Phase 2: commit, ordered so a failure is least harmful ──

  try {
    if (hooks.beforeLedgerWrite) await hooks.beforeLedgerWrite();
  } catch (err) {
    throw new PruneWriteError("append_ledger", false, errDetail(err));
  }

  // Re-verify the target IMMEDIATELY before the first write — the verdict's
  // preflight may have taken many reads, during which the record could have been
  // edited (accepted → proposed), replaced, or symlinked out of the repo. Catching
  // it here means a target that drifted before any mutation is a zero-write
  // PLAN_STALE, not a late delete-phase failure after ledger + docs were changed.
  const tPre = await inspectTarget(
    cwd,
    input.remove_file,
    input.expected_target_content,
    targetIno,
    targetDev,
  );
  if (!tPre.ok) {
    throw new PrunePlanStaleError([
      {
        source_file: input.remove_file,
        line: 0,
        column: 0,
        expected: "<the decision record unchanged since the verdict>",
        found: tPre.found,
      },
    ]);
  }

  // 2a. Ledger FIRST. A row for a still-present record is benign, so a ledger
  // failure here leaves inbound docs byte-identical. Re-read PRUNED.md at commit
  // time in BOTH branches (the advisory lock does not guard editors / other tools):
  //   - already recorded → do NOT append (no duplicate tombstone), but VERIFY the
  //     row is still present; if it was removed since preflight, refuse rather than
  //     delete the record with no tombstone behind it.
  //   - not recorded → refuse if PRUNED.md changed since preflight, else append.
  let ledger_action: "appended" | "already_recorded";
  // The row reported in the result — reflects the ledger as it is at COMMIT time.
  let committedLedgerRow = prepared.row;
  try {
    if (hooks.beforeLedgerCommit) await hooks.beforeLedgerCommit();
    // Re-resolve the ledger path at COMMIT time (not the cached preflight one), so
    // a design/decisions ancestor symlinked out of the repo since preflight is
    // caught here — never read/write an external PRUNED.md.
    const ledgerPath = await resolvePrunedLedgerWritePath(cwd);
    // Read the ledger as it stands now, tracking existence precisely so "absent"
    // is distinguishable from "present but empty".
    let currentLedger = "";
    let currentExists = true;
    try {
      currentLedger = await readOwnedText(
        await resolvePrunedLedgerReadPath(cwd),
      );
    } catch (err) {
      if (errDetail(err) !== "ENOENT") throw err;
      currentExists = false;
    }
    if (prepared.already_recorded) {
      const currentRow =
        prepared.normalized_decision !== null
          ? findPrunedRow(currentLedger, prepared.normalized_decision)
          : null;
      if (currentRow === null) {
        throw new PruneWriteError(
          "append_ledger",
          false,
          "ledger no longer records this decision (PRUNED.md changed after preflight)",
        );
      }
      // Report the row as it actually stands now (the user may have hand-edited
      // its phase/date/rationale) — not the stale preflight copy.
      committedLedgerRow = currentRow.trim();
      ledger_action = "already_recorded";
    } else {
      // The ledger must be exactly as preflight saw it — same EXISTENCE (so an
      // empty file appearing where we expected none is refused, not silently
      // overwritten) and same bytes. The existence-aware `ExpectedState` re-checks
      // again just before the rename.
      if (
        currentExists !== prepared.existed ||
        currentLedger !== prepared.existing_content
      ) {
        throw new PruneWriteError(
          "append_ledger",
          false,
          "ledger (PRUNED.md) changed after preflight",
        );
      }
      const expected: ExpectedState = prepared.existed
        ? { kind: "present", content: prepared.existing_content }
        : { kind: "absent" };
      // `mkdir: false` — the ledger may CREATE PRUNED.md, but must NOT re-create a
      // vanished design/decisions/ parent (symmetric with the source rewrites'
      // replace-only helper); a removed parent → WRITE_FAILED, not a resurrected tree.
      await atomicWriteText(ledgerPath, prepared.content, expected, {
        mkdir: false,
      });
      ledger_action = "appended";
    }
  } catch (err) {
    if (err instanceof PruneWriteError) throw err;
    throw new PruneWriteError("append_ledger", false, errDetail(err));
  }

  // 2b. Rewrite inbound links. RE-RESOLVE each source path (catching an ancestor
  // symlinked out of the repo since preflight) and re-read it IMMEDIATELY before
  // writing, refusing if it changed since the preflight read (a concurrent edit by
  // an editor / git / another tool — which the advisory lock does NOT guard). We
  // never clobber a concurrent edit with stale rewritten content; we use an
  // EXISTING-file replace (no parent re-creation) so a vanished source / parent fails.
  const applied: AppliedRewrite[] = [];
  // Has THIS invocation already mutated the tree? The ledger row counts only when
  // it was appended this run (not an idempotent already-recorded retry), plus any
  // source already rewritten. Drives the honest `partial_applied` on a later failure.
  const mutationLanded = (): boolean =>
    ledger_action === "appended" || applied.length > 0;
  for (const r of pending) {
    try {
      if (hooks.beforeSourceWrite) await hooks.beforeSourceWrite(r.rel);
    } catch (err) {
      throw new PruneWriteError(
        "rewrite_links",
        mutationLanded(),
        errDetail(err),
      );
    }
    let abs: OwnedWritePath;
    try {
      abs = await resolvePruneSourceWritePath(
        cwd,
        PruneSourcePath.parse(r.rel),
      );
    } catch {
      throw new PruneWriteError(
        "rewrite_links",
        mutationLanded(),
        `source path escapes the project root: ${r.rel}`,
      );
    }
    let current: string | null = null;
    try {
      current = await readOwnedText(
        await resolvePruneSourceReadPath(cwd, PruneSourcePath.parse(r.rel)),
      );
    } catch {
      current = null;
    }
    if (current !== r.original) {
      throw new PruneWriteError(
        "rewrite_links",
        mutationLanded(),
        `source changed after preflight: ${r.rel}`,
      );
    }
    try {
      // Pass the expected content so the helper re-checks just before rename,
      // narrowing the drift window to the temp-write gap.
      await atomicReplaceExistingText(abs, r.content, r.original);
    } catch (err) {
      throw new PruneWriteError(
        "rewrite_links",
        mutationLanded(),
        errDetail(err),
      );
    }
    applied.push(...r.applied);
  }

  // 2c. Delete the record LAST (the only irreversible step). `inspectTarget` reads
  // the CONTENT first then `stat`s, so the inode/dev check is the last filesystem
  // read before `unlink` — a path swapped for a coincidentally-matching file cannot
  // bypass it (reading content first would otherwise let a same-content swap through).
  // The remaining stat→unlink gap is one syscall; POSIX has no portable
  // atomic-unlink-if-inode. A drift here (the record edited / replaced / removed
  // before we deleted it) is reported honestly, never claimed as a removal.
  try {
    if (hooks.beforeDelete) await hooks.beforeDelete();
    // Re-resolve + re-verify (content then inode/dev); unlink the FRESHLY resolved
    // path, so an ancestor symlinked out of the repo can never redirect the unlink.
    const tDel = await inspectTarget(
      cwd,
      input.remove_file,
      input.expected_target_content,
      targetIno,
      targetDev,
    );
    if (!tDel.ok) {
      throw new PruneWriteError(
        "delete_record",
        mutationLanded(),
        `target changed under prune (${tDel.found}) — refusing to delete`,
      );
    }
    await unlinkOwned(
      await resolvePruneSourceDeletePath(
        cwd,
        PruneSourcePath.parse(input.remove_file),
      ),
    );
  } catch (err) {
    if (err instanceof PruneWriteError) throw err;
    throw new PruneWriteError(
      "delete_record",
      mutationLanded(),
      errDetail(err) === "ENOENT"
        ? "target disappeared before unlink"
        : errDetail(err),
    );
  }

  applied.sort((a, b) =>
    a.source_file !== b.source_file
      ? a.source_file < b.source_file
        ? -1
        : 1
      : a.line !== b.line
        ? a.line - b.line
        : a.column - b.column,
  );
  return {
    removed_file: input.remove_file,
    link_rewrites_applied: applied,
    ledger_row: committedLedgerRow,
    ledger_action,
  };
}
