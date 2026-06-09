import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { resolveWithinProject } from "../path-safety.ts";
import {
  collectInboundLinks,
  type InboundLinkScan,
  type LinkRewriteItem,
} from "./link-collector.ts";
import { appendPrunedLedger, serializePrunedRow, type PrunedLedgerRow } from "./pruned-ledger.ts";

/**
 * One inbound link whose live state no longer matches the plan at write time —
 * the working tree changed between the collector's read and the executor's
 * re-read (a concurrent edit, or a plan from a stale invocation). Any one of
 * these aborts the whole prune with zero writes (fail-closed).
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
      `prune plan is stale: ${stale.length} inbound link(s) no longer match the working tree — re-run decision prune`,
    );
    this.name = "PrunePlanStaleError";
    this.stale = stale;
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
};

export type PruneApplyInput = {
  /** The decision record to delete (the plan's `remove_file`). */
  remove_file: string;
  /** The collected inbound links to rewrite (the plan's `link_rewrite.items`). */
  items: LinkRewriteItem[];
  /** The ledger row to append once the rewrites succeed and before the record is deleted. */
  ledger: PrunedLedgerRow;
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
  return item.link_text.trim() === "" ? "(pruned)" : `~~${item.link_text}~~ (pruned)`;
}

function replacementFor(item: LinkRewriteItem): string {
  return item.rewrite_action === "tombstone" ? tombstoneText(item) : delinkText(item);
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
function diffPlanAgainstLive(planned: LinkRewriteItem[], live: InboundLinkScan): PruneStaleSpan[] {
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

function groupBySource(items: LinkRewriteItem[]): Map<string, LinkRewriteItem[]> {
  const byFile = new Map<string, LinkRewriteItem[]>();
  for (const it of items) {
    const arr = byFile.get(it.source_file);
    if (arr) arr.push(it);
    else byFile.set(it.source_file, [it]);
  }
  return byFile;
}

// Per-call-unique temp suffix so two writers to the same path never collide on
// the temp file (the CLI serializes via the write lock, but the helper must be
// safe if ever called without it). pid + a monotonic counter suffices in-process.
let tmpSeq = 0;
function tmpPathFor(abs: string): string {
  return `${abs}.${process.pid}.${tmpSeq++}.prune-tmp`;
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  const tmp = tmpPathFor(abs);
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, abs);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // don't leave a stray temp file behind
    throw err;
  }
}

/**
 * Execute a `decision prune` plan: rewrite every inbound link, append the
 * ledger row, then delete the decision record. The plan MUST come from the same
 * collector run as the dry-run; this re-collects on the live tree and refuses to
 * act on a plan that no longer matches it (no markdown is re-parsed for the
 * rewrite — the collected spans are applied verbatim).
 *
 * Cross-file atomicity is impossible on a POSIX filesystem without a journal,
 * so this guarantees the next-best thing: it never leaves a broken-link or
 * validate-breaking intermediate state.
 *
 *  - **Phase 1 — re-validate.** Re-collect inbound links on the live tree; the
 *    plan must describe it exactly. Then re-read each source and confirm every
 *    span still byte-equals its `raw_link`. Any divergence throws
 *    {@link PrunePlanStaleError} BEFORE a single byte is written.
 *  - **Phase 2 — rewrite links.** Per file, edits apply back-to-front (highest
 *    offset first) so an earlier rewrite never shifts a later span. Each file is
 *    written atomically (temp + rename).
 *  - **Phase 3 — append the ledger.** The durable tombstone is recorded BEFORE
 *    the irreversible deletion, so the record's removal never outruns its audit
 *    row. A row for a still-present file is benign (the status-aware check only
 *    consults the ledger once the file is absent; the path is a code span, not a link).
 *  - **Phase 4 — delete the record.** The only irreversible step, done last,
 *    after links point nowhere and the ledger row exists.
 */
export async function applyPrune(
  cwd: string,
  input: PruneApplyInput,
): Promise<PruneApplyResult> {
  // Phase 1a — the plan must still describe the live tree exactly.
  const live = await collectInboundLinks(cwd, input.remove_file);
  const drift = diffPlanAgainstLive(input.items, live);
  if (drift.length > 0) throw new PrunePlanStaleError(drift);

  // Phase 1b — re-read each source and confirm every span still matches (closes
  // the residual window between the re-collect above and the writes below).
  const byFile = groupBySource(input.items);
  const contents = new Map<string, string>();
  const stale: PruneStaleSpan[] = [];
  for (const [file, its] of byFile) {
    let content: string;
    try {
      const abs = await resolveWithinProject(cwd, file);
      content = await readFile(abs, "utf8");
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
    contents.set(file, content);
    const starts = lineStartOffsets(content);
    for (const it of its) {
      const lineStart = starts[it.line - 1];
      if (lineStart === undefined) {
        stale.push({ source_file: file, line: it.line, column: it.column, expected: it.raw_link, found: "<line no longer exists>" });
        continue;
      }
      const off = lineStart + (it.column - 1);
      const found = content.slice(off, off + it.raw_link.length);
      if (found !== it.raw_link) {
        stale.push({ source_file: file, line: it.line, column: it.column, expected: it.raw_link, found });
      }
    }
  }
  if (stale.length > 0) throw new PrunePlanStaleError(stale);

  // Phase 2 — rewrite inbound links (back-to-front per file, atomic per file).
  const applied: AppliedRewrite[] = [];
  for (const [file, its] of byFile) {
    const content = contents.get(file)!;
    const starts = lineStartOffsets(content);
    const edits = its
      .map((it) => ({
        off: starts[it.line - 1]! + (it.column - 1),
        len: it.raw_link.length,
        after: replacementFor(it),
        it,
      }))
      .sort((a, b) => b.off - a.off); // highest offset first → earlier edits never shift later spans
    let out = content;
    for (const e of edits) {
      out = out.slice(0, e.off) + e.after + out.slice(e.off + e.len);
      applied.push({
        source_file: file,
        line: e.it.line,
        column: e.it.column,
        rewrite_action: e.it.rewrite_action,
        before: e.it.raw_link,
        after: e.after,
      });
    }
    const abs = await resolveWithinProject(cwd, file);
    await atomicWrite(abs, out);
  }

  // Phase 3 — append the append-only ledger row (the tombstone) BEFORE deletion.
  const ledger_row = serializePrunedRow(input.ledger);
  await appendPrunedLedger(cwd, input.ledger);

  // Phase 4 — delete the decision record (the only irreversible step, done last).
  // ENOENT (the record vanished under us after the verdict) is tolerated: the
  // desired end state — record absent — already holds.
  const absTarget = await resolveWithinProject(cwd, input.remove_file);
  try {
    await unlink(absTarget);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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
  return { removed_file: input.remove_file, link_rewrites_applied: applied, ledger_row };
}
