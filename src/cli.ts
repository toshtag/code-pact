#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { messages, type Locale } from "./i18n/index.ts";

const KNOWN_LOCALES: ReadonlySet<Locale> = new Set(["en-US", "ja-JP"]);

function detectLocale(): Locale {
  const env = process.env.CODE_PACT_LOCALE ?? process.env.LANG ?? "";
  if (env.startsWith("ja")) return "ja-JP";
  return "en-US";
}

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

type ParsedCli = {
  values: { version?: boolean; help?: boolean; json?: boolean; locale?: string };
  positionals: string[];
};

function parse(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      locale: { type: "string" },
    },
    strict: false,
    allowPositionals: true,
  });
  return { values: values as ParsedCli["values"], positionals };
}

async function main(): Promise<number> {
  const { values, positionals } = parse(process.argv.slice(2));
  const locale: Locale =
    values.locale && KNOWN_LOCALES.has(values.locale as Locale)
      ? (values.locale as Locale)
      : detectLocale();
  const m = messages[locale];

  if (values.version) {
    const version = await readPackageVersion();
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { version } })}\n`);
    } else {
      process.stdout.write(`${version}\n`);
    }
    return 0;
  }

  if (values.help || positionals.length === 0) {
    process.stdout.write(`${m.usage}\n`);
    return 0;
  }

  const command = positionals[0];
  if (values.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: { code: "UNKNOWN_COMMAND", message: m.unknownCommand(command ?? "") },
      })}\n`,
    );
  } else {
    process.stderr.write(`${m.unknownCommand(command ?? "")}\n`);
  }
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`internal error: ${msg}\n`);
    process.exit(3);
  },
);
