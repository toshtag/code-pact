// Extracted from src/cli.ts (v1.17.1). The CLI wrapper layer for the
// `spec` subcommand cluster (P18 — Spec Kit bridge). Routes
// `spec <subcommand>` to its handlers. JSON envelopes, exit codes,
// error codes, and flag surfaces are byte-identical to v1.17.
//
// `cmdSpec` is the cluster-entry dispatch and is the only export.

import { strictParse, ConfigError } from "../../lib/argv.ts";
import { type Locale } from "../../i18n/index.ts";
import {
  runSpecImport,
  runSpecSuggest,
  SpecImportError,
} from "../../commands/spec-import.ts";

export async function cmdSpec(argv: string[], _locale: Locale, globalJson: boolean): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === "import") {
    let values: Record<string, unknown>;
    try {
      ({ values } = strictParse(
        "spec import",
        rest,
        {
          from: { type: "string" },
          "suggest-from": { type: "string" },
          "phase-id": { type: "string" },
          write: { type: "boolean" },
          force: { type: "boolean" },
          json: { type: "boolean" },
        },
        { allowPositionals: false },
      ));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const json = globalJson || rest.includes("--json");
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: err.message } })}\n`,
        );
      } else {
        process.stderr.write(`${err.message}\n`);
      }
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
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "CONFIG_ERROR", message: msg },
            data: { detail: "mutex_violation", source_path: null, phase_id: null },
          })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    if (suggestFromPath) {
      try {
        const result = await runSpecSuggest({ cwd, suggestFromPath });
        if (json) {
          process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
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
          if (json) {
            process.stdout.write(
              `${JSON.stringify({
                ok: false,
                error: { code: "CONFIG_ERROR", message: err.message },
                data: {
                  detail: err.detail,
                  source_path: err.sourcePath ?? null,
                  phase_id: null,
                },
              })}\n`,
            );
          } else {
            process.stderr.write(`${err.message}\n`);
          }
          return 2;
        }
        throw err;
      }
    }

    if (!fromPath) {
      const msg = "spec import requires --from <path> or --suggest-from <path>";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    if (!phaseId) {
      const msg = "spec import requires --phase-id <id> for the generated phase";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "CONFIG_ERROR", message: msg },
            data: { detail: "missing_phase_id", source_path: fromPath, phase_id: null },
          })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    try {
      const result = await runSpecImport({ cwd, fromPath, phaseId, write, force });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
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
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: { code: "CONFIG_ERROR", message: err.message },
              data: {
                detail: err.detail,
                source_path: err.sourcePath ?? null,
                phase_id: err.phaseId ?? null,
              },
            })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      throw err;
    }
  }

  const msg = `spec: unknown subcommand "${subcommand ?? ""}". Use: import`;
  if (globalJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}
