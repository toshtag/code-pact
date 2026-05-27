// Extracted from src/cli.ts (v1.17.1). The CLI wrapper layer for the
// `plan` subcommand cluster. Routes `plan <subcommand>` to the
// per-subcommand handlers defined below. JSON envelopes, exit codes,
// error codes, and flag surfaces are byte-identical to v1.17.
//
// `cmdPlan` is the cluster-entry dispatch and is the only export.
// The per-subcommand handlers (cmdPlanBrief, cmdPlanLint, etc.) are
// private to this module.

import { parseArgs } from "node:util";
import { strictParse, ConfigError } from "../../lib/argv.ts";
import { cmdPhaseImport } from "./phase.ts";
import { withWriteLock } from "../util.ts";
import { isInteractive } from "../../lib/tty.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { runPlanAdopt, PlanAdoptError } from "../../commands/plan-adopt.ts";
import {
  type BriefAnswers,
  loadBriefFromFile,
  loadBriefFromStdin,
  PlanBriefFromFileError,
  PlanBriefFromStdinError,
  runPlanBrief,
} from "../../commands/plan-brief.ts";
import { runPlanPrompt } from "../../commands/plan-prompt.ts";
import {
  type ConstitutionAnswers,
  loadConstitutionFromFile,
  loadConstitutionFromStdin,
  PlanConstitutionFromFileError,
  PlanConstitutionFromStdinError,
  runPlanConstitution,
} from "../../commands/plan-constitution.ts";
import {
  formatPlanLintHuman,
  runPlanLint,
  serializePlanLintData,
} from "../../commands/plan-lint.ts";
import {
  formatPlanNormalizeHuman,
  runPlanNormalize,
  serializePlanNormalizeData,
} from "../../commands/plan-normalize.ts";
import {
  formatPlanAnalyzeHuman,
  runPlanAnalyze,
  serializePlanAnalyzeData,
} from "../../commands/plan-analyze.ts";

export async function cmdPlan(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === "brief") {
    return cmdPlanBrief(rest, locale, globalJson);
  }

  if (subcommand === "prompt") {
    return cmdPlanPrompt(rest, locale, globalJson);
  }

  if (subcommand === "adopt") {
    return cmdPlanAdopt(rest, globalJson);
  }

  if (subcommand === "constitution") {
    return cmdPlanConstitution(rest, locale, globalJson);
  }

  if (subcommand === "lint") {
    return cmdPlanLint(rest, locale, globalJson);
  }

  if (subcommand === "normalize") {
    return cmdPlanNormalize(rest, locale, globalJson);
  }

  if (subcommand === "analyze") {
    return cmdPlanAnalyze(rest, locale, globalJson);
  }

  // `plan import` is a beginner-friendly alias for `phase import` (it ingests a
  // whole multi-phase roadmap, which "phase import" undersells). Shares the
  // same handler; the invoked name labels its error messages. See
  // design/decisions/cli-alias-ux-rfc.md.
  if (subcommand === "import") {
    return cmdPhaseImport(rest, locale, globalJson, "plan import");
  }

  const msg = `plan: unknown subcommand "${subcommand ?? ""}". Use: brief | prompt | adopt | constitution | lint | normalize | analyze | import (alias for "phase import")`;
  if (globalJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}

async function cmdPlanBrief(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean" },
      json: { type: "boolean" },
      "from-file": { type: "string" },
      stdin: { type: "boolean" },
      what: { type: "string" },
      who: { type: "string" },
      differentiator: { type: "string" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const force = values.force === true;
  const fromFile =
    typeof values["from-file"] === "string" ? values["from-file"] : undefined;
  const fromStdin = values.stdin === true;
  const what = typeof values.what === "string" ? values.what : undefined;
  const who = typeof values.who === "string" ? values.who : undefined;
  const differentiator =
    typeof values.differentiator === "string" ? values.differentiator : undefined;
  const flagDriven =
    what !== undefined || who !== undefined || differentiator !== undefined;
  const cwd = process.cwd();

  // v1.6 P17-T2/T3: the three non-interactive input modes (`--from-file`,
  // `--stdin`, flag-driven `--what`/`--who`/`--differentiator`) are
  // pairwise mutually exclusive. Allowing combinations would create
  // ambiguous precedence; reject early so the user is forced to pick
  // a single source of truth.
  const inputModes: string[] = [];
  if (fromFile !== undefined) inputModes.push("--from-file");
  if (fromStdin) inputModes.push("--stdin");
  if (flagDriven) inputModes.push("--what/--who/--differentiator");
  if (inputModes.length > 1) {
    const msg = `plan brief: ${inputModes.join(", ")} are mutually exclusive. Pick one input source.`;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // v1.6 P17-T3: if any flag-driven option was supplied, both `--what`
  // and `--who` are required (matches `BriefFileSchema`). Missing them
  // is CONFIG_ERROR — we deliberately do NOT fall back to the wizard
  // (would silently lose user intent) or to defaults (would write a
  // misleading brief.md).
  if (flagDriven) {
    const missing: string[] = [];
    if (what === undefined || what.length === 0) missing.push("--what");
    if (who === undefined || who.length === 0) missing.push("--who");
    if (missing.length > 0) {
      const msg = `plan brief: flag-driven mode requires non-empty ${missing.join(" and ")}. Pass the missing flag(s) or use --from-file / --stdin / the TTY wizard instead.`;
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "CONFIG_ERROR", message: msg },
            data: { missing },
          })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
  }

  // v1.6 P17-T1: `--from-file` bypasses the TTY requirement. Without
  // it, the wizard path still requires a TTY (v1.5.1 behaviour
  // preserved). v1.6 P17-T2 extends the bypass to `--stdin`.
  let preCollectedAnswers: BriefAnswers | undefined;
  if (fromFile !== undefined) {
    try {
      preCollectedAnswers = await loadBriefFromFile(cwd, fromFile);
    } catch (err) {
      if (err instanceof PlanBriefFromFileError) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: { code: "CONFIG_ERROR", message: err.message },
              data: { detail: err.detail, path: err.path },
            })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      throw err;
    }
  } else if (fromStdin) {
    try {
      preCollectedAnswers = await loadBriefFromStdin(process.stdin);
    } catch (err) {
      if (err instanceof PlanBriefFromStdinError) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: { code: "CONFIG_ERROR", message: err.message },
              data: { detail: err.detail, source: "stdin" },
            })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      throw err;
    }
  } else if (flagDriven) {
    // v1.6 P17-T3: flag-driven mode. We've already validated that
    // `--what` and `--who` are present and non-empty above. The
    // schema's empty-input behaviour for `differentiator` (defaults
    // to "" → locale placeholder fills in) is preserved.
    preCollectedAnswers = {
      what: what!,
      who: who!,
      differentiator: differentiator ?? "",
    };
  } else if (!isInteractive()) {
    const msg = "plan brief is interactive and requires a TTY (use --from-file <yaml>, --stdin, or --what/--who[/--differentiator] for non-interactive input).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const result = await runPlanBrief({
    cwd,
    locale,
    force,
    answers: preCollectedAnswers,
  });
  if (result.skipped) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "ALREADY_EXISTS", message: m.plan.briefSkipped(result.path) } })}\n`,
      );
    } else {
      process.stderr.write(`${m.plan.briefSkipped(result.path)}\n`);
    }
    return 2;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { path: result.path } })}\n`);
  } else {
    process.stderr.write(`${m.plan.briefDone(result.path)}\n`);
  }
  return 0;
}

async function cmdPlanPrompt(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      clipboard: { type: "boolean" },
      "schema-only": { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const clipboard = values.clipboard === true;
  const schemaOnly = values["schema-only"] === true;
  const cwd = process.cwd();

  const result = await runPlanPrompt({ cwd, locale, clipboard, schemaOnly });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        data: {
          prompt: result.prompt,
          schema_only: result.schemaOnly,
          has_brief: result.hasBrief,
          has_constitution: result.hasConstitution,
          clipboard_copied: result.clipboardCopied,
          suggested_next_steps: result.suggested_next_steps,
        },
      })}\n`,
    );
    return 0;
  }

  // Human mode: write prompt to stdout, status info to stderr.
  process.stdout.write(result.prompt);
  if (!result.prompt.endsWith("\n")) process.stdout.write("\n");

  // Schema-only deliberately ignores the brief, so the "no brief" nudge
  // would be noise — suppress it in that mode.
  if (!result.schemaOnly && !result.hasBrief) {
    process.stderr.write(`${m.plan.promptNoBrief}\n`);
  }
  if (clipboard) {
    if (result.clipboardCopied) {
      process.stderr.write(`${m.plan.promptClipboardCopied}\n`);
    } else {
      process.stderr.write(`${m.plan.promptClipboardFailed}\n`);
    }
  }

  return 0;
}

async function cmdPlanAdopt(argv: string[], globalJson: boolean): Promise<number> {
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "plan adopt",
      argv,
      {
        write: { type: "boolean" },
        json: { type: "boolean" },
      },
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const json = globalJson || argv.includes("--json");
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
  const write = values.write === true;
  const fromPath = positionals[0];
  const cwd = process.cwd();

  if (!fromPath) {
    const msg =
      "plan adopt requires a path, e.g. `plan adopt roadmap.md` (dry-run) or `plan adopt roadmap.md --write`";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const run = async (): Promise<number> => {
    try {
      const result = await runPlanAdopt({ cwd, fromPath, write });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
        return 0;
      }
      // Human: dry-run prints the generated YAML to stdout so it can be
      // piped/saved; warnings + next steps go to stderr in both modes.
      if (!write) {
        process.stdout.write(result.generated_import_yaml);
        if (!result.generated_import_yaml.endsWith("\n")) process.stdout.write("\n");
        process.stderr.write(
          `Would adopt ${result.phases_detected} phase(s), ${result.tasks_detected} task(s) from ${result.source_path} (source: ${result.source_type}).\n`,
        );
      } else {
        const imported = result.import_result;
        process.stderr.write(
          `Adopted ${imported?.imported_phases.length ?? 0} phase(s), ${imported?.imported_tasks.length ?? 0} task(s) from ${result.source_path} (source: ${result.source_type}).\n`,
        );
      }
      for (const w of result.warnings) {
        process.stderr.write(
          `  warning [${w.code}]${w.line !== undefined ? ` line ${w.line}` : ""}: ${w.message}\n`,
        );
      }
      for (const step of result.suggested_next_steps) {
        process.stderr.write(`  next: ${step}\n`);
      }
      return 0;
    } catch (err: unknown) {
      if (err instanceof PlanAdoptError) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: { code: "CONFIG_ERROR", message: err.message },
              data: { detail: err.detail, source_path: err.sourcePath ?? null },
            })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      // Errors propagated from applyParsedPhaseImport on --write
      // (DUPLICATE_PHASE_ID / AMBIGUOUS_TASK_ID / CONFIG_ERROR).
      const code = (err as NodeJS.ErrnoException).code;
      const message = err instanceof Error ? err.message : String(err);
      if (
        code === "CONFIG_ERROR" ||
        code === "DUPLICATE_PHASE_ID" ||
        code === "AMBIGUOUS_TASK_ID"
      ) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
          );
        } else {
          process.stderr.write(`${message}\n`);
        }
        return 2;
      }
      throw err;
    }
  };

  // Only the --write path mutates design YAML, so only it takes the lock.
  return write ? withWriteLock(cwd, "plan adopt --write", json, run) : run();
}

async function cmdPlanConstitution(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean" },
      json: { type: "boolean" },
      "from-file": { type: "string" },
      stdin: { type: "boolean" },
      description: { type: "string" },
      principle: { type: "string", multiple: true },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const force = values.force === true;
  const fromFile =
    typeof values["from-file"] === "string" ? values["from-file"] : undefined;
  const fromStdin = values.stdin === true;
  const description =
    typeof values.description === "string" ? values.description : undefined;
  const principleRaw = Array.isArray(values.principle)
    ? (values.principle as unknown[]).filter(
        (v): v is string => typeof v === "string",
      )
    : undefined;
  const principles =
    principleRaw !== undefined && principleRaw.length > 0
      ? principleRaw
      : undefined;
  const flagDriven = description !== undefined || principles !== undefined;
  const cwd = process.cwd();

  // v1.6 P17-T4: three pairwise-mutually-exclusive non-interactive
  // input modes, mirroring `plan brief` (P17-T1 / T2 / T3).
  const inputModes: string[] = [];
  if (fromFile !== undefined) inputModes.push("--from-file");
  if (fromStdin) inputModes.push("--stdin");
  if (flagDriven) inputModes.push("--description/--principle");
  if (inputModes.length > 1) {
    const msg = `plan constitution: ${inputModes.join(", ")} are mutually exclusive. Pick one input source.`;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // v1.6 P17-T4: load pre-collected answers from whichever
  // non-interactive mode was selected. `ConstitutionFileSchema`
  // defaults both fields to empty, so an empty-but-present input
  // (e.g. `plan constitution --stdin` with `{}` on stdin) is
  // accepted and falls back to the locale defaults via
  // `generateConstitutionMd` — same as the wizard with empty
  // input.
  let preCollectedAnswers: ConstitutionAnswers | undefined;
  if (fromFile !== undefined) {
    try {
      preCollectedAnswers = await loadConstitutionFromFile(cwd, fromFile);
    } catch (err) {
      if (err instanceof PlanConstitutionFromFileError) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: { code: "CONFIG_ERROR", message: err.message },
              data: { detail: err.detail, path: err.path },
            })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      throw err;
    }
  } else if (fromStdin) {
    try {
      preCollectedAnswers = await loadConstitutionFromStdin(process.stdin);
    } catch (err) {
      if (err instanceof PlanConstitutionFromStdinError) {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: { code: "CONFIG_ERROR", message: err.message },
              data: { detail: err.detail, source: "stdin" },
            })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
      throw err;
    }
  } else if (flagDriven) {
    // v1.6 P17-T4: flag-driven mode. Both fields are optional in the
    // schema; we pass through whatever was supplied and let
    // generateConstitutionMd fall back to locale defaults for empty
    // values — same behaviour as the wizard's empty-input path.
    preCollectedAnswers = {
      description: description ?? "",
      principles: principles ?? [],
    };
  } else if (!isInteractive()) {
    const msg = "plan constitution is interactive and requires a TTY (use --from-file <yaml>, --stdin, or --description/--principle for non-interactive input).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const result = await runPlanConstitution({
    cwd,
    locale,
    force,
    answers: preCollectedAnswers,
  });
  if (result.skipped) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "ALREADY_EXISTS", message: m.plan.constitutionSkipped(result.path) } })}\n`,
      );
    } else {
      process.stderr.write(`${m.plan.constitutionSkipped(result.path)}\n`);
    }
    return 2;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { path: result.path } })}\n`);
  } else {
    process.stderr.write(`${m.plan.constitutionDone(result.path)}\n`);
  }
  return 0;
}

async function cmdPlanLint(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  void locale;
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      strict: { type: "boolean" },
      "include-quality": { type: "boolean" },
    },
    strict: false,
  });
  const json = globalJson || values.json === true;
  const strict = values.strict === true;
  const includeQuality = values["include-quality"] === true;
  const cwd = process.cwd();

  try {
    const result = await runPlanLint({ cwd, strict, includeQuality });
    const data = serializePlanLintData(result);

    if (json) {
      const payload = result.ok
        ? { ok: true, data }
        : {
            ok: false,
            error: {
              code: "PLAN_LINT_FAILED",
              message: `plan lint failed: ${result.errors} error(s), ${result.warnings} warning(s)`,
            },
            data,
          };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stderr.write(`${formatPlanLintHuman(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const code =
      (err as NodeJS.ErrnoException).code ?? "PLAN_LINT_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
  }
}

async function cmdPlanNormalize(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  void locale;
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      check: { type: "boolean" },
      write: { type: "boolean" },
    },
    strict: false,
  });
  const json = globalJson || values.json === true;
  const checkFlag = values.check === true;
  const writeFlag = values.write === true;
  const cwd = process.cwd();

  // Reject typos and unknown flags so --wite cannot silently degrade to
  // a no-op check. parseArgs strict: false otherwise lets unknown
  // options through.
  const allowedKeys = new Set(["json", "check", "write"]);
  const unknown = Object.keys(values).filter((k) => !allowedKeys.has(k));
  if (unknown.length > 0) {
    const message = `plan normalize: unknown option(s): ${unknown.map((k) => `--${k}`).join(", ")}`;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message } })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
  }

  if (checkFlag && writeFlag) {
    const message =
      "plan normalize: --check and --write are mutually exclusive.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "PLAN_NORMALIZE_CONFLICT", message } })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
  }

  const mode = writeFlag ? "write" : "check";

  try {
    const result = await runPlanNormalize({ cwd, mode });
    const data = serializePlanNormalizeData(result);

    if (json) {
      const payload = result.ok
        ? { ok: true, data }
        : {
            ok: false,
            error: {
              code: "PLAN_NORMALIZE_REQUIRED",
              message: `plan normalize: ${result.changedCount} file(s) need normalization`,
            },
            data,
          };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stderr.write(`${formatPlanNormalizeHuman(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const code =
      (err as NodeJS.ErrnoException).code ?? "PLAN_NORMALIZE_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 3;
  }
}

async function cmdPlanAnalyze(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  void locale;
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      strict: { type: "boolean" },
      "include-historical": { type: "boolean" },
    },
    strict: false,
  });
  const json = globalJson || values.json === true;
  const strict = values.strict === true;
  const includeHistorical = values["include-historical"] === true;
  const cwd = process.cwd();

  try {
    const result = await runPlanAnalyze({ cwd, strict, includeHistorical });
    const data = serializePlanAnalyzeData(result);

    if (json) {
      const payload = result.ok
        ? { ok: true, data }
        : {
            ok: false,
            error: {
              code: "PLAN_ANALYZE_FAILED",
              message: `plan analyze failed: ${result.errors} error(s), ${result.warnings} warning(s)`,
            },
            data,
          };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stderr.write(`${formatPlanAnalyzeHuman(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const code =
      (err as NodeJS.ErrnoException).code ?? "PLAN_ANALYZE_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 1;
  }
}
