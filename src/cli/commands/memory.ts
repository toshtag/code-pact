import { strictParse, ConfigError } from "../../lib/argv.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { toParseOptions } from "../spec/render.ts";
import { MEMORY_SPECS, MEMORY_SPEC_ORDER } from "../spec/memory.ts";
import { emitError, emitOk } from "../util.ts";
import type { Locale } from "../../i18n/index.ts";
import { formatMemoryStatus, runMemoryStatus } from "../../commands/memory-status.ts";
import { formatMemoryPrune, runMemoryPrune } from "../../commands/memory-prune.ts";

export async function cmdMemory(
  argv: string[],
  _locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("memory"));
  }
  if (hasHelpFlag(rest)) {
    return emitUsage(subcommandUsage("memory", subcommand));
  }
  if (subcommand === "status") return cmdMemoryStatus(rest, globalJson);
  if (subcommand === "prune") return cmdMemoryPrune(rest, globalJson);

  emitError(
    globalJson,
    "CONFIG_ERROR",
    `memory: unknown subcommand "${subcommand}". Use: ${MEMORY_SPEC_ORDER.join(" | ")}`,
  );
  return 2;
}

async function cmdMemoryStatus(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
  let values: Record<string, unknown>;
  try {
    ({ values } = strictParse(
      "memory status",
      argv,
      toParseOptions(MEMORY_SPECS.status),
    ));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", error.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const result = await runMemoryStatus(process.cwd());
  if (json) {
    emitOk(result);
  } else {
    process.stdout.write(`${formatMemoryStatus(result)}\n`);
  }
  return 0;
}

async function cmdMemoryPrune(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
  let values: Record<string, unknown>;
  try {
    ({ values } = strictParse(
      "memory prune",
      argv,
      toParseOptions(MEMORY_SPECS.prune),
    ));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", error.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const result = await runMemoryPrune(process.cwd(), {
    write: values.write === true,
  });
  if (json) {
    emitOk(result);
  } else {
    process.stdout.write(`${formatMemoryPrune(result)}\n`);
  }
  return 0;
}
