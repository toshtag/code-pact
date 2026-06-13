import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { withWriteLock, emitOk, emitError } from "../util.ts";
import { isHelpToken } from "../usage.ts";
import { runStateCompact, type StateCompactResult } from "../../commands/state-compact.ts";
import { EventPackWriteError, type EventPackBlock } from "../../core/archive/event-pack.ts";
import { eventPackPath } from "../../core/archive/paths.ts";

// ---------------------------------------------------------------------------
// `state` command cluster. Layer 2 ships ONE subcommand: `state compact`. It
// writes the event pack + readback-verifies it; it does NOT delete loose event
// files (Layer 3). Mirrors `phase archive`: dry-run lock-free, `--write` under
// `withWriteLock`; result kinds use the reviewer-locked `packed`/`would_pack`/
// `already_packed` naming (never `compacted`).
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
      return `an event pack exists but its event set differs from the current loose files — inspect the pack manually`;
    case "pack_invalid":
      return `the existing event pack failed validation: ${block.detail}`;
    case "candidate_bind_failed":
      return `the candidate pack failed pre-write binding (internal consistency error — please report)`;
  }
}

function humanLine(phaseId: string, result: StateCompactResult): string {
  switch (result.kind) {
    case "would_pack":
      return `Would pack ${result.would_pack_event_count} event(s) for "${phaseId}" into ${result.pack_path}; ${result.would_leave_loose_count} loose file(s) would remain (Layer 3 cleanup pending).`;
    case "packed":
      return `Packed ${result.packed_event_count} event(s) for "${phaseId}" into ${result.pack_path}. ${result.loose_remaining_count} loose file(s) still on disk — ${result.next_action}`;
    case "would_already_packed":
    case "already_packed":
      return result.cleanup_pending
        ? `"${phaseId}" is already packed; ${result.loose_remaining_count} loose file(s) still await Layer 3 cleanup.`
        : `"${phaseId}" is already packed and fully cleaned up (no loose files remain).`;
    case "would_noop_no_events":
    case "noop_no_events":
      return `No progress events found for archived phase "${phaseId}" — likely attested or predates event tracking. Nothing was packed.`;
    case "ineligible":
      return `Cannot compact "${phaseId}": ${ineligibleDetail(phaseId, result.block)}`;
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
    let result: StateCompactResult;
    try {
      result = await runStateCompact({ cwd, phaseId, write });
    } catch (err) {
      if (err instanceof EventPackWriteError) {
        emitError(
          json,
          "STATE_COMPACT_WRITE_FAILED",
          `state compact --write failed during ${err.phase}: ${err.detail}`,
          {
            data: {
              phase_id: phaseId,
              phase: err.phase,
              partial_applied: err.partial_applied,
              // The pack path is always reported so an operator can locate the
              // file — critical for verify_pack+partial_applied (the bad pack is
              // on disk and Layer 2 does not auto-remove it).
              pack_path: eventPackPath(cwd, phaseId),
              ...(err.phase === "verify_pack" && err.partial_applied
                ? { next_action: "Inspect or remove the pack file, then rerun state compact." }
                : {}),
            },
          },
        );
        return 2;
      }
      throw err;
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
    else process.stdout.write(`${humanLine(phaseId, result)}\n`);
    return 0;
  };

  if (write) return withWriteLock(cwd, `state compact ${phaseId} --write`, json, runImpl);
  return runImpl();
}
