// The CLI wrapper layer for the `spec` subcommand cluster (the Spec Kit
// bridge). Routes `spec <subcommand>` to its handlers. JSON envelopes,
// exit codes, error codes, and flag surfaces are part of the stable CLI
// contract.
//
// `cmdSpec` is the cluster-entry dispatch and is the only export.

import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import {
  runSpecImport,
  runSpecSuggest,
  SpecImportError,
} from "../../commands/spec-import.ts";
import { type SpecImportDetail } from "../../contracts/spec-import-details.ts";
import { emitOk, emitError } from "../util.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { SPEC_SPECS, SPEC_SPEC_ORDER } from "../spec/spec.ts";
import { toParseOptions } from "../spec/render.ts";

export async function cmdSpec(argv: string[], _locale: Locale, globalJson: boolean): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("spec"));
  }

  if (subcommand === "import") {
    if (isHelpToken(rest[0]) || hasHelpFlag(rest)) {
      return emitUsage(subcommandUsage("spec", "import"));
    }

    let values: Record<string, unknown>;
    try {
      ({ values } = strictParse(
        "spec import",
        rest,
        toParseOptions(SPEC_SPECS.import),
        { allowPositionals: false },
      ));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const json = globalJson || rest.includes("--json");
      emitError(json, "CONFIG_ERROR", err.message);
      return 2;
    }

    const json = globalJson || values.json === true;
    const fromPath = typeof values.from === "string" ? values.from : "";
    const suggestFromPath = typeof values["suggest-from"] === "string" ? (values["suggest-from"] as string) : "";
    const phaseId = typeof values["phase-id"] === "string" ? (values["phase-id"] as string) : "";
    const write = values.write === true;
    const force = values.force === true;
    const cwd = process.cwd();

    if (fromPath && suggestFromPath) {
      const msg = "spec import: --from and --suggest-from are mutually exclusive";
      emitError(json, "CONFIG_ERROR", msg, {
        data: { detail: "mutex_violation" satisfies SpecImportDetail, source_path: null, phase_id: null },
      });
      return 2;
    }

    if (suggestFromPath) {
      try {
        const result = await runSpecSuggest({ cwd, suggestFromPath });
        if (json) {
          emitOk(result);
        } else {
          const briefKeys = Object.keys(result.brief_candidates);
          const constKeys = Object.keys(result.constitution_candidates);
          process.stderr.write(
            `Read ${suggestFromPath}: ${briefKeys.length} brief candidate(s), ${constKeys.length} constitution candidate(s), ${result.skipped_sections.length} skipped section(s).\n`,
          );
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        return 0;
      } catch (err) {
        if (err instanceof SpecImportError) {
          emitError(json, "CONFIG_ERROR", err.message, {
            data: {
              detail: err.detail,
              source_path: err.sourcePath ?? null,
              phase_id: null,
            },
          });
          return 2;
        }
        throw err;
      }
    }

    if (!fromPath) {
      const msg = "spec import requires --from <path> or --suggest-from <path>";
      emitError(json, "CONFIG_ERROR", msg);
      return 2;
    }
    if (!phaseId) {
      const msg = "spec import requires --phase-id <id> for the generated phase";
      emitError(json, "CONFIG_ERROR", msg, {
        data: { detail: "missing_phase_id" satisfies SpecImportDetail, source_path: fromPath, phase_id: null },
      });
      return 2;
    }

    try {
      const result = await runSpecImport({ cwd, fromPath, phaseId, write, force });
      if (json) {
        emitOk(result);
      } else {
        if (result.kind === "imported") {
          process.stderr.write(
            `Imported ${result.tasks_imported} task(s) from ${result.sections_imported} section(s) into ${result.output_path}.\n`,
          );
        } else {
          process.stderr.write(
            `Would import ${result.tasks_imported} task(s) from ${result.sections_imported} section(s). Re-run with --write to persist.\n`,
          );
          process.stdout.write(result.phase_yaml);
        }
        if (result.warnings.length > 0) {
          for (const w of result.warnings) {
            process.stderr.write(`  warning: ${w}\n`);
          }
        }
      }
      return 0;
    } catch (err) {
      if (err instanceof SpecImportError) {
        emitError(json, "CONFIG_ERROR", err.message, {
          data: {
            detail: err.detail,
            source_path: err.sourcePath ?? null,
            phase_id: err.phaseId ?? null,
          },
        });
        return 2;
      }
      throw err;
    }
  }

  const msg = `spec: unknown subcommand "${subcommand ?? ""}". Use: ${SPEC_SPEC_ORDER.join(" | ")}`;
  emitError(globalJson, "CONFIG_ERROR", msg);
  return 2;
}
