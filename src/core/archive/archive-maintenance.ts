import { listOwnedDirents } from "../project-fs/operations.ts";
import type { OwnedListPath } from "../project-fs/branded-paths-internal.ts";
import { ArchiveBundleKind } from "../schemas/archive-bundle.ts";
import {
  archiveBundlesRelDir,
  archiveDecisionsRelDir,
  archiveEventPacksRelDir,
  archivePhasesRelDir,
  resolveArchiveOwnedListPath,
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
import {
  readDeleteIntent,
  recoverPendingDeletes,
  type DeleteIntentRead,
  type RecoveryOutcome,
} from "./delete-intent-journal.ts";
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

async function countJsonFiles(dir: OwnedListPath): Promise<number> {
  try {
    return (await listOwnedDirents(dir)).filter(
      e => e.isFile() && e.name.endsWith(".json"),
    ).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/** Operator-grade journal status — distinguishes a clean store (`absent`) from an
 *  un-recovered prior crash (`present`, with the pending intent kinds + count) from a
 *  CORRUPT journal (`corrupt`) that `--write` would fail to recover. So the dry-run can warn
 *  "a `--write` here will fail recovery", not merely "pending: true". */
export type JournalStatus = {
  status: "absent" | "present" | "corrupt";
  /** true when a journal exists (present OR corrupt) — recovery is owed before any compaction. */
  pending_before: boolean;
  /** the distinct pending intent kinds (e.g. `["bundle_pair","loose_pair"]`); empty if absent/corrupt. */
  intent_kinds: ("loose_pair" | "bundle_pair")[];
  /** number of pending intents; 0 if absent/corrupt. */
  count: number;
};

export function describeJournal(read: DeleteIntentRead): JournalStatus {
  if (read.kind === "absent")
    return {
      status: "absent",
      pending_before: false,
      intent_kinds: [],
      count: 0,
    };
  if (read.kind === "corrupt")
    return {
      status: "corrupt",
      pending_before: true,
      intent_kinds: [],
      count: 0,
    };
  const kinds = [
    ...new Set(read.intent.intents.map(i => i.intent_kind)),
  ].sort() as ("loose_pair" | "bundle_pair")[];
  return {
    status: "present",
    pending_before: true,
    intent_kinds: kinds,
    count: read.intent.intents.length,
  };
}

/** Count the physical archive files on disk (loose records + bundles). Read-only. */
export async function countArchiveFiles(
  cwd: string,
): Promise<ArchiveFileCounts> {
  const loose =
    (await countJsonFiles(
      await resolveArchiveOwnedListPath(cwd, archivePhasesRelDir()),
    )) +
    (await countJsonFiles(
      await resolveArchiveOwnedListPath(cwd, archiveEventPacksRelDir()),
    )) +
    (await countJsonFiles(
      await resolveArchiveOwnedListPath(cwd, archiveDecisionsRelDir()),
    ));
  const bundles = await countJsonFiles(
    await resolveArchiveOwnedListPath(cwd, archiveBundlesRelDir()),
  );
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
  const sum = (pick: (p: CompactArchivePlan) => number): number =>
    compactPlans.reduce((n, p) => n + pick(p), 0);
  const fileReasons: FileCountReasons = {
    would_bundle: sum(p => p.would_bundle.length),
    would_delete: sum(p => p.would_delete.length),
    would_supersede: sum(p => p.would_supersede.length),
    would_retire_bundles: sum(p => p.would_retire_bundles.length),
    would_skip: sum(p => p.would_skip.length),
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
  const unreferencedBounded =
    !unrefReasons.pending_delete_intent && unrefReasons.would_drop === 0;
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

/** Roll up the destructive retention results into operator-grade summary counts.
 *  `recovered` is set IDENTICALLY on every kind's result (a pair touches two kinds),
 *  so it is deduped by (id, intent_kind) to avoid double-counting; the other buckets
 *  are summed across kinds (a pair's two members are two physical removals).
 *
 *  Deferrals are reported in PRECISE buckets, not lumped: `bundle_member_deferred`
 *  (`needs_bundle_member_removal` — NOT always a mixed pair: it also covers an
 *  independent bundle record / a not-yet-pairable bundle phase) and `atomic_pair_deferred`
 *  (`requires_atomic_pair_removal` — a loose pair held back by an unsupported-platform fsync,
 *  a partial store view, or a missing digest — NOT fixed by `compact-archive`). `mixed_source_deferred`
 *  is kept as their SUM for back-compat, but the two precise counts are what an operator acts on. */
function summarizeRetention(results: readonly RetentionDeleteOutcome[]): {
  deleted: number;
  bundle_member_removed: number;
  recovered_loose_pairs: number;
  recovered_bundle_pairs: number;
  skipped: number;
  bundle_member_deferred: number;
  atomic_pair_deferred: number;
  mixed_source_deferred: number;
} {
  let deleted = 0;
  let bundleMemberRemoved = 0;
  let skipped = 0;
  let bundleMemberDeferred = 0;
  let atomicPairDeferred = 0;
  const recoveredLoose = new Set<string>();
  const recoveredBundle = new Set<string>();
  for (const r of results) {
    deleted += r.deleted.length;
    bundleMemberRemoved += r.bundle_member_removed.length;
    skipped += r.skipped.length;
    bundleMemberDeferred += r.skipped.filter(
      s => s.reason === "needs_bundle_member_removal",
    ).length;
    atomicPairDeferred += r.skipped.filter(
      s => s.reason === "requires_atomic_pair_removal",
    ).length;
    for (const rec of r.recovered) {
      (rec.intent_kind === "loose_pair" ? recoveredLoose : recoveredBundle).add(
        rec.id,
      );
    }
  }
  return {
    deleted,
    bundle_member_removed: bundleMemberRemoved,
    recovered_loose_pairs: recoveredLoose.size,
    recovered_bundle_pairs: recoveredBundle.size,
    skipped,
    bundle_member_deferred: bundleMemberDeferred,
    atomic_pair_deferred: atomicPairDeferred,
    mixed_source_deferred: bundleMemberDeferred + atomicPairDeferred,
  };
}

/** One compaction pass rolled up: the file-count reduction it produced. */
type CompactPassResult = {
  outcomes: CompactArchiveOutcome[];
  files_removed: number;
  bundles_written: number;
  skipped: ArchiveDeleteSkip[];
};

function summarizeCompactPass(
  outcomes: CompactArchiveOutcome[],
): CompactPassResult {
  let filesRemoved = 0;
  let bundlesWritten = 0;
  const skipped: ArchiveDeleteSkip[] = [];
  for (const o of outcomes) {
    filesRemoved += o.delete.deleted.length + o.retired_bundles.length;
    if (!o.bundle.kind.startsWith("noop")) bundlesWritten += 1;
    skipped.push(...o.delete.skipped);
  }
  return {
    outcomes,
    files_removed: filesRemoved,
    bundles_written: bundlesWritten,
    skipped,
  };
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
 *  whether any mutation was applied, AND any delete-intent journal recovery the run had
 *  already completed before the fault — so a failure after partial mutation is reported
 *  honestly (never a silent partial; the recovery output is reported even on the error path). */
export class ArchiveMaintenanceError extends Error {
  readonly code = "ARCHIVE_MAINTENANCE_FAILED" as const;
  constructor(
    readonly step: string,
    readonly cause_error: Error,
    readonly completed_steps: string[],
    readonly partial_applied: boolean,
    readonly recovered: RetentionDeleteOutcome["recovered"] = [],
  ) {
    super(cause_error.message);
    this.name = "ArchiveMaintenanceError";
  }
}

// --- the two checks (read-only, run in both modes) ---------------------------

export type CheckResult = {
  validate: { ok: boolean; errors: number; warnings: number };
  plan_lint: {
    ok: boolean;
    errors: number;
    warnings: number;
    advisories: number;
  };
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
      errors: validate.issues.filter(i => i.severity === "error").length,
      warnings: validate.issues.filter(i => i.severity === "warning").length,
    },
    plan_lint: {
      ok: lint.ok,
      errors: lint.errors,
      warnings: lint.warnings,
      advisories: lint.advisories,
    },
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
    /** `plans_are_pre_recovery` is true when a journal is pending: `--write` recovers FIRST, which
     *  changes the store, so the `compact` / `retention` plans below are CURRENT pre-recovery
     *  diagnostics, NOT the exact post-recovery plan. Re-run the dry-run after recovery for exact plans. */
    journal: {
      name: "journal";
      plans_are_pre_recovery: boolean;
    } & JournalStatus;
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
  const journal = describeJournal(await readDeleteIntent(cwd));
  const compactPlans = await planAllKinds(cwd);
  const retentionPlans = await planArchiveRetention(cwd, opts);
  const checks = await runChecks(cwd);

  const planned_loose_folded = compactPlans.reduce(
    (n, p) => n + p.would_bundle.length,
    0,
  );
  const planned_loose_deleted = compactPlans.reduce(
    (n, p) => n + p.would_delete.length,
    0,
  );
  const planned_compact_skipped = compactPlans.reduce(
    (n, p) => n + p.would_skip.length,
    0,
  );
  const planned_drop = retentionPlans.reduce(
    (n, p) => n + p.would_drop.length,
    0,
  );

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
      journal: {
        name: "journal",
        ...journal,
        plans_are_pre_recovery: journal.pending_before,
      },
      compact: { name: "compact", plans: compactPlans },
      retention: { name: "retention", plans: retentionPlans },
      checks: { name: "checks", ...checks },
    },
    bounded_status: deriveBoundedStatus(
      compactPlans,
      retentionPlans,
      journal.pending_before,
    ),
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
    /** TOTAL fail-closed skips = `compact_skipped` + `retention_skipped`. */
    skipped: number;
    /** compaction skips (bundle_stale / invalid member / unsafe path) — keep file_count not bounded. */
    compact_skipped: number;
    /** retention skips (needs_bundle_member_removal / requires_atomic_pair_removal / authority / unlink). */
    retention_skipped: number;
    /** records retention deferred to a future run/layer: `bundle_member_deferred` + `atomic_pair_deferred`.
     *  NOT all are "pairs" — kept under this name for back-compat; act on the two precise counts. */
    mixed_source_deferred: number;
    /** `needs_bundle_member_removal` deferrals (a bundle/both record the bundle-member layer holds back). */
    bundle_member_deferred: number;
    /** `requires_atomic_pair_removal` deferrals (a loose pair held back — unsupported fsync / partial store / missing digest). */
    atomic_pair_deferred: number;
    source_both_follow_up: number;
  };
  /** machine-readable verdict mirrored INTO `data` (the envelope `ok` is always `true` on the
   *  success path, so a consumer reading only stdout JSON needs this to see the exit verdict). */
  verdict: { exit_code: 0 | 1; v2_bounded: boolean; checks_ok: boolean };
  steps: {
    journal: {
      name: "journal";
      ok: true;
      recovered: RetentionDeleteOutcome["recovered"];
    } & JournalStatus;
    compact_before_retention: {
      name: "compact_before_retention";
      ok: true;
      files_removed: number;
      bundles_written: number;
      skipped: ArchiveDeleteSkip[];
    };
    retention: {
      name: "retention";
      ok: true;
      results: RetentionDeleteOutcome[];
    };
    compact_after_retention: {
      name: "compact_after_retention";
      ok: true;
      ran: boolean;
      reason: string | null;
      files_removed: number;
      bundles_written: number;
      skipped: ArchiveDeleteSkip[];
    };
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
 *  1. RECOVER any pending delete-intent journal FIRST — before any compaction. This is
 *     load-bearing: compaction is not recovery-first, and its consolidation would RETIRE a
 *     crashed bundle-pair's reduced survivor bundle as "superseded", wedging recovery. The
 *     result is passed to retention as `preRecovered` (no double-recovery) and a recovered
 *     bundle-pair's surviving copy is excluded from THIS run's drop (one bucket per id per run).
 *  2. compact every kind → folds loose into bundles, deletes bundled loose. (Runs after
 *     recovery, so a loose member of a mixed-source pair is folded into a bundle and the pair
 *     becomes a uniform bundle pair retention can remove atomically this run.)
 *  3. retention apply (with `preRecovered`) → drops unreferenced old truth; does NOT recover again.
 *  4. compact again IFF foldable loose remains — keeps the file count at its floor while the
 *     deferred record (a recovered bundle-pair survivor, or a source:both follow-up) is dropped
 *     on a subsequent run.
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
  const journalBefore = describeJournal(await readDeleteIntent(cwd));
  const completed: string[] = [];

  // 1. RECOVER any crashed prior pair-delete FIRST — BEFORE compaction. This is load-bearing:
  //    compaction is NOT recovery-first (its readers hide pending-journal ids from FOLDING, but
  //    its consolidation would RETIRE a pending bundle-pair's reduced survivor bundle as
  //    "superseded", after which recovery can never complete — a permanent wedge). So
  //    `archive-maintain` heals the journal here, then passes the result to
  //    `applyArchiveRetention` as `preRecovered` so it does NOT double-recover but STILL defers
  //    each recovered bundle-pair's id (one-bucket-per-run). Any surviving copy — loose, OR
  //    re-compacted into a bundle by the maintenance compaction pass — is dropped on a subsequent
  //    run; it is NOT necessarily still loose by the time this run returns.
  let recovery: RecoveryOutcome;
  try {
    recovery = await recoverPendingDeletes(cwd);
  } catch (err) {
    // partial_applied only when a PRESENT (schema-valid) journal was being completed — recovery can
    // do partial destructive work (an unlink / a bundle retire) before a later fsync fails. A CORRUPT
    // journal throws straight from `readDeleteIntent` BEFORE any mutation (and an absent one is a
    // no-op), so partial_applied is honestly false there.
    throw new ArchiveMaintenanceError(
      "journal_recovery",
      err as Error,
      completed,
      journalBefore.status === "present",
    );
  }
  completed.push("journal_recovery");
  // The recovery-completed ids, tagged by intent_kind — reported on EVERY path (success AND any
  // later step's error envelope), so "what did the prior crashed delete complete?" is never lost.
  const recovered: RetentionDeleteOutcome["recovered"] = [
    ...recovery.loose_pairs.map(id => ({
      id,
      intent_kind: "loose_pair" as const,
    })),
    ...recovery.bundle_pairs.map(id => ({
      id,
      intent_kind: "bundle_pair" as const,
    })),
  ];

  // 2. compact-before-retention (now SAFE — no journal is pending after step 1).
  let compactBefore: CompactPassResult;
  try {
    compactBefore = summarizeCompactPass(await compactAllKinds(cwd));
  } catch (err) {
    // Compaction unlinks loose files / writes+retires bundles, so a mid-run fault may have
    // already applied a kind — report partial_applied conservatively true.
    throw new ArchiveMaintenanceError(
      "compact_before_retention",
      err as Error,
      completed,
      true,
      recovered,
    );
  }
  completed.push("compact_before_retention");

  // 3. retention — recovery already ran (passed as `preRecovered`), so it plans + drops with the
  //    recovered-bundle-pair exclusion in place; it does not recover a second time.
  let retentionResults: RetentionDeleteOutcome[];
  try {
    retentionResults = await applyArchiveRetention(
      cwd,
      { ...opts, preRecovered: recovery },
      hooks,
    );
  } catch (err) {
    throw new ArchiveMaintenanceError(
      "retention",
      err as Error,
      completed,
      true,
      recovered,
    );
  }
  completed.push("retention");
  const retSummary = summarizeRetention(retentionResults);

  // 4. compact-after-retention IFF a fresh plan shows foldable loose remains (a source:both
  //    survivor materialised by a bundle_member_removed, or recovery-left loose). Driven by
  //    the real store (not a guess), so it only runs when there is real folding to do.
  const afterRetentionPlans = await planAllKinds(cwd);
  const foldableRemains = afterRetentionPlans.some(
    p =>
      p.would_bundle.length > 0 ||
      p.would_supersede.length > 0 ||
      p.would_delete.length > 0,
  );
  let compactAfter: CompactPassResult = {
    outcomes: [],
    files_removed: 0,
    bundles_written: 0,
    skipped: [],
  };
  let compactAfterRan = false;
  let compactAfterReason: string | null = null;
  if (foldableRemains) {
    compactAfterRan = true;
    compactAfterReason =
      retSummary.bundle_member_removed > 0
        ? "source_both_follow_up"
        : "materialized_loose";
    try {
      compactAfter = summarizeCompactPass(await compactAllKinds(cwd));
    } catch (err) {
      throw new ArchiveMaintenanceError(
        "compact_after_retention",
        err as Error,
        completed,
        true,
        recovered,
      );
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
    const finalCompactPlans = compactAfterRan
      ? await planAllKinds(cwd)
      : afterRetentionPlans;
    const finalRetentionPlans = await planArchiveRetention(cwd, opts);
    const pendingAfter = (await readDeleteIntent(cwd)).kind !== "absent";
    boundedStatus = deriveBoundedStatus(
      finalCompactPlans,
      finalRetentionPlans,
      pendingAfter,
    );
  } catch (err) {
    throw new ArchiveMaintenanceError(
      "bounded_status",
      err as Error,
      completed,
      true,
      recovered,
    );
  }
  completed.push("bounded_status");
  try {
    checks = await runChecks(cwd);
    after = await countArchiveFiles(cwd);
  } catch (err) {
    throw new ArchiveMaintenanceError(
      "checks",
      err as Error,
      completed,
      true,
      recovered,
    );
  }

  // Overall verdict (drives the CLI exit code). It is NOT just "did the checks pass" — the
  // command's JOB is to make the archive bounded in this layer's sense, so it must ALSO be
  // `isV2Bounded` (file-count + unreferenced-old-truth). The byte-size NON-goal never fails it.
  const checksPass = checks.validate.ok && checks.plan_lint.ok;
  const ok = checksPass && isV2Bounded(boundedStatus);

  // `skipped` is the TOTAL fail-closed skip count — compaction skips (bundle_stale / invalid
  // member / unsafe path, which keep `file_count_bounded` false) AND retention skips — so a
  // reader inspecting `summary.skipped === 0` is never misled into "no skipped work" while a
  // compaction skip lurks. The split is reported alongside (`compact_skipped` / `retention_skipped`).
  const compactSkipped =
    compactBefore.skipped.length + compactAfter.skipped.length;

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
      skipped: compactSkipped + retSummary.skipped,
      compact_skipped: compactSkipped,
      retention_skipped: retSummary.skipped,
      mixed_source_deferred: retSummary.mixed_source_deferred,
      bundle_member_deferred: retSummary.bundle_member_deferred,
      atomic_pair_deferred: retSummary.atomic_pair_deferred,
      source_both_follow_up: retSummary.bundle_member_removed,
    },
    verdict: {
      exit_code: ok ? 0 : 1,
      v2_bounded: isV2Bounded(boundedStatus),
      checks_ok: checksPass,
    },
    steps: {
      journal: { name: "journal", ok: true, ...journalBefore, recovered },
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
      bounded_status: {
        name: "bounded_status",
        ok: isV2Bounded(boundedStatus),
      },
      checks: { name: "checks", ok: checksPass, ...checks },
    },
    bounded_status: boundedStatus,
    ok,
  };
}
