import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { withWriteLock, emitOk, emitError } from "../util.ts";
import { isHelpToken } from "../usage.ts";
import { runStateCompact, type StateCompactResult } from "../../commands/state-compact.ts";
import { type EventPackBlock } from "../../core/archive/event-pack.ts";
import type { CleanupOutcome } from "../../core/archive/event-pack-cleanup.ts";
import { eventPackPath } from "../../core/archive/paths.ts";

// ---------------------------------------------------------------------------
// `state` command cluster. ONE subcommand: `state compact`. The DRY-RUN reports a
// no-mutation verdict (`would_*`); `--write` (under `withWriteLock`) writes the event
// pack AND removes the gated loose event files, emitting the public `CleanupOutcome`
// (success: `cleaned` / `already_cleaned` / `noop_no_events`; failure: one of the four
// `STATE_COMPACT_*` codes). `--write` is the first path that deletes loose files.
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
    if (json) emitOk({ available: ["compact"] });
    else process.stdout.write("Usage: code-pact state compact <phase-id> [--write] [--json]\n");
    return 0;
  }
  if (subcommand === "compact") return cmdStateCompact(rest, locale, globalJson);
  emitError(
    globalJson || argv.includes("--json"),
    "CONFIG_ERROR",
    `state: unknown subcommand "${subcommand}". Available: compact`,
  );
  return 2;
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
    case "would_pack":
      return `Would pack ${result.would_pack_event_count} event(s) for "${phaseId}" into ${result.pack_path}, then remove ${result.would_leave_loose_count} loose file(s) (run with --write).`;
    case "would_already_packed":
      if (!result.cleanup_pending) {
        return `"${phaseId}" is already compacted (a pack covers it and no loose files remain).`;
      }
      return result.loose_relationship === "strict_subset"
        ? `"${phaseId}" is already packed; a prior cleanup or manual removal left a partial loose set — --write would remove the remaining ${result.loose_remaining_count} loose file(s).`
        : `"${phaseId}" is already packed; --write would remove ${result.loose_remaining_count} loose file(s).`;
    case "would_noop_no_events":
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
  switch (o.kind) {
    case "cleaned": {
      const vanished = o.vanished_count > 0 ? ` (${o.vanished_count} already gone)` : "";
      return `Compacted "${phaseId}": removed ${o.loose_deleted_count} loose event file(s)${vanished}; the event pack is the durable record.`;
    }
    case "already_cleaned":
      return `"${phaseId}" is already compacted — a pack covers it and no loose files remain.`;
    case "noop_no_events":
      return `No progress events found for archived phase "${phaseId}" — nothing to compact.`;
  }
}

/** Map a `--write` `CleanupOutcome` to CLI output + exit code. */
function emitCleanupOutcome(
  outcome: CleanupOutcome,
  phaseId: string,
  cwd: string,
  json: boolean,
): number {
  if (outcome.ok) {
    // Strip the outcome's own `ok` discriminant — `emitOk` owns the envelope's
    // `ok`, so the data payload must not carry a redundant nested `ok` (the
    // dry-run `emitOk(result)` payloads don't, and the shapes should match).
    const { ok: _ok, ...data } = outcome;
    if (json) emitOk({ phase_id: phaseId, ...data });
    else process.stdout.write(`${cleanupSuccessLine(phaseId, outcome)}\n`);
    return 0;
  }

  switch (outcome.code) {
    case "STATE_COMPACT_INELIGIBLE":
      emitError(
        json,
        "STATE_COMPACT_INELIGIBLE",
        `phase "${phaseId}" cannot be compacted: ${ineligibleDetail(phaseId, outcome.block)}`,
        { data: { phase_id: phaseId, block: outcome.block, advisories: outcome.advisories } },
      );
      return 2;
    case "STATE_COMPACT_WRITE_FAILED":
      emitError(
        json,
        "STATE_COMPACT_WRITE_FAILED",
        `state compact --write failed during ${outcome.phase} (no loose files were removed)`,
        {
          data: {
            phase_id: phaseId,
            phase: outcome.phase,
            partial_applied: outcome.partial_applied,
            cleanup_remaining_loose: outcome.cleanup_remaining_loose,
            pack_path: eventPackPath(cwd, phaseId),
            advisories: outcome.advisories,
            // `verify_pack` means the pack step mutated the tree but the pack may NOT
            // still be present (a post-write re-prepare failure can remove it), so the
            // next_action must not assume it can be inspected.
            ...(outcome.phase === "verify_pack"
              ? { next_action: "Inspect the pack file if it is still present, resolve the conflict, then rerun state compact." }
              : {}),
          },
        },
      );
      return 2;
    case "STATE_COMPACT_CLEANUP_FAILED":
      emitError(
        json,
        "STATE_COMPACT_CLEANUP_FAILED",
        `state compact --write: cleanup aborted${outcome.block ? ` (${outcome.block})` : ""} — resolve the conflict and rerun`,
        {
          data: {
            phase_id: phaseId,
            ...(outcome.block ? { block: outcome.block } : {}),
            partial_applied: outcome.partial_applied,
            cleanup_started: outcome.cleanup_started,
            loose_deleted_count: outcome.loose_deleted_count,
            cleanup_remaining_loose: outcome.cleanup_remaining_loose,
            vanished_count: outcome.vanished_count,
            skipped: outcome.skipped,
            advisories: outcome.advisories,
          },
        },
      );
      return 2;
    case "STATE_COMPACT_CLEANUP_INCOMPLETE":
      emitError(
        json,
        "STATE_COMPACT_CLEANUP_INCOMPLETE",
        `state compact --write: ${outcome.cleanup_remaining_loose} loose file(s) could not be removed — read skipped[], fix each, and rerun`,
        {
          data: {
            phase_id: phaseId,
            partial_applied: outcome.partial_applied,
            cleanup_started: outcome.cleanup_started,
            loose_deleted_count: outcome.loose_deleted_count,
            cleanup_remaining_loose: outcome.cleanup_remaining_loose,
            vanished_count: outcome.vanished_count,
            skipped: outcome.skipped,
            advisories: outcome.advisories,
          },
        },
      );
      return 2;
  }
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
      { json: { type: "boolean" }, write: { type: "boolean" } },
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
