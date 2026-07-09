// The CLI wrapper layer for the `decision` subcommand cluster (decision-record
// lifecycle). Routes `decision <subcommand>` to its handlers. JSON envelopes,
// exit codes, and error codes are part of the stable CLI contract.
//
// `cmdDecision` is the cluster-entry dispatch and is the only export.

import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { emitOk, emitError, withWriteLock } from "../util.ts";
import { clusterUsage, emitUsage, subcommandUsage } from "../usage.ts";
import { DECISION_SPECS, DECISION_SPEC_ORDER } from "../spec/decision.ts";
import { toParseOptions } from "../spec/render.ts";
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
    return emitUsage(clusterUsage("decision"));
  }

  if (subcommand === "prune") {
    if (isHelp(rest)) {
      return emitUsage(subcommandUsage("decision", "prune"));
    }

    let values: Record<string, unknown>;
    let positionals: string[];
    try {
      ({ values, positionals } = strictParse(
        "decision prune",
        rest,
        toParseOptions(DECISION_SPECS.prune),
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
      emitError(json, "CONFIG_ERROR", "decision prune requires a decision path (design/decisions/<path>.md)");
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
      return emitUsage(subcommandUsage("decision", "retire"));
    }

    let values: Record<string, unknown>;
    let positionals: string[];
    try {
      ({ values, positionals } = strictParse(
        "decision retire",
        rest,
        toParseOptions(DECISION_SPECS.retire),
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
      emitError(json, "CONFIG_ERROR", "decision retire requires a decision path (design/decisions/<path>.md)");
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

  emitError(effectiveJson, "CONFIG_ERROR", `unknown decision subcommand: ${subcommand}. Use: ${DECISION_SPEC_ORDER.join(" | ")}`);
  return 2;
}
