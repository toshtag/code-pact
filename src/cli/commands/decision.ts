// The CLI wrapper layer for the `decision` subcommand cluster (decision-record
// lifecycle). Routes `decision <subcommand>` to its handlers. JSON envelopes,
// exit codes, and error codes are part of the stable CLI contract.
//
// `cmdDecision` is the cluster-entry dispatch and is the only export.

import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { emitOk, emitError, withWriteLock } from "../util.ts";
import { DECISION_RETENTION_VALUES, type DecisionRetention } from "../../core/schemas/project.ts";
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
import { runDecisionRetire } from "../../commands/decision-retire.ts";

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
verdict is identical for dry-run and --write. If the tree no longer matches the
plan BEFORE the commit starts, --write aborts with DECISION_PRUNE_PLAN_STALE
(exit 2) and writes nothing. Drift or an I/O failure DURING the commit returns
DECISION_PRUNE_WRITE_FAILED (exit 2) with data.phase and data.partial_applied.

Options:
  --write   Execute the plan under the advisory write lock, in least-harmful order:
            append/verify the PRUNED.md ledger first, rewrite inbound links, then
            delete the record last. Default is dry-run.
  --policy <v>  Override the project's decision_retention for this invocation:
            keep-full | compress-on-ship | prune-on-ship. Surfaced in the envelope
            as data.policy / data.policy_source; does not change what is pruned.
  --json    Emit the {ok,data} envelope. Dry-run data: mode, decision, eligible,
            blocks, referencing_tasks, plan, policy, policy_source, warnings.
            --write data: mode("write"), decision, removed_file,
            link_rewrites_applied, ledger_row, ledger_action, policy, policy_source,
            warnings.

Examples:
  code-pact decision prune design/decisions/foo-rfc.md
  code-pact decision prune design/decisions/foo-rfc.md --json
  code-pact decision prune design/decisions/foo-rfc.md --write --json`;

const RETIRE_HELP = `Usage: code-pact decision retire <path> [--write] [--json]

Retire a decision of ANY status: write its decision-state record durably,
then delete the design/decisions/<name>.md. DRY-RUN BY DEFAULT — it reports the
eligibility verdict and writes nothing. Pass --write to apply.

Unlike \`decision prune\` (accepted-only, appends PRUNED.md, rewrites links),
\`decision retire\` accepts any status (accepted → the record may satisfy an active
gate; non-accepted → a tombstone that NEVER releases a gate), writes NO PRUNED row,
and rewrites NO inbound links — a link to the deleted .md resolves as retired via
the record (check:docs stays green). It refuses (DECISION_RETIRE_NOT_ELIGIBLE,
exit 2) when an active task still needs the decision in a way the record can't
carry (a non-accepted decision_refs gate, or any filename-scan gate), or any
integrity gate fails (open commitments, a live decision dependant, an unreadable
scan). On --write it writes the record, readback-verifies it, re-checks the
external state immediately before deleting, and refuses with DECISION_RETIRE_STALE
(exit 2, data.reason) on any drift — the .md is never deleted on a refusal.

Options:
  --write   Write the record then delete the .md under the advisory write lock,
            in least-harmful order (record durable + readback-verified BEFORE the
            delete; delete last). Default is dry-run.
  --json    Emit the {ok,data} envelope.

Examples:
  code-pact decision retire design/decisions/foo-rfc.md
  code-pact decision retire design/decisions/foo-rfc.md --json
  code-pact decision retire design/decisions/foo-rfc.md --write --json`;

const GROUP_HELP = `Usage: code-pact decision <subcommand>

Subcommands:
  prune <path>    Retire an accepted decision record + rewrite links (dry-run; --write).
  retire <path>   Retire a decision of ANY status to a durable record, then delete it
                  (dry-run; --write to apply).`;

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
        { json: { type: "boolean" }, write: { type: "boolean" }, policy: { type: "string" } },
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
    let policyOverride: DecisionRetention | undefined;
    if (values.policy !== undefined) {
      if (!(DECISION_RETENTION_VALUES as readonly string[]).includes(values.policy as string)) {
        emitError(json, "CONFIG_ERROR", `--policy must be one of: ${DECISION_RETENTION_VALUES.join(" | ")}`);
        return 2;
      }
      policyOverride = values.policy as DecisionRetention;
    }

    const cwd = process.cwd();

    if (write) {
      // --write mutates design/ — serialize behind the advisory write lock, like
      // every other destructive command. The verdict is rebuilt INSIDE the lock
      // so the plan reflects the tree at apply time.
      return withWriteLock(cwd, `decision prune ${target} --write`, json, async () => {
        const outcome = await runDecisionPruneWrite(cwd, target, { now: new Date(), policyOverride });
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

    const result = await runDecisionPrune(cwd, target, { policyOverride });

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

  if (subcommand === "retire") {
    if (isHelp(rest)) {
      process.stdout.write(`${RETIRE_HELP}\n`);
      return 0;
    }

    let values: Record<string, unknown>;
    let positionals: string[];
    try {
      ({ values, positionals } = strictParse(
        "decision retire",
        rest,
        { json: { type: "boolean" }, write: { type: "boolean" } },
        { allowPositionals: true },
      ));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      emitError(globalJson || rest.includes("--json"), "CONFIG_ERROR", err.message);
      return 2;
    }

    const json = globalJson || values.json === true;
    const write = values.write === true;
    const target = positionals[0];
    if (!target) {
      emitError(json, "CONFIG_ERROR", "decision retire requires a decision path (design/decisions/<name>.md)");
      return 2;
    }
    if (positionals.length > 1) {
      emitError(json, "CONFIG_ERROR", "decision retire takes exactly one decision path");
      return 2;
    }

    const cwd = process.cwd();
    const runImpl = async (): Promise<number> => {
      const r = await runDecisionRetire({ cwd, path: target, write, now: new Date() });
      switch (r.kind) {
        case "would_retire":
        case "would_already_retired":
        case "retired":
        case "already_retired":
          if (json) {
            emitOk(r);
          } else {
            const line =
              r.kind === "would_retire"
                ? `Dry run: would retire ${r.decision} (write its record, then delete the .md). Run with --write to apply.`
                : r.kind === "retired"
                  ? `Retired ${r.decision}: decision-state record written, design/decisions .md deleted.`
                  : r.kind === "would_already_retired"
                    ? `${r.decision} is already retired (its .md is gone and a valid record resolves it). Nothing to do.`
                    : `${r.decision} is already retired. Nothing to do.`;
            process.stdout.write(`${line}\n`);
          }
          return 0;
        case "ineligible":
          emitError(json, "DECISION_RETIRE_NOT_ELIGIBLE", `decision "${target}" cannot be retired yet`, {
            data: { decision: r.decision, blocks: r.blocks },
          });
          return 2;
        case "not_retired":
          emitError(json, "DECISION_RETIRE_NOT_RETIRED", `decision "${target}" is missing and no valid record resolves it: ${r.reason}`, {
            data: { decision: r.decision, reason: r.reason },
          });
          return 2;
        case "stale":
          emitError(json, "DECISION_RETIRE_STALE", `decision "${target}" retire refused: ${r.detail}`, {
            data: { decision: r.decision, reason: r.reason, detail: r.detail },
          });
          return 2;
      }
    };

    if (write) {
      return withWriteLock(cwd, `decision retire ${target} --write`, json, runImpl);
    }
    return runImpl();
  }

  emitError(effectiveJson, "CONFIG_ERROR", `unknown decision subcommand: ${subcommand}`);
  return 2;
}
