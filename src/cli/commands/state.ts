import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { withWriteLock, emitOk, emitError } from "../util.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { STATE_SPECS, STATE_SPEC_ORDER } from "../spec/state.ts";
import { toParseOptions } from "../spec/render.ts";
import { runStateCompact, type StateCompactResult } from "../../commands/state-compact.ts";
import { type EventPackBlock } from "../../core/archive/event-pack.ts";
import type { CleanupOutcome } from "../../core/archive/event-pack-cleanup.ts";
import { eventPackPath } from "../../core/archive/paths.ts";
import { ArchiveBundleKind } from "../../core/schemas/archive-bundle.ts";
import {
  compactArchive,
  planCompactArchive,
} from "../../core/archive/archive-bundle-cleanup.ts";
import { BundleWriteError } from "../../core/archive/archive-bundle-writer.ts";
import {
  applyArchiveRetention,
  planArchiveRetention,
  resolveKeepLatest,
  RetentionConfigError,
} from "../../core/archive/archive-retention.ts";
import {
  BundlePairNotCommittableError,
  DeleteIntentDurabilityError,
  DeleteIntentRecoveryError,
  PendingDeleteIntentError,
  readDeleteIntent,
} from "../../core/archive/delete-intent-journal.ts";
import {
  ArchiveMaintenanceError,
  describeJournal,
  planArchiveMaintenance,
  runArchiveMaintenance,
  type ArchiveMaintenanceDryRun,
  type ArchiveMaintenanceWrite,
  type JournalStatus,
} from "../../core/archive/archive-maintenance.ts";

// ---------------------------------------------------------------------------
// `state` command cluster. Subcommands: `state compact` (event-pack compaction for ONE
// phase), `state compact-archive` (fold loose archive records into bundles), `state
// archive-retention` (keep-latest-N retention), and `state archive-maintain` (the
// high-level recover→compact→retain→re-plan→validate→plan-lint orchestration). Every
// verb is DRY-RUN by default (reports a no-mutation `would_*` verdict); `--write` (under
// `withWriteLock`) applies. The destructive `--write` paths are the ones that delete
// loose files / retire bundles; the lower verbs emit `STATE_COMPACT_*` / `ARCHIVE_*` /
// `DELETE_INTENT_*` codes, `archive-maintain` reuses those plus a `verdict`/`bounded_status`.
// ---------------------------------------------------------------------------

export async function cmdState(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  // No subcommand, a help token, or only flags (e.g. `state --json`) → usage.
  if (subcommand === undefined || isHelpToken(subcommand) || subcommand.startsWith("-")) {
    const json = globalJson || argv.includes("--json");
    if (json) emitOk({ available: [...STATE_SPEC_ORDER] });
    else return emitUsage(clusterUsage("state"));
    return 0;
  }
  if (subcommand === "compact") {
    if (isHelpToken(rest[0]) || hasHelpFlag(rest)) return emitUsage(subcommandUsage("state", "compact"));
    return cmdStateCompact(rest, locale, globalJson);
  }
  if (subcommand === "compact-archive") {
    if (isHelpToken(rest[0]) || hasHelpFlag(rest)) return emitUsage(subcommandUsage("state", "compact-archive"));
    return cmdStateCompactArchive(rest, globalJson);
  }
  if (subcommand === "archive-retention") {
    if (isHelpToken(rest[0]) || hasHelpFlag(rest)) return emitUsage(subcommandUsage("state", "archive-retention"));
    return cmdStateArchiveRetention(rest, globalJson);
  }
  if (subcommand === "archive-maintain") {
    if (isHelpToken(rest[0]) || hasHelpFlag(rest)) return emitUsage(subcommandUsage("state", "archive-maintain"));
    return cmdStateArchiveMaintain(rest, globalJson);
  }
  emitError(
    globalJson || argv.includes("--json"),
    "CONFIG_ERROR",
    `state: unknown subcommand "${subcommand}". Use: ${STATE_SPEC_ORDER.join(" | ")}`,
  );
  return 2;
}

/**
 * `state archive-retention [--keep-latest N] [--write] [--json]` — conservative keep-latest-N
 * retention. Dry-run (default) reports the plan per kind (would_keep / would_drop / blocked),
 * mutates nothing. `--write` (under the write lock) DELETES old archive truth — PR-2a deletes
 * LOOSE-ONLY would_drop records through a per-record re-read + re-authority-validate gate;
 * a bundle-only / `both` would_drop is reported `skipped` (bundle-member removal is a later
 * layer). The plan is re-run as the delete authority inside the apply (never a stale view).
 */
async function cmdStateArchiveRetention(argv: string[], globalJson: boolean): Promise<number> {
  const json = globalJson || argv.includes("--json");
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "state archive-retention",
      argv,
      toParseOptions(STATE_SPECS["archive-retention"]),
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }
  if (positionals.length > 0) {
    emitError(json, "CONFIG_ERROR", `state archive-retention takes no positional arguments (got "${positionals[0]}").`);
    return 2;
  }
  let keepLatest: number;
  try {
    keepLatest = resolveKeepLatest(values["keep-latest"] as string | undefined);
  } catch (err) {
    if (!(err instanceof RetentionConfigError)) throw err;
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }
  const cwd = process.cwd();
  const write = values.write === true;

  if (!write) {
    const plans = await planArchiveRetention(cwd, { keepLatest });
    if (json) emitOk({ mode: "dry_run", keep_latest: keepLatest, retention_plans: plans });
    else {
      for (const p of plans) {
        process.stdout.write(
          `${p.kind}: keep ${p.would_keep.length}, drop ${p.would_drop.length}, blocked ${p.blocked.length}\n`,
        );
      }
    }
    return 0;
  }

  return withWriteLock(cwd, "state archive-retention --write", json, async () => {
    let results;
    try {
      results = await applyArchiveRetention(cwd, { keepLatest });
    } catch (err) {
      // Known journal/durability faults are fail-closed and operator-GUIDED (not a generic internal
      // error): a PENDING journal (or a transient DURABILITY fault) is re-runnable; a RECOVERY
      // failure is NOT — it needs inspect/repair (corrupt journal, or a present journal whose
      // referenced authority is broken). The envelope below routes each to the right next action.
      if (
        !(err instanceof DeleteIntentRecoveryError) &&
        !(err instanceof DeleteIntentDurabilityError) &&
        !(err instanceof PendingDeleteIntentError)
      ) {
        throw err;
      }
      const message = err.message;
      const journal = describeJournal(await readDeleteIntent(cwd));
      // A valid `present` journal's recovery can complete PART of a committed delete before failing
      // (loose unlinks run before bundle retires), so report partial_applied conservatively — the
      // same honesty the high-level `archive-maintain` envelope gives. corrupt/absent → no mutation.
      const baseData = { recovery_pending: journal.pending_before, journal_status: journal.status, partial_applied: journal.status === "present" };
      if (err instanceof DeleteIntentRecoveryError) {
        // NOT re-runnable — corrupt journal OR a valid-present journal whose referenced authority
        // is broken. Guidance is inspect/repair, never blind re-run (the high-level verb's logic).
        const g = recoveryFailureGuidance(journal);
        emitError(json, "DELETE_INTENT_RECOVERY_FAILED", message, {
          data: { ...baseData, recovery_failure_kind: g.recovery_failure_kind },
          human: `${message}${g.human}`,
        });
        return 2;
      }
      // PENDING / a (transient) DURABILITY fault ARE re-runnable when a present journal remains.
      const reRunHuman =
        journal.status === "present"
          ? " — a delete-intent journal remains; re-run `state archive-retention --write` to complete it."
          : journal.status === "corrupt"
            ? " — a CORRUPT delete-intent journal remains; inspect/repair it, do NOT just re-run."
            : "";
      const human = `${message}${reRunHuman}`;
      if (err instanceof DeleteIntentDurabilityError) {
        emitError(json, "DELETE_INTENT_DURABILITY_FAILED", message, { data: { ...baseData, reason: err.reason }, human });
      } else {
        emitError(json, "PENDING_DELETE_INTENT", message, { data: baseData, human });
      }
      return 2;
    }
    if (json) emitOk({ mode: "written", keep_latest: keepLatest, results });
    else {
      for (const r of results) {
        process.stdout.write(
          `${r.kind}: deleted ${r.deleted.length}, bundle_member_removed ${r.bundle_member_removed.length}, recovered ${r.recovered.length}, vanished ${r.vanished.length}, skipped ${r.skipped.length}\n`,
        );
      }
    }
    return 0;
  });
}

function ineligibleDetail(phaseId: string, block: EventPackBlock): string {
  switch (block.kind) {
    case "phase_file_still_present":
      return `the phase YAML still exists at ${block.phase_path} — run \`code-pact phase archive ${phaseId} --write\` first`;
    case "ambiguous_phase_id":
      return `phase id "${phaseId}" maps to multiple live phase YAMLs (${block.phase_paths.join(", ")}) — resolve the duplicates before compacting`;
    case "phase_discovery_incomplete":
      return block.detail;
    case "snapshot_missing":
      return `no phase snapshot found — run \`code-pact phase archive ${phaseId} --write\` first`;
    case "snapshot_invalid":
      return `the phase snapshot is corrupt or unreadable: ${block.detail}`;
    case "snapshot_evidence_broken":
      return `the phase snapshot's progress_events evidence does not resolve from the durable ledger (loose ∪ packs)`;
    case "pack_stale":
      return `a loose event file is not covered by the existing pack (the pack and loose set have diverged) — inspect the pack manually`;
    case "pack_invalid":
      return `the existing event pack failed validation: ${block.detail}`;
    case "candidate_bind_failed":
      return `the candidate pack failed pre-write binding (internal consistency error — please report)`;
  }
}

/** Human line for a DRY-RUN verdict (no disk mutation). */
function dryRunHumanLine(phaseId: string, result: StateCompactResult): string {
  switch (result.kind) {
    case "would_pack_and_cleanup":
      return `Would compact "${phaseId}": pack ${result.would_pack_event_count} event(s) into ${result.pack_path} and remove ${result.would_leave_loose_count} loose file(s) (run with --write).`;
    case "would_cleanup_loose":
      return `Would compact "${phaseId}": a pack already covers it — --write would remove ${result.loose_remaining_count} loose file(s).`;
    case "would_resume_cleanup":
      return `Would resume compacting "${phaseId}": a prior cleanup or manual removal left a partial loose set — --write would remove the remaining ${result.loose_remaining_count} loose file(s).`;
    case "noop_already_cleaned":
      return `"${phaseId}" is already compacted (a pack covers it and no loose files remain).`;
    case "noop_no_events":
      return `No progress events found for archived phase "${phaseId}" — nothing to pack or clean.`;
    case "ineligible":
      return `Cannot compact "${phaseId}": ${ineligibleDetail(phaseId, result.block)}`;
    case "cleanup_outcome":
      // Handled by emitCleanupOutcome, never reaches here.
      return "";
  }
}

/** Human line for a successful `--write` cleanup outcome. */
function cleanupSuccessLine(phaseId: string, o: Extract<CleanupOutcome, { ok: true }>): string {
  // `cleaned` can carry advisories (e.g. R5 `unclassified_loose_after_cleanup`); the
  // human line is a summary, so it only hints at them and points to `--json` for the
  // detail (which always carries the full `advisories[]`).
  const n = o.advisories.length;
  const advisory = n > 0 ? ` (${n} ${n === 1 ? "advisory" : "advisories"} — see --json for detail)` : "";
  switch (o.kind) {
    case "cleaned": {
      const vanished = o.vanished_count > 0 ? ` (${o.vanished_count} already gone)` : "";
      return `Compacted "${phaseId}": removed ${o.loose_deleted_count} loose event file(s)${vanished}; the event pack is the durable record.${advisory}`;
    }
    case "already_cleaned":
      return `"${phaseId}" is already compacted — a pack covers it and no loose files remain.${advisory}`;
    case "noop_no_events":
      return `No progress events found for archived phase "${phaseId}" — nothing to compact.${advisory}`;
  }
}

/** Human message for a failed `--write` cleanup outcome. */
function cleanupErrorMessage(
  outcome: Extract<CleanupOutcome, { ok: false }>,
  phaseId: string,
): string {
  switch (outcome.code) {
    case "STATE_COMPACT_INELIGIBLE":
      return `phase "${phaseId}" cannot be compacted: ${ineligibleDetail(phaseId, outcome.block)}`;
    case "STATE_COMPACT_WRITE_FAILED":
      return `state compact --write failed during ${outcome.phase} (no loose files were removed)`;
    case "STATE_COMPACT_CLEANUP_FAILED":
      return `state compact --write: cleanup aborted${outcome.block ? ` (${outcome.block})` : ""} — resolve the conflict and rerun`;
    case "STATE_COMPACT_CLEANUP_INCOMPLETE":
      return `state compact --write: ${outcome.cleanup_remaining_loose} loose file(s) could not be removed — read skipped[], fix each, and rerun`;
  }
}

/**
 * The JSON `data` payload for a `CleanupOutcome`. The `CleanupOutcome` type guarantees
 * `cleanup_pending` / `partial_applied` / `cleanup_started` / `loose_deleted_count` /
 * `cleanup_remaining_loose` / `vanished_count` / `advisories` on EVERY result (success
 * AND failure) so a consumer reads them unconditionally; `skipped` is present on the
 * FAILURE variants only (always `[]` until the cleanup phase records a survivor). The
 * CLI must NOT drop any of these on the error paths (an earlier version did, breaking
 * the public failure contract). To stay exhaustive by construction we spread the WHOLE
 * outcome rather than re-listing fields, stripping only the `ok` discriminant (the
 * envelope owns `ok`) and, on errors, `code` (the envelope owns `error.code`); then add
 * the CLI-only fields: `phase_id` always, plus `pack_path` / `next_action` on a write
 * failure. Pure + exported so every variant's data shape can be pinned by a unit test
 * (the happy-path E2E can't see the failure shapes).
 */
export function cleanupOutcomeData(
  outcome: CleanupOutcome,
  phaseId: string,
  cwd: string,
): Record<string, unknown> {
  if (outcome.ok) {
    const { ok: _ok, ...rest } = outcome;
    return { phase_id: phaseId, ...rest };
  }
  const { ok: _ok, code: _code, ...rest } = outcome;
  if (outcome.code === "STATE_COMPACT_WRITE_FAILED") {
    return {
      phase_id: phaseId,
      ...rest,
      pack_path: eventPackPath(cwd, phaseId),
      // `verify_pack` means the pack step mutated the tree but the pack may NOT still be
      // present (a post-write re-prepare race can remove it), so the next_action must not
      // assume it can be inspected.
      ...(outcome.phase === "verify_pack"
        ? {
            next_action:
              "Inspect the pack file if it is still present, resolve the conflict, then rerun state compact.",
          }
        : {}),
    };
  }
  return { phase_id: phaseId, ...rest };
}

/** Map a `--write` `CleanupOutcome` to CLI output + exit code. */
function emitCleanupOutcome(
  outcome: CleanupOutcome,
  phaseId: string,
  cwd: string,
  json: boolean,
): number {
  const data = cleanupOutcomeData(outcome, phaseId, cwd);
  if (outcome.ok) {
    if (json) emitOk(data);
    else process.stdout.write(`${cleanupSuccessLine(phaseId, outcome)}\n`);
    return 0;
  }
  emitError(json, outcome.code, cleanupErrorMessage(outcome, phaseId), { data });
  return 2;
}

async function cmdStateCompact(
  argv: string[],
  _locale: Locale,
  globalJson: boolean,
): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "state compact",
      argv,
      toParseOptions(STATE_SPECS.compact),
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const write = values.write === true;
  const phaseId = positionals[0];
  if (!phaseId) {
    emitError(json, "CONFIG_ERROR", "state compact requires a phase id (e.g. `state compact P1`).");
    return 2;
  }

  const cwd = process.cwd();

  const runImpl = async (): Promise<number> => {
    const result = await runStateCompact({ cwd, phaseId, write });
    if (result.kind === "cleanup_outcome") {
      return emitCleanupOutcome(result.outcome, phaseId, cwd, json);
    }
    if (result.kind === "ineligible") {
      emitError(
        json,
        "STATE_COMPACT_INELIGIBLE",
        `phase "${phaseId}" cannot be compacted: ${ineligibleDetail(phaseId, result.block)}`,
        { data: { phase_id: phaseId, block: result.block } },
      );
      return 2;
    }
    if (json) emitOk(result);
    else process.stdout.write(`${dryRunHumanLine(phaseId, result)}\n`);
    return 0;
  };

  if (write) return withWriteLock(cwd, `state compact ${phaseId} --write`, json, runImpl);
  return runImpl();
}

// ---------------------------------------------------------------------------
// `state compact-archive [<kind>] [--write]` — Layer 4 entry to archive-bundle
// compaction. DRY-RUN reports, per kind, the loose records that would be folded
// into a bundle (`would_bundle`), deleted because a verified bundle already holds
// them (`would_delete`), or skipped (`would_skip`: a same-id bundle member differs
// or is invalid — fail-closed). `--write` (under the write lock) runs the
// redundant-bundle-safe `compactArchive` per kind and reports the outcome. NOTE the
// `*_path` ids are LOGICAL record ids, not necessarily a physical loose file once
// compaction has run (the record may live only in a bundle).
// ---------------------------------------------------------------------------
async function cmdStateCompactArchive(argv: string[], globalJson: boolean): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "state compact-archive",
      argv,
      toParseOptions(STATE_SPECS["compact-archive"]),
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const write = values.write === true;

  if (positionals.length > 1) {
    emitError(json, "CONFIG_ERROR", "state compact-archive accepts at most one kind positional.");
    return 2;
  }
  // Optional positional restricts to one kind; otherwise all kinds.
  let kinds = ArchiveBundleKind.options;
  const kindArg = positionals[0];
  if (kindArg !== undefined) {
    const parsed = ArchiveBundleKind.safeParse(kindArg);
    if (!parsed.success) {
      emitError(
        json,
        "CONFIG_ERROR",
        `state compact-archive: unknown kind "${kindArg}". Expected one of: ${ArchiveBundleKind.options.join(", ")}.`,
      );
      return 2;
    }
    kinds = [parsed.data];
  }

  const cwd = process.cwd();

  // A build/write/verify member fault → ARCHIVE_BUNDLE_WRITE_FAILED; a corrupt bundle
  // STORE (loadArchiveBundles) → ARCHIVE_BUNDLE_INVALID. Literal codes so the error-code
  // surface lock tracks them. `failedKind` + `completed` make a partial multi-kind
  // --write run honest: earlier kinds may already have applied before a later kind fails.
  const emitFailure = (
    err: unknown,
    failedKind: ArchiveBundleKind | null,
    completed: unknown[],
  ): number => {
    const message = `state compact-archive failed${failedKind ? ` on ${failedKind}` : ""}: ${(err as Error).message}`;
    const partial = completed.length > 0 || (err instanceof BundleWriteError && err.partial_applied);
    const data = {
      ...(failedKind ? { failed_kind: failedKind } : {}),
      ...(err instanceof BundleWriteError ? { phase: err.phase } : {}),
      partial_applied: partial,
      completed_results: completed,
    };
    // The `compactArchive` core primitive now enforces the recovery-first invariant itself, so it
    // can throw the journal errors even past the CLI pre-check (a future/raced path). Map them to
    // their OWN public codes — never mislabel a pending/corrupt journal as a corrupt bundle store.
    if (err instanceof PendingDeleteIntentError) {
      emitError(json, "PENDING_DELETE_INTENT", err.message, { data: { ...data, recovery_pending: true, journal_status: "present" } });
    } else if (err instanceof DeleteIntentRecoveryError) {
      // compactArchive's guard throws this ONLY for a corrupt journal (it does no bundle-pair recovery).
      emitError(json, "DELETE_INTENT_RECOVERY_FAILED", err.message, { data: { ...data, recovery_pending: true, journal_status: "corrupt", recovery_failure_kind: "journal_corrupt" } });
    } else if (err instanceof BundleWriteError) emitError(json, "ARCHIVE_BUNDLE_WRITE_FAILED", message, { data });
    else emitError(json, "ARCHIVE_BUNDLE_INVALID", message, { data });
    return 2;
  };

  const runImpl = async (): Promise<number> => {
    if (!write) {
      // Dry-run: read-only. A would_bundle member fault throws fail-closed (no mutation).
      let failedKind: ArchiveBundleKind | null = null;
      try {
        const plans = [];
        for (const kind of kinds) {
          failedKind = kind;
          plans.push(await planCompactArchive(cwd, kind));
          failedKind = null;
        }
        // A pending journal means `--write` would REFUSE here (this verb is not recovery-first) —
        // surface it in the read-only dry-run so an operator who reads the plan isn't surprised by
        // a refusal on `--write`. (Mirrors `archive-maintain`'s `plans_are_pre_recovery`.)
        const jr = await readDeleteIntent(cwd);
        const journal =
          jr.kind === "absent"
            ? { status: "absent" as const, write_will_refuse: false }
            : jr.kind === "corrupt"
              ? { status: "corrupt" as const, write_will_refuse: true, next_action: "inspect/repair the delete-intent journal (archive-maintain cannot auto-recover it)" }
              : { status: "present" as const, write_will_refuse: true, next_action: "run `state archive-maintain --write` to recover, then compact" };
        if (json) emitOk({ mode: "dry_run", plans, journal });
        else {
          for (const p of plans) {
            process.stdout.write(
              `${p.kind}: would bundle ${p.would_bundle.length}, supersede ${p.would_supersede.length}, delete ${p.would_delete.length}, retire ${p.would_retire_bundles.length} bundle(s), skip ${p.would_skip.length}\n`,
            );
          }
          if (journal.write_will_refuse) {
            process.stdout.write(`NOTE: a ${journal.status} delete-intent journal is pending — \`--write\` will REFUSE; ${journal.next_action}.\n`);
          }
        }
        return 0;
      } catch (err) {
        return emitFailure(err, failedKind, []); // dry-run mutates nothing
      }
    }

    // A pending delete-intent journal must be RECOVERED before any archive compaction. This
    // low-level verb REFUSES (it has no recovery path of its own): consolidation would retire a
    // crashed bundle-pair removal's reduced SURVIVOR bundle as "superseded", after which recovery
    // can never complete — a permanent wedge. PRESENT and CORRUPT are DISTINCT next actions: a
    // present journal `state archive-maintain --write` recovers; a CORRUPT journal it CANNOT
    // auto-recover (it must be inspected/repaired), so emit the recovery-failed code, not "pending".
    const pending = await readDeleteIntent(cwd);
    if (pending.kind === "present") {
      emitError(
        json,
        "PENDING_DELETE_INTENT",
        "a delete-intent journal is pending; run `code-pact state archive-maintain --write` to recover it before archive compaction.",
        { data: { recovery_pending: true, journal_status: "present" } },
      );
      return 2;
    }
    if (pending.kind === "corrupt") {
      // SAME `DELETE_INTENT_RECOVERY_FAILED` contract as the core-guard catch path and the
      // high-level verb: `recovery_failure_kind` + `partial_applied` (false — readDeleteIntent
      // stopped before any mutation). Never let the pre-check path drop the documented fields.
      emitError(json, "DELETE_INTENT_RECOVERY_FAILED", pending.detail, {
        data: { recovery_pending: true, journal_status: "corrupt", recovery_failure_kind: "journal_corrupt", partial_applied: false, cause: pending.cause },
        human: `${pending.detail} — inspect/repair .code-pact/state/archive/delete-intent.json; archive-maintain cannot auto-recover a corrupt journal.`,
      });
      return 2;
    }

    const completed: Array<Record<string, unknown>> = [];
    let failedKind: ArchiveBundleKind | null = null;
    try {
      for (const kind of kinds) {
        failedKind = kind;
        const out = await compactArchive(cwd, kind);
        completed.push({
          kind,
          bundle: out.bundle.kind,
          retired_bundles: out.retired_bundles,
          deleted: out.delete.deleted,
          skipped: out.delete.skipped,
          remaining_loose: out.delete.remaining_loose,
        });
        failedKind = null;
      }
    } catch (err) {
      return emitFailure(err, failedKind, completed);
    }
    if (json) emitOk({ mode: "written", results: completed });
    else {
      for (const r of completed) {
        process.stdout.write(
          `${String(r.kind)}: bundle=${String(r.bundle)}, retired ${(r.retired_bundles as string[]).length} bundle(s), deleted ${(r.deleted as string[]).length}, skipped ${(r.skipped as unknown[]).length}, remaining ${String(r.remaining_loose)}\n`,
        );
      }
    }
    return 0;
  };

  if (write) return withWriteLock(cwd, "state compact-archive --write", json, runImpl);
  return runImpl();
}

// ---------------------------------------------------------------------------
// `state archive-maintain [--keep-latest N] [--write]` — the HIGH-LEVEL operator
// entry that orchestrates the existing archive primitives in the safe order
// (RECOVER any pending delete-intent journal FIRST → compact → retention → compact-
// again → re-plan → validate → plan lint), so an operator runs ONE obvious command
// instead of remembering the low-level sequence. It adds NO new destructive semantics
// and NO new tracked state. DRY-RUN is read-only and lock-free; `--write` runs under
// ONE outer write lock for the whole orchestration. The result is reported honestly:
// a source:both follow-up, a deferred pair, an un-foldable record, or a pending journal
// all read as NOT bounded, and `bundle_byte_size_bounded` is ALWAYS false (sharding
// deferred). See docs/cli-contract.md → `state archive-maintain`.
// ---------------------------------------------------------------------------

/** Guidance for a `DELETE_INTENT_RECOVERY_FAILED` — which is NOT "corrupt journal only". It
 *  fires when the recovery AUTHORITY cannot be used safely, in TWO shapes: a `corrupt` journal
 *  (repair the journal file), OR a VALID `present` journal whose referenced archive bundles/files
 *  are missing or byte-changed (repair the referenced bundles). In BOTH a blind re-run fails the
 *  SAME way — so the guidance is NEVER "re-run to complete it" (unlike `PENDING_DELETE_INTENT` /
 *  a transient `DELETE_INTENT_DURABILITY_FAILED`, which ARE re-runnable). */
function recoveryFailureGuidance(journal: JournalStatus): { recovery_failure_kind: string; human: string } {
  if (journal.status === "corrupt") {
    return {
      recovery_failure_kind: "journal_corrupt",
      human: " — a CORRUPT delete-intent journal remains; inspect/repair `.code-pact/state/archive/delete-intent.json` (it cannot be auto-recovered), do NOT just re-run.",
    };
  }
  if (journal.status === "present") {
    return {
      recovery_failure_kind: "present_journal_recovery_failed",
      human: " — the delete-intent journal is VALID, but recovery FAILED verifying/retiring the archive authority it references (a survivor / old bundle is missing or its bytes changed); inspect/repair the referenced archive bundles, do NOT blindly re-run unchanged.",
    };
  }
  return { recovery_failure_kind: "recovery_failed", human: " — recovery failed; inspect the archive state before retrying." };
}

/** Map a wrapped maintenance fault to its public error code + diagnostic data. The
 *  cause is the primitive's own error (the same one the low-level verbs surface), so
 *  the operator sees the SAME code whether they ran the high-level or low-level verb. */
function maintErrorEnvelope(
  err: ArchiveMaintenanceError,
  json: boolean,
  journal: JournalStatus,
): void {
  const cause = err.cause_error;
  const base = {
    step: err.step,
    completed_steps: err.completed_steps,
    partial_applied: err.partial_applied,
    recovery_pending: journal.pending_before,
    journal_status: journal.status,
    // Report any delete-intent recovery the run already COMPLETED before the fault — so a
    // recovery-completed drop of old truth is never lost just because a later step failed.
    ...(err.recovered.length > 0 ? { recovered: err.recovered } : {}),
  };
  // A re-runnable journal (PendingDeleteIntent / a transient durability fault) → "re-run completes
  // it" when present. A RECOVERY failure (DeleteIntentRecoveryError) is NOT re-runnable — handled
  // separately by `recoveryFailureGuidance` (corrupt OR a present-but-broken authority).
  const journalHuman =
    journal.status === "present"
      ? " — a delete-intent journal remains; re-run `state archive-maintain --write` to complete it."
      : journal.status === "corrupt"
        ? " — a CORRUPT delete-intent journal remains; inspect/repair `.code-pact/state/archive/delete-intent.json`, do NOT just re-run."
        : "";
  if (cause instanceof BundleWriteError) {
    emitError(json, "ARCHIVE_BUNDLE_WRITE_FAILED", `state archive-maintain failed during ${err.step}: ${cause.message}`, {
      data: { ...base, phase: cause.phase },
    });
  } else if (cause instanceof DeleteIntentRecoveryError) {
    const g = recoveryFailureGuidance(journal);
    emitError(json, "DELETE_INTENT_RECOVERY_FAILED", cause.message, {
      data: { ...base, recovery_failure_kind: g.recovery_failure_kind },
      human: `${cause.message}${g.human}`,
    });
  } else if (cause instanceof DeleteIntentDurabilityError) {
    emitError(json, "DELETE_INTENT_DURABILITY_FAILED", cause.message, {
      data: { ...base, reason: cause.reason },
      human: `${cause.message}${journalHuman}`,
    });
  } else if (cause instanceof PendingDeleteIntentError) {
    emitError(json, "PENDING_DELETE_INTENT", cause.message, {
      data: base,
      human: `${cause.message}${journalHuman}`,
    });
  } else if (cause instanceof BundlePairNotCommittableError) {
    emitError(json, "BUNDLE_PAIR_NOT_COMMITTABLE", cause.message, { data: base });
  } else {
    // A corrupt bundle STORE (loadArchiveBundles strict) or any other fold-time fault.
    emitError(json, "ARCHIVE_BUNDLE_INVALID", `state archive-maintain failed during ${err.step}: ${cause.message}`, {
      data: base,
    });
  }
}

/** `bounded` / `not bounded` plus a short qualifier, for the human Scope block. */
function boundedLine(label: string, ok: boolean, notBoundedDetail: string): string {
  return `  ${label}: ${ok ? "bounded" : `not bounded — ${notBoundedDetail}`}`;
}

/** Precise "why file-count is not bounded" detail from the reason counts — so the operator
 *  never reads a vague "0 records" line; each non-zero driver is named. No action suffix: the
 *  caller's footer (`Run --write` / the not-bounded warning) owns rerun-vs-inspect guidance, so a
 *  "skipped (cannot be folded)" driver is never paired with a contradictory "rerun". */
function fileCountNotBoundedDetail(r: ArchiveMaintenanceWrite["bounded_status"]["file_count_unbounded_reasons"]): string {
  const parts: string[] = [];
  if (r.pending_delete_intent) parts.push("a pending delete-intent journal");
  const fold = r.would_bundle + r.would_delete + r.would_supersede;
  if (fold > 0) parts.push(`${fold} loose record(s) to fold/delete`);
  if (r.would_retire_bundles > 0) parts.push(`${r.would_retire_bundles} superseded bundle(s) to retire`);
  if (r.would_skip > 0) parts.push(`${r.would_skip} record(s) that cannot be folded (skipped — needs inspection)`);
  return parts.length ? parts.join("; ") : "compaction work remains";
}

/** Precise "why unreferenced old truth is not bounded" detail from the reason counts. */
function unreferencedNotBoundedDetail(r: ArchiveMaintenanceWrite["bounded_status"]["unreferenced_old_truth_unbounded_reasons"]): string {
  const parts: string[] = [];
  if (r.would_drop > 0) parts.push(`${r.would_drop} droppable record(s) remain`);
  if (r.pending_delete_intent) parts.push("a pending delete-intent journal");
  return parts.length ? parts.join("; ") : "droppable truth remains";
}

function renderDryRunHuman(d: ArchiveMaintenanceDryRun): string {
  const s = d.summary;
  const b = d.bounded_status;
  const lines: string[] = [
    "Archive maintenance — dry run (no changes).",
    "",
    `Current archive files: ${s.archive_files} (${s.loose_records} loose record(s), ${s.bundles} bundle(s))`,
    "",
    "Planned:",
    `  fold ${s.planned_loose_folded} loose record(s) into bundles`,
    `  delete ${s.planned_loose_deleted} already-bundled loose record(s)`,
    `  drop ${s.planned_drop} unreferenced old record(s)`,
  ];
  if (s.planned_compact_skipped > 0) {
    lines.push(`  ${s.planned_compact_skipped} record(s) cannot be folded (skipped — inspect with --json)`);
  }
  const j = d.steps.journal;
  const journalLine =
    j.status === "absent"
      ? "none"
      : j.status === "corrupt"
        ? "CORRUPT — `--write` will fail recovery (DELETE_INTENT_RECOVERY_FAILED); inspect/repair the journal first"
        : `present (${j.count} ${j.intent_kinds.join("+")} intent(s)) — --write recovers it first`;
  lines.push(
    "",
    `Pending delete-intent journal: ${journalLine}`,
  );
  if (j.plans_are_pre_recovery) {
    lines.push(
      "  (the Planned / Scope figures above are CURRENT pre-recovery diagnostics — `--write` recovers the journal FIRST, then compacts; re-run dry-run after recovery for the exact plan.)",
    );
  }
  lines.push(
    "",
    "Checks (current):",
    `  validate: ${d.steps.checks.validate.ok ? "ok" : `FAILED (${d.steps.checks.validate.errors} error(s))`}`,
    `  plan lint: ${d.steps.checks.plan_lint.errors} error(s), ${d.steps.checks.plan_lint.warnings} warning(s), ${d.steps.checks.plan_lint.advisories} advisor${d.steps.checks.plan_lint.advisories === 1 ? "y" : "ies"}`,
    "",
    "Scope (current):",
    boundedLine("file-count garbage", b.file_count_bounded, fileCountNotBoundedDetail(b.file_count_unbounded_reasons)),
    boundedLine("unreferenced old truth", b.unreferenced_old_truth_bounded, unreferencedNotBoundedDetail(b.unreferenced_old_truth_unbounded_reasons)),
    "  bundle byte size: not bounded yet; sharding deferred",
    "",
    "Run `code-pact state archive-maintain --write` to apply.",
  );
  return lines.join("\n");
}

function renderWriteHuman(d: ArchiveMaintenanceWrite): string {
  const s = d.summary;
  const b = d.bounded_status;
  const checks = d.steps.checks;
  const v2Bounded = b.file_count_bounded && b.unreferenced_old_truth_bounded;
  const lines: string[] = [
    // Don't say "complete" when the archive is not yet bounded — the mutations were applied,
    // but the operator (or CI) must rerun to converge.
    v2Bounded ? "Archive maintenance complete." : "Archive maintenance applied, but the archive is not yet bounded.",
    "",
    "Files:",
    `  archive loose records: ${s.loose_records_before} → ${s.loose_records_after}`,
    `  archive bundles:       ${s.bundles_before} → ${s.bundles_after}`,
    `  total archive files:   ${s.archive_files_before} → ${s.archive_files_after}`,
    "",
    "Truth:",
    "  referenced truth: retained",
    `  unreferenced old truth: ${b.unreferenced_old_truth_bounded ? "none remaining" : `${s.deleted} dropped this run; a follow-up run is needed (re-run archive-maintain)`}`,
    `  source:both follow-up: ${s.source_both_follow_up === 0 ? "none" : `${s.source_both_follow_up} (re-run archive-maintain to drop the surviving copies)`}`,
    // Deferred retention records — NOT all are "pairs": `bundle_member_deferred` covers an
    // independent bundle record / a not-yet-pairable bundle phase, and `atomic_pair_deferred`
    // is a loose pair held back by an unsupported fsync / partial store / missing digest (NOT
    // fixed by `compact-archive`). So name them accurately and point at the per-record reasons.
    `  deferred retention records: ${s.mixed_source_deferred === 0 ? "none" : `${s.mixed_source_deferred} (${s.bundle_member_deferred} bundle-member, ${s.atomic_pair_deferred} atomic-pair — inspect --json steps.retention.results[].skipped[])`}`,
  ];
  if (s.recovered_loose_pairs > 0 || s.recovered_bundle_pairs > 0) {
    lines.push(
      `  recovered: ${s.recovered_loose_pairs} loose pair(s), ${s.recovered_bundle_pairs} bundle pair(s) (a prior crashed delete was completed)`,
    );
    // A recovered BUNDLE pair's `source: both` survivor is deferred to a later run, so it does NOT
    // show in `source:both follow-up` (that counts THIS run's bundle_member_removed). Flag it
    // explicitly so "follow-up: none" + "not bounded" never reads as a contradiction.
    if (s.recovered_bundle_pairs > 0 && !b.unreferenced_old_truth_bounded) {
      lines.push("    ↳ a recovered bundle-pair survivor still needs a later drop — re-run archive-maintain to converge.");
    }
  }
  lines.push(
    "",
    "Checks:",
    `  validate: ${checks.validate.ok ? "ok" : `FAILED (${checks.validate.errors} error(s))`}`,
    `  plan lint: ${checks.plan_lint.errors} error(s), ${checks.plan_lint.warnings} warning(s), ${checks.plan_lint.advisories} advisor${checks.plan_lint.advisories === 1 ? "y" : "ies"}`,
    "",
    "Scope:",
    boundedLine("file-count garbage", b.file_count_bounded, fileCountNotBoundedDetail(b.file_count_unbounded_reasons)),
    boundedLine("unreferenced old truth", b.unreferenced_old_truth_bounded, unreferencedNotBoundedDetail(b.unreferenced_old_truth_unbounded_reasons)),
    "  bundle byte size: not bounded yet; sharding deferred",
  );
  if (!v2Bounded) {
    // Two kinds of not-bounded need DIFFERENT next actions: rerun-to-converge (a healthy
    // source:both follow-up / a recovered bundle-pair survivor) vs INSPECT-needed (any skipped /
    // deferred record — a `bundle_stale`, an unsupported `fsync`, a partial store — does NOT clear
    // on a blind rerun). `summary.skipped` (compact + retention skips) is the inspect-needed signal.
    if (s.skipped > 0) {
      lines.push(
        "",
        `⚠ the archive is NOT yet bounded, and ${s.skipped} skipped/deferred record(s) (${s.compact_skipped} compaction, ${s.retention_skipped} retention) will NOT clear on a blind rerun — INSPECT them: read --json \`summary.bundle_member_deferred\` / \`atomic_pair_deferred\`, \`steps.compact_*.skipped[]\`, \`steps.retention.results[].skipped[]\`, and the \`bounded_status\` reasons. Exit code 1.`,
      );
    } else {
      lines.push("", "⚠ the archive is NOT yet bounded (see Scope above) — rerun `code-pact state archive-maintain --write` to converge. Exit code 1.");
    }
  }
  if (!checks.ok) {
    lines.push("", "⚠ a post-check did not pass — investigate the check above. Exit code 1.");
  }
  return lines.join("\n");
}

async function cmdStateArchiveMaintain(argv: string[], globalJson: boolean): Promise<number> {
  const json = globalJson || argv.includes("--json");
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "state archive-maintain",
      argv,
      toParseOptions(STATE_SPECS["archive-maintain"]),
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }
  if (positionals.length > 0) {
    emitError(json, "CONFIG_ERROR", `state archive-maintain takes no positional arguments (got "${positionals[0]}").`);
    return 2;
  }
  let keepLatest: number;
  try {
    keepLatest = resolveKeepLatest(values["keep-latest"] as string | undefined);
  } catch (err) {
    if (!(err instanceof RetentionConfigError)) throw err;
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }
  const cwd = process.cwd();
  const write = values.write === true;

  if (!write) {
    const plan = await planArchiveMaintenance(cwd, { keepLatest });
    if (json) emitOk(plan);
    else process.stdout.write(`${renderDryRunHuman(plan)}\n`);
    return 0; // dry-run is a read-only preview — always exit 0
  }

  return withWriteLock(cwd, "state archive-maintain --write", json, async () => {
    let result: ArchiveMaintenanceWrite;
    try {
      result = await runArchiveMaintenance(cwd, { keepLatest });
    } catch (err) {
      if (!(err instanceof ArchiveMaintenanceError)) throw err;
      // Surface WHAT delete-intent journal still remains (absent / present / CORRUPT) — a corrupt
      // journal needs inspect/repair, not a blind re-run; the envelope's guidance depends on it.
      maintErrorEnvelope(err, json, describeJournal(await readDeleteIntent(cwd)));
      return 2;
    }
    // The maintenance MUTATIONS succeeded → success envelope. The read-only post-checks
    // (validate + plan lint) are a CONVENIENCE PREVIEW: they do not change the envelope
    // shape, but a failing check sets exit 1 so a CI that runs only this verb still gets a
    // non-zero signal (the authoritative gates are the separate validate / plan-lint runs).
    const { ok, ...data } = result;
    if (json) emitOk(data);
    else process.stdout.write(`${renderWriteHuman(result)}\n`);
    return ok ? 0 : 1;
  });
}
