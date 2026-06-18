import { readdir } from "node:fs/promises";
import { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import {
  archiveBundlesDir,
  archiveDecisionsDir,
  archiveEventPacksDir,
  archivePhasesDir,
} from "./paths.ts";
import {
  compactArchive,
  planCompactArchive,
  type ArchiveDeleteSkip,
  type CompactArchiveOutcome,
  type CompactArchivePlan,
} from "./archive-bundle-cleanup.ts";
import {
  applyArchiveRetention,
  planArchiveRetention,
  type RetentionApplyHooks,
  type RetentionDeleteOutcome,
  type RetentionPlan,
} from "./archive-retention.ts";
import { readDeleteIntent, recoverPendingDeletes, type RecoveryOutcome } from "./delete-intent-journal.ts";
import { runValidate } from "../../commands/validate.ts";
import { runPlanLint } from "../../commands/plan-lint.ts";

// ---------------------------------------------------------------------------
// `state archive-maintain` — the HIGH-LEVEL, operator-facing archive-maintenance
// orchestration. It is a THIN, HONEST layer over the existing archive primitives:
// it adds NO new destructive semantics and NO new persistent state. It exists so an
// operator runs ONE obvious command instead of remembering the low-level sequence
// (`recover → compact-archive → archive-retention → compact-again → validate →
// plan lint`) and the rules for interpreting recovered / skipped /
// bundle_member_removed / mixed-source / source:both states (the "Certifying a repo
// as bounded" procedure already documented in docs/cli-contract.md → `state
// archive-retention`).
//
// MULTI-CONTRIBUTOR / PR SAFETY. This module writes NO new tracked file — no global
// maintenance ledger, no status/cache file, no timestamps/hostnames/PIDs into
// archive state. It only drives the existing content-/id-addressed archive writers
// (one file per record, content-addressed bundles), whose outputs are deterministic
// and merge-friendly by construction. So `archive-maintain` does not worsen the
// cross-branch merge posture: two contributors who run it on independent branches
// produce byte-identical archive bundles for the same set of records (the bundle
// filename is the member-id-set hash, the bytes are canonical). The ONLY mutation is
// to `.code-pact/state/archive` and the existing read-only validation/lint paths.
//
// LOCK DISCIPLINE. The CLI acquires ONE outer write lock for the whole `--write`
// orchestration (not a lock per substep). Dry-run is lock-free and read-only.
//
// BOUNDED-STATUS HONESTY. The headline must never over-claim. This layer bounds the
// archive FILE COUNT (compaction folds the loose tail into ~one bundle per kind) and
// removes UNREFERENCED old truth (retention). It does NOT bound a single bundle's
// BYTE SIZE — `bundle_byte_size_bounded` is ALWAYS false here; sharding is deferred.
// The post-write bounded status is derived from a FRESH re-plan of the real on-disk
// store (not a projection), so a source:both follow-up, a deferred mixed pair, an
// un-foldable `bundle_stale` loose, or an unrecovered journal all read as NOT bounded.
// ---------------------------------------------------------------------------

/** The three archive bundle kinds, in a stable order for deterministic output. */
const KINDS: readonly ArchiveBundleKind[] = ArchiveBundleKind.options;

/** Physical archive file counts (the thing the file-count bound is about). */
export type ArchiveFileCounts = {
  /** loose per-record files across phases/ + event-packs/ + decisions/. */
  loose_records: number;
  /** content-addressed bundle files. */
  bundles: number;
  /** loose_records + bundles. */
  total: number;
};

async function countJsonFiles(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith(".json")).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/** Count the physical archive files on disk (loose records + bundles). Read-only. */
export async function countArchiveFiles(cwd: string): Promise<ArchiveFileCounts> {
  const loose =
    (await countJsonFiles(archivePhasesDir(cwd))) +
    (await countJsonFiles(archiveEventPacksDir(cwd))) +
    (await countJsonFiles(archiveDecisionsDir(cwd)));
  const bundles = await countJsonFiles(archiveBundlesDir(cwd));
  return { loose_records: loose, bundles, total: loose + bundles };
}

/** The exact counts that drive `file_count_bounded` — so a "not bounded" verdict is never
 *  a bare boolean: the operator (and the human renderer) can see WHICH compaction work
 *  remains. The flag is true iff every count here is 0 / false. */
export type FileCountReasons = {
  /** loose records not yet in a bundle (would be folded). */
  would_bundle: number;
  /** loose records a verified bundle already holds (would be deleted). */
  would_delete: number;
  /** diverging loose records adopted into a bundle (would supersede). */
  would_supersede: number;
  /** superseded bundle files awaiting retire. */
  would_retire_bundles: number;
  /** records compaction CANNOT fold (bundle_stale / invalid member / unsafe path) — fail-closed. */
  would_skip: number;
  /** a pending delete-intent journal means the store is mid-mutation (unsettled). */
  pending_delete_intent: boolean;
};

/** The exact counts that drive `unreferenced_old_truth_bounded`. The flag is true iff every
 *  count is 0 / false. */
export type UnreferencedReasons = {
  /** records retention would still drop (a source:both survivor, a deferred pair, etc.). */
  would_drop: number;
  /** a pending delete-intent journal means the store is mid-mutation (unsettled). */
  pending_delete_intent: boolean;
};

/** The bounded-status model. `referenced_truth_retained` is true BY CONSTRUCTION
 *  (retention never drops a referenced record — it blocks them). `bundle_byte_size_bounded`
 *  is ALWAYS false (sharding deferred) — the explicit no-over-claim field. Each `*_bounded`
 *  flag is paired with the exact counts that drove it, so a "not bounded" verdict is
 *  actionable, never a bare boolean. */
export type BoundedStatus = {
  /** the loose tail is folded and no compaction work remains (no foldable loose, no
   *  un-foldable `bundle_stale` loose, no superseded bundle to retire). */
  file_count_bounded: boolean;
  /** the counts that drive `file_count_bounded` (all 0/false ⟺ bounded). */
  file_count_unbounded_reasons: FileCountReasons;
  /** retention has no `would_drop` record left to remove (a source:both follow-up,
   *  a deferred mixed pair, or any other droppable record makes this false). */
  unreferenced_old_truth_bounded: boolean;
  /** the counts that drive `unreferenced_old_truth_bounded` (all 0/false ⟺ bounded). */
  unreferenced_old_truth_unbounded_reasons: UnreferencedReasons;
  /** always true — referenced records are kept (blocked), never dropped. */
  referenced_truth_retained: boolean;
  /** ALWAYS false — a single bundle's byte size is not bounded (sharding deferred). */
  bundle_byte_size_bounded: false;
  /** where the byte-size bound is deferred to. */
  bundle_byte_size_bound_deferred_to: "sharding";
};

/** The two IN-SCOPE bounds of this layer (file-count + unreferenced-old-truth). `bundle_byte_size`
 *  is an explicit NON-goal and is NOT part of this verdict — so the exit code never fails on the
 *  documented deferral, only on the bounds the layer claims to hold. */
export function isV2Bounded(b: BoundedStatus): boolean {
  return b.file_count_bounded && b.unreferenced_old_truth_bounded;
}

/** Derive the bounded status from a set of compaction + retention plans (READ-ONLY).
 *  Used for the dry-run preview (current state) AND, on a FRESH re-plan after the write
 *  apply, the true post-maintenance state — so a partially-bounded archive is never
 *  reported as fully bounded.
 *
 *  - `file_count_bounded`: every kind's compaction plan is empty (nothing to fold,
 *    supersede, delete, retire, or — fail-closed — skip). A `would_skip` (bundle_stale /
 *    invalid member / unsafe path) means a loose record that CANNOT be folded, so the
 *    file count is NOT at its floor.
 *  - `unreferenced_old_truth_bounded`: no kind has a `would_drop` record. A non-empty
 *    `would_drop` after the apply is a real follow-up (a source:both survivor that the
 *    loose layer drops next run, a deferred mixed pair, etc.).
 *  - a PENDING delete-intent journal forces both to false: a half-recovered store is
 *    not bounded (a reader hides the mid-deletion records, but the truth is unsettled). */
export function deriveBoundedStatus(
  compactPlans: readonly CompactArchivePlan[],
  retentionPlans: readonly RetentionPlan[],
  pendingDeleteIntent: boolean,
): BoundedStatus {
  const sum = (pick: (p: CompactArchivePlan) => number): number => compactPlans.reduce((n, p) => n + pick(p), 0);
  const fileReasons: FileCountReasons = {
    would_bundle: sum((p) => p.would_bundle.length),
    would_delete: sum((p) => p.would_delete.length),
    would_supersede: sum((p) => p.would_supersede.length),
    would_retire_bundles: sum((p) => p.would_retire_bundles.length),
    would_skip: sum((p) => p.would_skip.length),
    pending_delete_intent: pendingDeleteIntent,
  };
  const unrefReasons: UnreferencedReasons = {
    would_drop: retentionPlans.reduce((n, p) => n + p.would_drop.length, 0),
    pending_delete_intent: pendingDeleteIntent,
  };
  const fileCountBounded =
    !fileReasons.pending_delete_intent &&
    fileReasons.would_bundle === 0 &&
    fileReasons.would_delete === 0 &&
    fileReasons.would_supersede === 0 &&
    fileReasons.would_retire_bundles === 0 &&
    fileReasons.would_skip === 0;
  const unreferencedBounded = !unrefReasons.pending_delete_intent && unrefReasons.would_drop === 0;
  return {
    file_count_bounded: fileCountBounded,
    file_count_unbounded_reasons: fileReasons,
    unreferenced_old_truth_bounded: unreferencedBounded,
    unreferenced_old_truth_unbounded_reasons: unrefReasons,
    referenced_truth_retained: true,
    bundle_byte_size_bounded: false,
    bundle_byte_size_bound_deferred_to: "sharding",
  };
}

// --- shared accounting -------------------------------------------------------

/** The skip reasons that mean "droppable truth was deferred to a future run/layer"
 *  (a mixed pair, or a loose pair that could not be atomically removed) — counted as
 *  `mixed_source_deferred` so a deferred pair is never read as bounded success. */
const DEFERRED_SKIP_REASONS = new Set(["needs_bundle_member_removal", "requires_atomic_pair_removal"]);

/** Roll up the destructive retention results into operator-grade summary counts.
 *  `recovered` is set IDENTICALLY on every kind's result (a pair touches two kinds),
 *  so it is deduped by (id, intent_kind) to avoid double-counting; the other buckets
 *  are summed across kinds (a pair's two members are two physical removals). */
function summarizeRetention(results: readonly RetentionDeleteOutcome[]): {
  deleted: number;
  bundle_member_removed: number;
  recovered_loose_pairs: number;
  recovered_bundle_pairs: number;
  skipped: number;
  mixed_source_deferred: number;
} {
  let deleted = 0;
  let bundleMemberRemoved = 0;
  let skipped = 0;
  let mixedSourceDeferred = 0;
  const recoveredLoose = new Set<string>();
  const recoveredBundle = new Set<string>();
  for (const r of results) {
    deleted += r.deleted.length;
    bundleMemberRemoved += r.bundle_member_removed.length;
    skipped += r.skipped.length;
    mixedSourceDeferred += r.skipped.filter((s) => DEFERRED_SKIP_REASONS.has(s.reason)).length;
    for (const rec of r.recovered) {
      (rec.intent_kind === "loose_pair" ? recoveredLoose : recoveredBundle).add(rec.id);
    }
  }
  return {
    deleted,
    bundle_member_removed: bundleMemberRemoved,
    recovered_loose_pairs: recoveredLoose.size,
    recovered_bundle_pairs: recoveredBundle.size,
    skipped,
    mixed_source_deferred: mixedSourceDeferred,
  };
}

/** One compaction pass rolled up: the file-count reduction it produced. */
type CompactPassResult = {
  outcomes: CompactArchiveOutcome[];
  files_removed: number;
  bundles_written: number;
  skipped: ArchiveDeleteSkip[];
};

function summarizeCompactPass(outcomes: CompactArchiveOutcome[]): CompactPassResult {
  let filesRemoved = 0;
  let bundlesWritten = 0;
  const skipped: ArchiveDeleteSkip[] = [];
  for (const o of outcomes) {
    filesRemoved += o.delete.deleted.length + o.retired_bundles.length;
    if (!o.bundle.kind.startsWith("noop")) bundlesWritten += 1;
    skipped.push(...o.delete.skipped);
  }
  return { outcomes, files_removed: filesRemoved, bundles_written: bundlesWritten, skipped };
}

/** Run `compactArchive` for every kind, in a stable order. Throws (fail-closed) on the
 *  first kind that faults — mirroring the existing `state compact-archive` driver. */
async function compactAllKinds(cwd: string): Promise<CompactArchiveOutcome[]> {
  const outcomes: CompactArchiveOutcome[] = [];
  for (const kind of KINDS) outcomes.push(await compactArchive(cwd, kind));
  return outcomes;
}

async function planAllKinds(cwd: string): Promise<CompactArchivePlan[]> {
  const plans: CompactArchivePlan[] = [];
  for (const kind of KINDS) plans.push(await planCompactArchive(cwd, kind));
  return plans;
}

// --- a tagged error so the CLI can render a partial-mutation failure honestly --

/** A maintenance step faulted. Carries the underlying primitive error (so the CLI maps
 *  it to the right public error code), which step failed, which steps already completed,
 *  and whether any mutation was applied — so a failure after partial mutation is reported
 *  honestly (never a silent partial). */
export class ArchiveMaintenanceError extends Error {
  readonly code = "ARCHIVE_MAINTENANCE_FAILED" as const;
  constructor(
    readonly step: string,
    readonly cause_error: Error,
    readonly completed_steps: string[],
    readonly partial_applied: boolean,
  ) {
    super(cause_error.message);
    this.name = "ArchiveMaintenanceError";
  }
}

// --- the two checks (read-only, run in both modes) ---------------------------

export type CheckResult = {
  validate: { ok: boolean; errors: number; warnings: number };
  plan_lint: { ok: boolean; errors: number; warnings: number; advisories: number };
};

/** Run the read-only post-checks an operator would otherwise run by hand: `validate`
 *  (non-strict — ok = no errors) and `plan lint --include-quality --strict` (ok = no
 *  errors/warnings). Neither mutates a generated file, so this is safe in dry-run too. */
async function runChecks(cwd: string): Promise<CheckResult> {
  const validate = await runValidate({ cwd });
  const lint = await runPlanLint({ cwd, strict: true, includeQuality: true });
  return {
    validate: {
      ok: validate.ok,
      errors: validate.issues.filter((i) => i.severity === "error").length,
      warnings: validate.issues.filter((i) => i.severity === "warning").length,
    },
    plan_lint: { ok: lint.ok, errors: lint.errors, warnings: lint.warnings, advisories: lint.advisories },
  };
}

// --- dry-run -----------------------------------------------------------------

export type ArchiveMaintenanceDryRun = {
  mode: "dry_run";
  summary: {
    archive_files: number;
    loose_records: number;
    bundles: number;
    /** loose records compaction would fold into a bundle. */
    planned_loose_folded: number;
    /** loose records a verified bundle already holds → compaction would delete. */
    planned_loose_deleted: number;
    /** unreferenced old records retention would drop. */
    planned_drop: number;
    /** records compaction CANNOT fold (bundle_stale / invalid member / unsafe). */
    planned_compact_skipped: number;
  };
  steps: {
    journal: { name: "journal"; pending_before: boolean };
    compact: { name: "compact"; plans: CompactArchivePlan[] };
    retention: { name: "retention"; plans: RetentionPlan[] };
    checks: { name: "checks" } & CheckResult;
  };
  bounded_status: BoundedStatus;
};

/** Dry-run: READ-ONLY preview of what `--write` would do, plus the CURRENT bounded
 *  status (derived from the current plans). Mutates nothing — no bundle write, no
 *  delete, no journal recovery/clear. */
export async function planArchiveMaintenance(
  cwd: string,
  opts: { keepLatest?: number } = {},
): Promise<ArchiveMaintenanceDryRun> {
  const counts = await countArchiveFiles(cwd);
  const pendingBefore = (await readDeleteIntent(cwd)).kind !== "absent";
  const compactPlans = await planAllKinds(cwd);
  const retentionPlans = await planArchiveRetention(cwd, opts);
  const checks = await runChecks(cwd);

  const planned_loose_folded = compactPlans.reduce((n, p) => n + p.would_bundle.length, 0);
  const planned_loose_deleted = compactPlans.reduce((n, p) => n + p.would_delete.length, 0);
  const planned_compact_skipped = compactPlans.reduce((n, p) => n + p.would_skip.length, 0);
  const planned_drop = retentionPlans.reduce((n, p) => n + p.would_drop.length, 0);

  return {
    mode: "dry_run",
    summary: {
      archive_files: counts.total,
      loose_records: counts.loose_records,
      bundles: counts.bundles,
      planned_loose_folded,
      planned_loose_deleted,
      planned_drop,
      planned_compact_skipped,
    },
    steps: {
      journal: { name: "journal", pending_before: pendingBefore },
      compact: { name: "compact", plans: compactPlans },
      retention: { name: "retention", plans: retentionPlans },
      checks: { name: "checks", ...checks },
    },
    bounded_status: deriveBoundedStatus(compactPlans, retentionPlans, pendingBefore),
  };
}

// --- write -------------------------------------------------------------------

export type ArchiveMaintenanceWrite = {
  mode: "write";
  summary: {
    archive_files_before: number;
    archive_files_after: number;
    loose_records_before: number;
    loose_records_after: number;
    bundles_before: number;
    bundles_after: number;
    deleted: number;
    bundle_member_removed: number;
    recovered_loose_pairs: number;
    recovered_bundle_pairs: number;
    skipped: number;
    mixed_source_deferred: number;
    source_both_follow_up: number;
  };
  steps: {
    journal: { name: "journal"; ok: true; pending_before: boolean; recovered: RetentionDeleteOutcome["recovered"] };
    compact_before_retention: { name: "compact_before_retention"; ok: true; files_removed: number; bundles_written: number; skipped: ArchiveDeleteSkip[] };
    retention: { name: "retention"; ok: true; results: RetentionDeleteOutcome[] };
    compact_after_retention: { name: "compact_after_retention"; ok: true; ran: boolean; reason: string | null; files_removed: number; bundles_written: number; skipped: ArchiveDeleteSkip[] };
    bounded_status: { name: "bounded_status"; ok: boolean };
    checks: { name: "checks"; ok: boolean } & CheckResult;
  };
  bounded_status: BoundedStatus;
  /** overall verdict (drives the CLI exit code): the maintenance mutations succeeded, the
   *  read-only post-checks pass, AND the archive is bounded in this layer's sense (file-count +
   *  unreferenced old truth). The byte-size NON-goal never makes this false. */
  ok: boolean;
};

/** `--write`: orchestrate the existing primitives under the caller's outer write lock.
 *
 *  1. read the pending journal status (before).
 *  2. compact every kind → folds loose into bundles, deletes bundled loose. (Runs FIRST,
 *     so a loose member of a mixed-source pair is folded into a bundle and the pair
 *     becomes a uniform bundle pair retention can remove atomically this run.)
 *  3. retention apply → RECOVERS any crashed prior pair-delete FIRST (surfaced as
 *     `recovered`, split loose/bundle), then drops unreferenced old truth. We rely on
 *     `applyArchiveRetention`'s INTERNAL recovery (not an external pre-pass) precisely so
 *     a recovered source:both survivor is deferred to the next run rather than landing in
 *     two buckets (recovered AND deleted) this run — preserving one-bucket-per-id-per-run.
 *  4. compact again IFF foldable loose remains (e.g. a source:both survivor materialised by
 *     a bundle_member_removed) — keeps the file count at its floor while the loose layer
 *     drops the survivor on the next run.
 *  5. re-plan the real store → the TRUE post-maintenance bounded status.
 *  6. run the read-only checks (validate + plan lint).
 *
 *  Throws {@link ArchiveMaintenanceError} (wrapping the primitive's fault) if a mutation
 *  step faults — carrying which step failed, which completed, and partial_applied. Run
 *  under the repo write lock (the CLI's job). */
export async function runArchiveMaintenance(
  cwd: string,
  opts: { keepLatest?: number } = {},
  hooks: RetentionApplyHooks = {},
): Promise<ArchiveMaintenanceWrite> {
  const before = await countArchiveFiles(cwd);
  const pendingBefore = (await readDeleteIntent(cwd)).kind !== "absent";
  const completed: string[] = [];

  // 1. RECOVER any crashed prior pair-delete FIRST — BEFORE compaction. This is load-bearing:
  //    compaction is NOT recovery-first (its readers hide pending-journal ids from FOLDING, but
  //    its consolidation would RETIRE a pending bundle-pair's reduced survivor bundle as
  //    "superseded", after which recovery can never complete — a permanent wedge). So
  //    `archive-maintain` heals the journal here, then passes the result to
  //    `applyArchiveRetention` as `preRecovered` so it does NOT double-recover but STILL defers
  //    each recovered bundle-pair's loose survivor (one-bucket-per-run; the survivor drops next run).
  let recovery: RecoveryOutcome;
  try {
    recovery = await recoverPendingDeletes(cwd);
  } catch (err) {
    throw new ArchiveMaintenanceError("journal_recovery", err as Error, completed, false);
  }
  completed.push("journal_recovery");

  // 2. compact-before-retention (now SAFE — no journal is pending after step 1).
  let compactBefore: CompactPassResult;
  try {
    compactBefore = summarizeCompactPass(await compactAllKinds(cwd));
  } catch (err) {
    // Compaction unlinks loose files / writes+retires bundles, so a mid-run fault may have
    // already applied a kind — report partial_applied conservatively true.
    throw new ArchiveMaintenanceError("compact_before_retention", err as Error, completed, true);
  }
  completed.push("compact_before_retention");

  // 3. retention — recovery already ran (passed as `preRecovered`), so it plans + drops with the
  //    recovered-bundle-pair exclusion in place; it does not recover a second time.
  let retentionResults: RetentionDeleteOutcome[];
  try {
    retentionResults = await applyArchiveRetention(cwd, { ...opts, preRecovered: recovery }, hooks);
  } catch (err) {
    throw new ArchiveMaintenanceError("retention", err as Error, completed, true);
  }
  completed.push("retention");
  const retSummary = summarizeRetention(retentionResults);
  // `recovered` is identical on every kind's result — take it from the first (or []).
  const recovered = retentionResults[0]?.recovered ?? [];

  // 4. compact-after-retention IFF a fresh plan shows foldable loose remains (a source:both
  //    survivor materialised by a bundle_member_removed, or recovery-left loose). Driven by
  //    the real store (not a guess), so it only runs when there is real folding to do.
  const afterRetentionPlans = await planAllKinds(cwd);
  const foldableRemains = afterRetentionPlans.some(
    (p) => p.would_bundle.length > 0 || p.would_supersede.length > 0 || p.would_delete.length > 0,
  );
  let compactAfter: CompactPassResult = { outcomes: [], files_removed: 0, bundles_written: 0, skipped: [] };
  let compactAfterRan = false;
  let compactAfterReason: string | null = null;
  if (foldableRemains) {
    compactAfterRan = true;
    compactAfterReason = retSummary.bundle_member_removed > 0 ? "source_both_follow_up" : "materialized_loose";
    try {
      compactAfter = summarizeCompactPass(await compactAllKinds(cwd));
    } catch (err) {
      throw new ArchiveMaintenanceError("compact_after_retention", err as Error, completed, true);
    }
    completed.push("compact_after_retention");
  }

  // 5. bounded status from a FRESH re-plan of the real post-maintenance store, then 6. the
  //    read-only checks. These run AFTER the destructive steps, so a fault here is a fault
  //    AFTER partial mutation — wrap it in the SAME honest envelope (which steps completed,
  //    partial_applied) rather than letting an uncaught error escape the contract.
  let boundedStatus: BoundedStatus;
  let checks: CheckResult;
  let after: ArchiveFileCounts;
  try {
    const finalCompactPlans = compactAfterRan ? await planAllKinds(cwd) : afterRetentionPlans;
    const finalRetentionPlans = await planArchiveRetention(cwd, opts);
    const pendingAfter = (await readDeleteIntent(cwd)).kind !== "absent";
    boundedStatus = deriveBoundedStatus(finalCompactPlans, finalRetentionPlans, pendingAfter);
  } catch (err) {
    throw new ArchiveMaintenanceError("bounded_status", err as Error, completed, true);
  }
  completed.push("bounded_status");
  try {
    checks = await runChecks(cwd);
    after = await countArchiveFiles(cwd);
  } catch (err) {
    throw new ArchiveMaintenanceError("checks", err as Error, completed, true);
  }

  // Overall verdict (drives the CLI exit code). It is NOT just "did the checks pass" — the
  // command's JOB is to make the archive bounded in this layer's sense, so it must ALSO be
  // `isV2Bounded` (file-count + unreferenced-old-truth). The byte-size NON-goal never fails it.
  const checksPass = checks.validate.ok && checks.plan_lint.ok;
  const ok = checksPass && isV2Bounded(boundedStatus);

  return {
    mode: "write",
    summary: {
      archive_files_before: before.total,
      archive_files_after: after.total,
      loose_records_before: before.loose_records,
      loose_records_after: after.loose_records,
      bundles_before: before.bundles,
      bundles_after: after.bundles,
      deleted: retSummary.deleted,
      bundle_member_removed: retSummary.bundle_member_removed,
      recovered_loose_pairs: retSummary.recovered_loose_pairs,
      recovered_bundle_pairs: retSummary.recovered_bundle_pairs,
      skipped: retSummary.skipped,
      mixed_source_deferred: retSummary.mixed_source_deferred,
      source_both_follow_up: retSummary.bundle_member_removed,
    },
    steps: {
      journal: { name: "journal", ok: true, pending_before: pendingBefore, recovered },
      compact_before_retention: {
        name: "compact_before_retention",
        ok: true,
        files_removed: compactBefore.files_removed,
        bundles_written: compactBefore.bundles_written,
        skipped: compactBefore.skipped,
      },
      retention: { name: "retention", ok: true, results: retentionResults },
      compact_after_retention: {
        name: "compact_after_retention",
        ok: true,
        ran: compactAfterRan,
        reason: compactAfterReason,
        files_removed: compactAfter.files_removed,
        bundles_written: compactAfter.bundles_written,
        skipped: compactAfter.skipped,
      },
      bounded_status: { name: "bounded_status", ok: isV2Bounded(boundedStatus) },
      checks: { name: "checks", ok: checksPass, ...checks },
    },
    bounded_status: boundedStatus,
    ok,
  };
}
