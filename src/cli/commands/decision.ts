// The CLI wrapper layer for the `decision` subcommand cluster (decision-record
// lifecycle). Routes `decision <subcommand>` to its handlers. JSON envelopes,
// exit codes, and error codes are part of the stable CLI contract.
//
// `cmdDecision` is the cluster-entry dispatch and is the only export.

import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import { emitOk, emitError } from "../util.ts";
import {
  runDecisionPrune,
  serializeDecisionPrune,
  formatDecisionPruneHuman,
  notEligibleMessage,
} from "../../commands/decision-prune.ts";

const PRUNE_HELP = `code-pact decision prune <path> [--json]

Preview retiring a shipped (accepted) decision record from the live plane
(DRY-RUN ONLY — never deletes or rewrites anything yet).

Runs the prune eligibility verdict and prints what \`--write\` would do. The
target must be a readable, top-level, accepted design/decisions/<name>.md record.
Eligible exits 0; ineligible exits 2 with DECISION_PRUNE_NOT_ELIGIBLE and the
full block list under data.blocks (--json).

  --json    Emit the {ok,data} envelope (data: decision, eligible, blocks,
            referencing_tasks, plan, warnings).`;

const GROUP_HELP = `code-pact decision <subcommand>

  prune <path>   Preview retiring an accepted decision record (dry-run).`;

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
        { json: { type: "boolean" } },
        { allowPositionals: true },
      ));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const json = globalJson || rest.includes("--json");
      emitError(json, "CONFIG_ERROR", err.message);
      return 2;
    }

    const json = globalJson || values.json === true;
    const target = positionals[0];
    if (!target) {
      emitError(json, "CONFIG_ERROR", "decision prune requires a decision path (design/decisions/<name>.md)");
      return 2;
    }
    if (positionals.length > 1) {
      emitError(json, "CONFIG_ERROR", "decision prune takes exactly one decision path");
      return 2;
    }

    const result = await runDecisionPrune(process.cwd(), target);

    if (result.eligible) {
      if (json) emitOk(serializeDecisionPrune(result));
      else process.stdout.write(`${formatDecisionPruneHuman(result)}\n`);
      return 0;
    }

    emitError(json, "DECISION_PRUNE_NOT_ELIGIBLE", notEligibleMessage(result), {
      data: serializeDecisionPrune(result),
      human: formatDecisionPruneHuman(result),
    });
    return 2;
  }

  emitError(globalJson, "CONFIG_ERROR", `unknown decision subcommand: ${subcommand}`);
  return 2;
}
