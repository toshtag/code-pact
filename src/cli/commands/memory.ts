import { strictParse, ConfigError } from "../../lib/argv.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { toParseOptions } from "../spec/render.ts";
import { MEMORY_SPECS, MEMORY_SPEC_ORDER } from "../spec/memory.ts";
import { emitError, emitOk } from "../util.ts";
import type { Locale } from "../../i18n/index.ts";
import { formatMemoryStatus, runMemoryStatus } from "../../commands/memory-status.ts";
import { formatMemoryPrune, runMemoryPrune } from "../../commands/memory-prune.ts";

type MemoryOperation = "status" | "prune";

function memoryError(
  error: unknown,
  operation: MemoryOperation,
): {
  code: "MEMORY_PATH_UNSAFE" | "MEMORY_READ_FAILED" | "MEMORY_PRUNE_CONFLICT" | "MEMORY_PRUNE_FAILED";
  message: string;
  data?: { system_code?: string; partial_applied?: boolean; deleted_count?: number };
  human?: string;
} {
  const systemCode = (error as NodeJS.ErrnoException).code;
  if (systemCode === "PATH_NOT_OWNED" || systemCode === "PATH_OUTSIDE_PROJECT") {
    return {
      code: "MEMORY_PATH_UNSAFE",
      message: "Local loop-memory cache path is unsafe.",
      data: { system_code: systemCode },
    };
  }
  if (systemCode === "MEMORY_PRUNE_CONFLICT") {
    const partialApplied =
      (error as NodeJS.ErrnoException & { partial_applied?: boolean }).partial_applied === true;
    const deletedCount =
      (error as NodeJS.ErrnoException & { deleted_count?: number }).deleted_count ?? 0;
    return {
      code: "MEMORY_PRUNE_CONFLICT",
      message: "Local loop-memory retention candidates changed before deletion.",
      data: { partial_applied: partialApplied, deleted_count: deletedCount },
      ...(partialApplied
        ? {
            human:
              "Local loop-memory retention candidates changed after pruning started.\nRun:\ncode-pact memory status\ncode-pact memory prune",
          }
        : {}),
    };
  }
  if (systemCode === "MEMORY_PRUNE_FAILED") {
    const partialApplied =
      (error as NodeJS.ErrnoException & { partial_applied?: boolean }).partial_applied === true;
    const deletedCount =
      (error as NodeJS.ErrnoException & { deleted_count?: number }).deleted_count ?? 0;
    const underlyingSystemCode = (error as NodeJS.ErrnoException & { system_code?: string })
      .system_code;
    return {
      code: "MEMORY_PRUNE_FAILED",
      message: "Local loop-memory cache could not be pruned.",
      data: {
        partial_applied: partialApplied,
        deleted_count: deletedCount,
        ...(underlyingSystemCode !== undefined
          ? { system_code: underlyingSystemCode }
          : {}),
      },
      ...(partialApplied
        ? {
            human:
              "Local loop-memory pruning failed after deleting some entries.\nRun:\ncode-pact memory status\ncode-pact memory prune",
          }
        : {}),
    };
  }
  if (operation === "status") {
    return {
      code: "MEMORY_READ_FAILED",
      message: "Local loop-memory cache could not be read.",
      ...(systemCode !== undefined ? { data: { system_code: systemCode } } : {}),
    };
  }
  return {
    code: "MEMORY_PRUNE_FAILED",
    message: "Local loop-memory cache could not be pruned.",
    ...(systemCode !== undefined ? { data: { system_code: systemCode } } : {}),
  };
}

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
  let result;
  try {
    result = await runMemoryStatus(process.cwd());
  } catch (error) {
    const mapped = memoryError(error, "status");
    emitError(json, mapped.code, mapped.message, { data: mapped.data });
    return 1;
  }
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
  let result;
  try {
    result = await runMemoryPrune(process.cwd(), {
      write: values.write === true,
    });
  } catch (error) {
    const mapped = memoryError(error, "prune");
    emitError(json, mapped.code, mapped.message, {
      data: mapped.data,
      human: mapped.human,
    });
    return 1;
  }
  if (json) {
    emitOk(result);
  } else {
    process.stdout.write(`${formatMemoryPrune(result)}\n`);
  }
  return 0;
}
