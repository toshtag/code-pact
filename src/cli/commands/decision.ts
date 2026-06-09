// The CLI wrapper layer for the `decision` subcommand cluster (decision-record
// lifecycle). Routes `decision <subcommand>` to its handlers. JSON envelopes,
// exit codes, and error codes are part of the stable CLI contract.
//
// `cmdDecision` is the cluster-entry dispatch and is the only export.

import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { emitOk, emitError, withWriteLock } from "../util.ts";
import {
  runDecisionPrune,
  runDecisionPruneWrite,
  serializeDecisionPrune,
  serializeDecisionPruneWrite,
  serializeDecisionPruneWriteFailed,
  formatDecisionPruneHuman,
  formatDecisionPruneWriteHuman,
  notEligibleMessage,
  planStaleMessage,
  writeFailedMessage,
} from "../../commands/decision-prune.ts";

const PRUNE_HELP = `Usage: code-pact decision prune <path> [--write] [--json]

Retire a shipped, accepted decision record from the live plane. DRY-RUN BY
DEFAULT: it reports the eligibility verdict and the COMPLETE inbound-link rewrite
plan, and writes nothing. Pass --write to execute that plan: after a preflight
that writes nothing, append the design/decisions/PRUNED.md tombstone row, rewrite
each inbound link (README index row → tombstone, body link → delink), then delete
the record last. The target must be a readable, top-level, accepted
design/decisions/<name>.md record.

Eligible → exit 0 (dry-run reports the plan; --write applies it). Ineligible →
exit 2 with error code DECISION_PRUNE_NOT_ELIGIBLE and
every applicable failing gate under data.blocks[] (the link-rewrite gates are
evaluated once the target itself is a readable, accepted, top-level record). The
verdict is identical for dry-run and --write. If the working tree changes under
the plan, --write aborts with DECISION_PRUNE_PLAN_STALE (exit 2) and writes
nothing — re-run to rebuild.

Options:
  --write   Execute the plan (delete + rewrite links + append ledger), under the
            advisory write lock. Default is dry-run.
  --json    Emit the {ok,data} envelope. Dry-run data: mode, decision, eligible,
            blocks, referencing_tasks, plan, warnings. --write data: mode("write"),
            decision, removed_file, link_rewrites_applied, ledger_row, warnings.

Examples:
  code-pact decision prune design/decisions/foo-rfc.md
  code-pact decision prune design/decisions/foo-rfc.md --json
  code-pact decision prune design/decisions/foo-rfc.md --write --json`;

const GROUP_HELP = `Usage: code-pact decision <subcommand>

Subcommands:
  prune <path>   Retire an accepted decision record (dry-run; --write to apply).`;

function isHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv[0] === "help";
}

export async function cmdDecision(
  argv: string[],
  _locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);
  // Honor --json anywhere for cluster-level errors, like the other public
  // clusters — an agent that passed --json must still get a JSON envelope.
  const effectiveJson = globalJson || argv.includes("--json");

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(`${GROUP_HELP}\n`);
    return 0;
  }

  if (subcommand === "prune") {
    if (isHelp(rest)) {
      process.stdout.write(`${PRUNE_HELP}\n`);
      return 0;
    }

    let values: Record<string, unknown>;
    let positionals: string[];
    try {
      ({ values, positionals } = strictParse(
        "decision prune",
        rest,
        { json: { type: "boolean" }, write: { type: "boolean" } },
        { allowPositionals: true },
      ));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const json = globalJson || rest.includes("--json");
      emitError(json, "CONFIG_ERROR", err.message);
      return 2;
    }

    const json = globalJson || values.json === true;
    const write = values.write === true;
    const target = positionals[0];
    if (!target) {
      emitError(json, "CONFIG_ERROR", "decision prune requires a decision path (design/decisions/<name>.md)");
      return 2;
    }
    if (positionals.length > 1) {
      emitError(json, "CONFIG_ERROR", "decision prune takes exactly one decision path");
      return 2;
    }

    const cwd = process.cwd();

    if (write) {
      // --write mutates design/ — serialize behind the advisory write lock, like
      // every other destructive command. The verdict is rebuilt INSIDE the lock
      // so the plan reflects the tree at apply time.
      return withWriteLock(cwd, `decision prune ${target} --write`, json, async () => {
        const outcome = await runDecisionPruneWrite(cwd, target, { now: new Date() });
        if (outcome.kind === "ineligible") {
          emitError(json, "DECISION_PRUNE_NOT_ELIGIBLE", notEligibleMessage(outcome.dryRun, json), {
            data: serializeDecisionPrune(outcome.dryRun),
            human: formatDecisionPruneHuman(outcome.dryRun),
          });
          return 2;
        }
        if (outcome.kind === "stale") {
          emitError(json, "DECISION_PRUNE_PLAN_STALE", planStaleMessage(outcome.stale), {
            data: { mode: "write", decision: outcome.decision, stale: outcome.stale },
          });
          return 2;
        }
        if (outcome.kind === "write_failed") {
          emitError(json, "DECISION_PRUNE_WRITE_FAILED", writeFailedMessage(outcome), {
            data: serializeDecisionPruneWriteFailed(outcome),
          });
          return 2;
        }
        if (json) emitOk(serializeDecisionPruneWrite(outcome));
        else process.stdout.write(`${formatDecisionPruneWriteHuman(outcome)}\n`);
        return 0;
      });
    }

    const result = await runDecisionPrune(cwd, target);

    if (result.eligible) {
      if (json) emitOk(serializeDecisionPrune(result));
      else process.stdout.write(`${formatDecisionPruneHuman(result)}\n`);
      return 0;
    }

    emitError(json, "DECISION_PRUNE_NOT_ELIGIBLE", notEligibleMessage(result, json), {
      data: serializeDecisionPrune(result),
      human: formatDecisionPruneHuman(result),
    });
    return 2;
  }

  emitError(effectiveJson, "CONFIG_ERROR", `unknown decision subcommand: ${subcommand}`);
  return 2;
}
