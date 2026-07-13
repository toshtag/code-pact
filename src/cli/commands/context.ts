import { strictParse, ConfigError } from "../../lib/argv.ts";
import {
  clusterUsage,
  emitUsage,
  hasHelpFlag,
  isHelpToken,
  subcommandUsage,
} from "../usage.ts";
import { toParseOptions } from "../spec/render.ts";
import { CONTEXT_SPECS, CONTEXT_SPEC_ORDER } from "../spec/context.ts";
import { emitError, emitOk } from "../util.ts";
import type { Locale } from "../../i18n/index.ts";
import {
  findContextSection,
  runContextShow,
} from "../../commands/context-show.ts";

const PUBLIC_CONTEXT_SHOW_CODES = new Set([
  "INVALID_CONTEXT_REF",
  "CONTEXT_NOT_FOUND",
  "CONTEXT_INVALID",
  "CONTEXT_DIGEST_MISMATCH",
  "CONTEXT_PATH_UNSAFE",
  "CONTEXT_READ_FAILED",
  "CONFIG_ERROR",
]);

function mapContextShowError(error: unknown): {
  code: string;
  systemCode?: string;
  message: string;
} {
  const systemCode = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  if (systemCode && PUBLIC_CONTEXT_SHOW_CODES.has(systemCode)) {
    return { code: systemCode, message };
  }
  return {
    code: "CONTEXT_READ_FAILED",
    ...(systemCode ? { systemCode } : {}),
    message,
  };
}

export async function cmdContext(
  argv: string[],
  _locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("context"));
  }
  if (hasHelpFlag(rest)) {
    return emitUsage(subcommandUsage("context", subcommand));
  }
  if (subcommand === "show") return cmdContextShow(rest, globalJson);

  emitError(
    globalJson,
    "CONFIG_ERROR",
    `context: unknown subcommand "${subcommand}". Use: ${CONTEXT_SPEC_ORDER.join(" | ")}`,
  );
  return 2;
}

async function cmdContextShow(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "context show",
      argv,
      toParseOptions(CONTEXT_SPECS.show),
      { allowPositionals: true },
    ));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", error.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  if (positionals.length !== 1) {
    emitError(
      json,
      "CONFIG_ERROR",
      positionals.length === 0
        ? "context show requires a context ref (e.g. context:sha256:<digest>)."
        : "context show accepts exactly one context ref.",
    );
    return 2;
  }
  if (values.list === true && typeof values.section === "string") {
    emitError(
      json,
      "CONFIG_ERROR",
      "context show: --list and --section are mutually exclusive.",
    );
    return 2;
  }

  const ref = positionals[0]!;
  try {
    const result = await runContextShow(process.cwd(), ref);
    if (typeof values.section === "string") {
      const sectionName = values.section;
      const section = findContextSection(result, sectionName);
      if (!section) {
        emitError(json, "CONFIG_ERROR", `context show: unknown section "${sectionName}".`, {
          data: { available_sections: result.sections.map(item => item.name) },
        });
        return 2;
      }
      if (json) {
        emitOk({
          context_ref: result.context_ref,
          digest: result.digest,
          section,
        });
      } else {
        process.stdout.write(section.content);
      }
      return 0;
    }

    if (values.list === true) {
      const sections = result.sections.map(section => ({
        name: section.name,
        bytes: section.bytes,
        content_sha256: section.content_sha256,
      }));
      if (json) {
        emitOk({
          context_ref: result.context_ref,
          digest: result.digest,
          schema_version: result.schema_version,
          sections,
          total_deferred_bytes: result.total_deferred_bytes,
        });
      } else {
        for (const section of sections) {
          process.stdout.write(
            `${section.name}\t${section.bytes}\t${section.content_sha256}\n`,
          );
        }
      }
      return 0;
    }

    if (json) {
      emitOk({
        context_ref: result.context_ref,
        digest: result.digest,
        schema_version: result.schema_version,
        section_count: result.sections.length,
        total_deferred_bytes: result.total_deferred_bytes,
      });
    } else {
      process.stdout.write(
        [
          `Reference: ${result.context_ref}`,
          `Schema version: ${result.schema_version}`,
          `Section count: ${result.sections.length}`,
          `Total deferred bytes: ${result.total_deferred_bytes}`,
        ].join("\n") + "\n",
      );
    }
    return 0;
  } catch (error) {
    const mapped = mapContextShowError(error);
    const exit =
      mapped.code === "INVALID_CONTEXT_REF" || mapped.code === "CONFIG_ERROR"
        ? 2
        : 1;
    emitError(
      json,
      mapped.code,
      mapped.message,
      mapped.systemCode ? { data: { system_code: mapped.systemCode } } : {},
    );
    return exit;
  }
}
