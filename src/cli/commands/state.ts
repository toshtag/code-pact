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
