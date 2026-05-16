import { parseArgs } from "node:util";

export type GlobalArgv = {
  version?: boolean;
  help?: boolean;
  json?: boolean;
  locale?: string;
};

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
