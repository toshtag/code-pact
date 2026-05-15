#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { messages, type Locale } from "./i18n/index.ts";
import { runInit, type SupportedAgent } from "./commands/init.ts";
import type { LocaleCode } from "./core/schemas/locale.ts";

const KNOWN_LOCALES: ReadonlySet<Locale> = new Set(["en-US", "ja-JP"]);
const KNOWN_AGENTS: ReadonlySet<SupportedAgent> = new Set(["claude-code", "codex"]);

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

type GlobalValues = {
  version?: boolean;
  help?: boolean;
  json?: boolean;
  locale?: string;
};

type ParsedCli = {
  values: GlobalValues;
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
      // init flags
      agent: { type: "string" },
      force: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });
  return { values: values as GlobalValues, positionals };
}

// ---------------------------------------------------------------------------
// Command: init
// ---------------------------------------------------------------------------

async function cmdInit(
  argv: string[],
  locale: Locale,
  json: boolean,
): Promise<number> {
  const m = messages[locale];

  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      locale: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const agentRaw = (values.agent as string | undefined) ?? "claude-code";
  const agents: SupportedAgent[] = agentRaw
    .split(",")
    .map((a) => a.trim())
    .filter((a): a is SupportedAgent => KNOWN_AGENTS.has(a as SupportedAgent));

  if (agents.length === 0) {
    const msg = `Unknown agent(s): ${agentRaw}. Supported: ${[...KNOWN_AGENTS].join(", ")}`;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const initLocale: LocaleCode =
    typeof values.locale === "string" && KNOWN_LOCALES.has(values.locale as Locale)
      ? (values.locale as LocaleCode)
      : locale;

  const cwd = process.cwd();

  try {
    const result = await runInit({
      cwd,
      locale: initLocale,
      agents,
      force: values.force === true,
      json,
    });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      for (const f of result.created) {
        process.stderr.write(`  created  ${f}\n`);
      }
      for (const f of result.skipped) {
        process.stderr.write(`  skipped  ${f} (already exists)\n`);
      }
      process.stderr.write(`\n${m.init.done}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const isAlreadyInit =
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "ALREADY_INITIALIZED";

    if (isAlreadyInit) {
      const msg = m.init.alreadyInitialized(cwd);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values, positionals } = parse(process.argv.slice(2));
  const locale: Locale =
    values.locale && KNOWN_LOCALES.has(values.locale as Locale)
      ? (values.locale as Locale)
      : detectLocale();
  const m = messages[locale];
  const json = values.json === true;

  if (values.version) {
    const version = await readPackageVersion();
    if (json) {
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
  const rest = process.argv.slice(3); // args after the command name

  switch (command) {
    case "init":
      return cmdInit(rest, locale, json);

    default: {
      if (json) {
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
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`internal error: ${msg}\n`);
    process.exit(3);
  },
);
