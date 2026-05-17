import { parseArgs, type ParseArgsConfig } from "node:util";

export type GlobalArgv = {
  version?: boolean;
  help?: boolean;
  json?: boolean;
  locale?: string;
};

/**
 * Thrown by strictParse when an unknown option, malformed flag, or
 * unexpected positional is encountered. Callers convert this to a
 * CONFIG_ERROR JSON envelope (or stderr message).
 *
 * The originating command name is included as a prefix in `message` so
 * users see e.g. "phase ls: Unknown option '--bogus'".
 */
export class ConfigError extends Error {
  readonly code = "CONFIG_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type StrictParseOptions = NonNullable<ParseArgsConfig["options"]>;

/**
 * Wrapper around node:util parseArgs that runs in strict mode and
 * normalizes failures to ConfigError. The label is prepended to the
 * error message so output looks like "phase ls: Unknown option ...".
 *
 * Callers should catch ConfigError, build the JSON envelope using the
 * effective JSON flag (`globalJson || rawArgs.includes("--json")`), and
 * return exit code 2.
 */
export function strictParse<T extends Record<string, unknown>>(
  label: string,
  args: string[],
  options: StrictParseOptions,
  opts: { allowPositionals?: boolean } = {},
): { values: T; positionals: string[] } {
  try {
    const result = parseArgs({
      args,
      options,
      strict: true,
      allowPositionals: opts.allowPositionals ?? false,
    });
    return {
      values: result.values as T,
      positionals: result.positionals as string[],
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`${label}: ${detail}`);
  }
}

export function splitArgv(argv: string[]): {
  globalValues: GlobalArgv;
  command: string | undefined;
  rest: string[];
} {
  const cmdIdx = argv.findIndex((a) => !a.startsWith("-"));
  const globalArgs = cmdIdx >= 0 ? argv.slice(0, cmdIdx) : argv;
  const command = cmdIdx >= 0 ? argv[cmdIdx] : undefined;
  const rest = cmdIdx >= 0 ? argv.slice(cmdIdx + 1) : [];

  const { values } = parseArgs({
    args: globalArgs,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      locale: { type: "string" },
    },
    strict: false,
    allowPositionals: false,
  });

  return { globalValues: values as GlobalArgv, command, rest };
}
