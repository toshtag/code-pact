// The CLI wrapper layer for the `plan` subcommand cluster. Routes
// `plan <subcommand>` to the per-subcommand handlers defined below.
// JSON envelopes, exit codes, error codes, and flag surfaces are part
// of the stable CLI contract.
//
// `cmdPlan` is the cluster-entry dispatch and is the only export.
// The per-subcommand handlers (cmdPlanBrief, cmdPlanLint, etc.) are
// private to this module.

import { parseArgs } from "node:util";
import { strictParse, ConfigError } from "../../lib/argv.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { toParseOptions } from "../spec/render.ts";
import { PLAN_SPECS } from "../spec/plan.ts";
import { cmdPhaseImport } from "./phase.ts";
import { withWriteLock, emitOk, emitError } from "../util.ts";
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
import {
  formatPlanSyncPathsHuman,
  runPlanSyncPaths,
  serializePlanSyncPathsData,
  type RenamePair,
} from "../../commands/plan-sync-paths.ts";
import { migrateProgressToEvents } from "../../core/progress/migrate.ts";

export async function cmdPlan(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  // `plan`, `plan help`, `plan --help`, `plan -h` → cluster usage (exit 0).
  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("plan"));
  }
  // `plan <sub> --help` → per-subcommand usage (exit 0), before strictParse.
  // `plan import` is an alias for `phase import`; route its help to the same
  // rich entry so the alias is discoverable, not a 2-line stub.
  if (hasHelpFlag(rest)) {
    const cluster = subcommand === "import" ? "phase" : "plan";
    return emitUsage(subcommandUsage(cluster, subcommand));
  }

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

  if (subcommand === "sync-paths") {
    return cmdPlanSyncPaths(rest, locale, globalJson);
  }

  if (subcommand === "migrate") {
    return cmdPlanMigrate(rest, locale, globalJson);
  }

  // `plan import` is a beginner-friendly alias for `phase import` (it ingests a
  // whole multi-phase roadmap, which "phase import" undersells). Shares the
  // same handler; the invoked name labels its error messages.
  if (subcommand === "import") {
    return cmdPhaseImport(rest, locale, globalJson, "plan import");
  }

  const msg = `plan: unknown subcommand "${subcommand ?? ""}". Use: brief | prompt | adopt | constitution | lint | normalize | analyze | sync-paths | migrate | import (alias for "phase import")`;
  emitError(globalJson, "CONFIG_ERROR", msg);
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
    options: toParseOptions(PLAN_SPECS.brief),
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

  // The three non-interactive input modes (`--from-file`, `--stdin`,
  // flag-driven `--what`/`--who`/`--differentiator`) are pairwise mutually
  // exclusive. Allowing combinations would create ambiguous precedence;
  // reject early so the user is forced to pick a single source of truth.
  const inputModes: string[] = [];
  if (fromFile !== undefined) inputModes.push("--from-file");
  if (fromStdin) inputModes.push("--stdin");
  if (flagDriven) inputModes.push("--what/--who/--differentiator");
  if (inputModes.length > 1) {
    const msg = `plan brief: ${inputModes.join(", ")} are mutually exclusive. Pick one input source.`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  // If any flag-driven option was supplied, both `--what` and `--who` are
  // required (matches `BriefFileSchema`). Missing them is CONFIG_ERROR — we
  // deliberately do NOT fall back to the wizard (would silently lose user
  // intent) or to defaults (would write a misleading brief.md).
  if (flagDriven) {
    const missing: string[] = [];
    if (what === undefined || what.length === 0) missing.push("--what");
    if (who === undefined || who.length === 0) missing.push("--who");
    if (missing.length > 0) {
      const msg = `plan brief: flag-driven mode requires non-empty ${missing.join(" and ")}. Pass the missing flag(s) or use --from-file / --stdin / the TTY wizard instead.`;
      emitError(json, "CONFIG_ERROR", msg, { data: { missing } });
      return 2;
    }
  }

  // `--from-file` and `--stdin` bypass the TTY requirement. Without them,
  // the wizard path still requires a TTY.
  let preCollectedAnswers: BriefAnswers | undefined;
  if (fromFile !== undefined) {
    try {
      preCollectedAnswers = await loadBriefFromFile(cwd, fromFile);
    } catch (err) {
      if (err instanceof PlanBriefFromFileError) {
        emitError(json, "CONFIG_ERROR", err.message, {
          data: { detail: err.detail, path: err.path },
        });
        return 2;
      }
      throw err;
    }
  } else if (fromStdin) {
    try {
      preCollectedAnswers = await loadBriefFromStdin(process.stdin);
    } catch (err) {
      if (err instanceof PlanBriefFromStdinError) {
        emitError(json, "CONFIG_ERROR", err.message, {
          data: { detail: err.detail, source: "stdin" },
        });
        return 2;
      }
      throw err;
    }
  } else if (flagDriven) {
    // Flag-driven mode. `--what` and `--who` are already validated present
    // and non-empty above. An empty `differentiator` defaults to "" → the
    // locale placeholder fills in.
    preCollectedAnswers = {
      what: what!,
      who: who!,
      differentiator: differentiator ?? "",
    };
  } else if (!isInteractive()) {
    const msg = "plan brief is interactive and requires a TTY (use --from-file <yaml>, --stdin, or --what/--who[/--differentiator] for non-interactive input).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  let result: Awaited<ReturnType<typeof runPlanBrief>>;
  try {
    result = await runPlanBrief({
      cwd,
      locale,
      force,
      answers: preCollectedAnswers,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
      const message = err instanceof Error ? err.message : String(err);
      emitError(json, "CONFIG_ERROR", message);
      return 2;
    }
    throw err;
  }
  if (result.skipped) {
    emitError(json, "ALREADY_EXISTS", m.plan.briefSkipped(result.path));
    return 2;
  }

  if (json) {
    emitOk({ path: result.path });
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
    options: toParseOptions(PLAN_SPECS.prompt),
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const clipboard = values.clipboard === true;
  const schemaOnly = values["schema-only"] === true;
  const cwd = process.cwd();

  const result = await runPlanPrompt({ cwd, locale, clipboard, schemaOnly });

  if (json) {
    emitOk({
      prompt: result.prompt,
      schema_only: result.schemaOnly,
      has_brief: result.hasBrief,
      has_constitution: result.hasConstitution,
      clipboard_copied: result.clipboardCopied,
      suggested_next_steps: result.suggested_next_steps,
    });
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
      toParseOptions(PLAN_SPECS.adopt),
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const json = globalJson || argv.includes("--json");
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const write = values.write === true;
  const scaffoldDecisions = values["scaffold-decisions"] === true;
  const fromPath = positionals[0];
  const cwd = process.cwd();

  if (!fromPath) {
    const msg =
      "plan adopt requires a path, e.g. `plan adopt roadmap.md` (dry-run) or `plan adopt roadmap.md --write`";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const run = async (): Promise<number> => {
    try {
      const result = await runPlanAdopt({ cwd, fromPath, write, scaffoldDecisions });
      if (json) {
        emitOk(result);
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
        emitError(json, "CONFIG_ERROR", err.message, {
          data: { detail: err.detail, source_path: err.sourcePath ?? null },
        });
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
        emitError(json, code, message);
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
    options: toParseOptions(PLAN_SPECS.constitution),
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

  // Three pairwise-mutually-exclusive non-interactive input modes,
  // mirroring `plan brief`.
  const inputModes: string[] = [];
  if (fromFile !== undefined) inputModes.push("--from-file");
  if (fromStdin) inputModes.push("--stdin");
  if (flagDriven) inputModes.push("--description/--principle");
  if (inputModes.length > 1) {
    const msg = `plan constitution: ${inputModes.join(", ")} are mutually exclusive. Pick one input source.`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  // Load pre-collected answers from whichever non-interactive mode was
  // selected. `ConstitutionFileSchema` defaults both fields to empty, so an
  // empty-but-present input (e.g. `plan constitution --stdin` with `{}` on
  // stdin) is accepted and falls back to the locale defaults via
  // `generateConstitutionMd` — same as the wizard with empty input.
  let preCollectedAnswers: ConstitutionAnswers | undefined;
  if (fromFile !== undefined) {
    try {
      preCollectedAnswers = await loadConstitutionFromFile(cwd, fromFile);
    } catch (err) {
      if (err instanceof PlanConstitutionFromFileError) {
        emitError(json, "CONFIG_ERROR", err.message, {
          data: { detail: err.detail, path: err.path },
        });
        return 2;
      }
      throw err;
    }
  } else if (fromStdin) {
    try {
      preCollectedAnswers = await loadConstitutionFromStdin(process.stdin);
    } catch (err) {
      if (err instanceof PlanConstitutionFromStdinError) {
        emitError(json, "CONFIG_ERROR", err.message, {
          data: { detail: err.detail, source: "stdin" },
        });
        return 2;
      }
      throw err;
    }
  } else if (flagDriven) {
    // Flag-driven mode. Both fields are optional in the schema; we pass
    // through whatever was supplied and let generateConstitutionMd fall back
    // to locale defaults for empty values — same behaviour as the wizard's
    // empty-input path.
    preCollectedAnswers = {
      description: description ?? "",
      principles: principles ?? [],
    };
  } else if (!isInteractive()) {
    const msg = "plan constitution is interactive and requires a TTY (use --from-file <yaml>, --stdin, or --description/--principle for non-interactive input).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  let result: Awaited<ReturnType<typeof runPlanConstitution>>;
  try {
    result = await runPlanConstitution({
      cwd,
      locale,
      force,
      answers: preCollectedAnswers,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
      const message = err instanceof Error ? err.message : String(err);
      emitError(json, "CONFIG_ERROR", message);
      return 2;
    }
    throw err;
  }
  if (result.skipped) {
    emitError(json, "ALREADY_EXISTS", m.plan.constitutionSkipped(result.path));
    return 2;
  }

  if (json) {
    emitOk({ path: result.path });
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
    options: toParseOptions(PLAN_SPECS.lint),
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
      if (result.ok) {
        emitOk(data);
      } else {
        emitError(
          json,
          "PLAN_LINT_FAILED",
          `plan lint failed: ${result.errors} error(s), ${result.warnings} warning(s)`,
          { data },
        );
      }
    } else {
      process.stderr.write(`${formatPlanLintHuman(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const code =
      (err as NodeJS.ErrnoException).code ?? "PLAN_LINT_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    emitError(json, code, message);
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
    options: toParseOptions(PLAN_SPECS.normalize),
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
    emitError(json, "CONFIG_ERROR", message);
    return 2;
  }

  if (checkFlag && writeFlag) {
    const message =
      "plan normalize: --check and --write are mutually exclusive.";
    emitError(json, "PLAN_NORMALIZE_CONFLICT", message);
    return 2;
  }

  const mode = writeFlag ? "write" : "check";

  try {
    const result = await runPlanNormalize({ cwd, mode });
    const data = serializePlanNormalizeData(result);

    if (json) {
      if (result.ok) {
        emitOk(data);
      } else {
        emitError(
          json,
          "PLAN_NORMALIZE_REQUIRED",
          `plan normalize: ${result.changedCount} file(s) need normalization`,
          { data },
        );
      }
    } else {
      process.stderr.write(`${formatPlanNormalizeHuman(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const rawCode =
      (err as NodeJS.ErrnoException).code ?? "PLAN_NORMALIZE_FAILED";
    const code = normalizeFsAuthorityConfigCode(rawCode);
    const message = err instanceof Error ? err.message : String(err);
    emitError(json, code, message);
    return code === "CONFIG_ERROR" ? 2 : 3;
  }
}

function normalizeFsAuthorityConfigCode(code: string): string {
  return code === "PATH_NOT_OWNED" ||
    code === "PATH_OUTSIDE_PROJECT" ||
    code === "FS_AUTHORITY_FAILURE" ||
    code === "ENOSYS"
    ? "CONFIG_ERROR"
    : code;
}

// Ledger-read failures are integrity DIAGNOSTICS, not public command errors —
// the lenient loaders (`doctor`, `plan lint`) surface them as structured
// `data.issues[]` entries. When a strict-loader plan command catches one, wrap
// it in the command's own failure code so `EVENT_FILE_ID_MISMATCH` /
// `INVALID_YAML` / `SCHEMA_ERROR` never leak as a top-level `error.code`; the
// original cause stays in `error.message`. See
// docs/cli-contract.md § Plan diagnostic codes.
const LEDGER_READ_INTEGRITY_CODES = new Set<string>([
  "EVENT_FILE_ID_MISMATCH",
  "INVALID_YAML",
  "SCHEMA_ERROR",
]);

function planCatchCode(err: unknown, fallback: string): string {
  const raw = (err as NodeJS.ErrnoException).code;
  if (raw === undefined || LEDGER_READ_INTEGRITY_CODES.has(raw)) return fallback;
  return raw;
}

async function cmdPlanAnalyze(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  void locale;
  const { values } = parseArgs({
    args: argv,
    options: toParseOptions(PLAN_SPECS.analyze),
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
      if (result.ok) {
        emitOk(data);
      } else {
        emitError(
          json,
          "PLAN_ANALYZE_FAILED",
          `plan analyze failed: ${result.errors} error(s), ${result.warnings} warning(s)`,
          { data },
        );
      }
    } else {
      process.stderr.write(`${formatPlanAnalyzeHuman(result)}\n`);
    }

    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    // A ledger-read integrity failure (EVENT_FILE_ID_MISMATCH / INVALID_YAML /
    // SCHEMA_ERROR from the strict loader) is wrapped into PLAN_ANALYZE_FAILED so
    // it never surfaces as a public top-level error.code; the cause is in message.
    const code = planCatchCode(err, "PLAN_ANALYZE_FAILED");
    const message = err instanceof Error ? err.message : String(err);
    emitError(json, code, message);
    return code === "CONFIG_ERROR" ? 2 : 1;
  }
}

// `plan migrate` — convert a legacy monolithic progress.yaml into the per-event
// ledger. Idempotent; dry-run by default.
async function cmdPlanMigrate(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  void locale;
  const { values } = parseArgs({
    args: argv,
    options: toParseOptions(PLAN_SPECS.migrate),
    strict: false,
  });
  const json = globalJson || values.json === true;
  const write = values.write === true;
  const cwd = process.cwd();

  try {
    const result = await migrateProgressToEvents(cwd, { write });
    if (json) {
      emitOk(result);
    } else {
      const lines = [
        result.dry_run
          ? `Dry run (re-run with --write to migrate). ${result.legacy_events} legacy event(s) would be written to .code-pact/state/events/.`
          : `Migrated to per-event files: ${result.written} written, ${result.already_present} already present (of ${result.legacy_events} legacy event(s)). progress.yaml is left in place.`,
        ...(result.state_changes.length > 0
          ? [
              `${result.state_changes.length} task(s) change derived state under merged ordering — review before committing:`,
              ...result.state_changes.map((c) => `  ${c.task_id}: ${c.before} → ${c.after}`),
            ]
          : []),
      ];
      process.stderr.write(`${lines.join("\n")}\n`);
    }
    return 0;
  } catch (err: unknown) {
    // A corrupt existing event file read during migration must not leak
    // EVENT_FILE_ID_MISMATCH (etc.) as a top-level error.code — ledger-read
    // integrity codes and code-less throws are wrapped into the command-level
    // PLAN_MIGRATE_FAILED (the literal below is what the error-code-surface scan
    // pins, mirroring plan analyze's PLAN_ANALYZE_FAILED); the cause stays in
    // error.message. A non-ledger coded error keeps its own code.
    const message = err instanceof Error ? err.message : String(err);
    const raw = (err as NodeJS.ErrnoException).code;
    if (raw !== undefined && !LEDGER_READ_INTEGRITY_CODES.has(raw)) {
      emitError(json, raw, message);
    } else {
      emitError(json, "PLAN_MIGRATE_FAILED", message);
    }
    return 1;
  }
}

// `plan sync-paths` — apply an explicit old=new rename map to the reads/writes
// of every phase task, so renaming/merging a src file referenced by a phase
// does not leave the plan-lint reads-match invariant to be fixed by hand.
// Dry-run by default; `--write` mutates design/phases (under the write lock).
async function cmdPlanSyncPaths(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  void locale;
  let values: Record<string, unknown>;
  try {
    // Strict parse: an unknown flag (e.g. the typo `--wriet`) or a stray
    // positional must fail loudly. Silently degrading to dry-run would defeat a
    // command whose whole job is to fix a CI failure — the user would think
    // they wrote and see exit 0.
    ({ values } = strictParse(
      "plan sync-paths",
      argv,
      toParseOptions(PLAN_SPECS["sync-paths"]),
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", err.message);
    return 2;
  }
  const json = globalJson || values.json === true;
  const writeFlag = values.write === true;
  const cwd = process.cwd();

  const rawRenames = Array.isArray(values.rename)
    ? (values.rename as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  if (rawRenames.length === 0) {
    emitError(
      json,
      "CONFIG_ERROR",
      "plan sync-paths requires at least one --rename <old>=<new>.",
    );
    return 2;
  }
  const renameMap = new Map<string, string>();
  for (const r of rawRenames) {
    const eq = r.indexOf("=");
    if (eq <= 0 || eq === r.length - 1) {
      emitError(
        json,
        "CONFIG_ERROR",
        `plan sync-paths: invalid --rename "${r}" (expected <old>=<new>).`,
      );
      return 2;
    }
    const from = r.slice(0, eq);
    const to = r.slice(eq + 1);
    if (from === to) {
      emitError(
        json,
        "CONFIG_ERROR",
        `plan sync-paths: --rename "${r}" has identical old and new paths.`,
      );
      return 2;
    }
    // Many from → one to is a legit merge; one from → two different to is
    // ambiguous, so reject it rather than silently letting the last one win.
    const existing = renameMap.get(from);
    if (existing !== undefined && existing !== to) {
      emitError(
        json,
        "CONFIG_ERROR",
        `plan sync-paths: conflicting --rename for "${from}" ("${existing}" and "${to}").`,
      );
      return 2;
    }
    renameMap.set(from, to);
  }
  const renames: RenamePair[] = [...renameMap].map(([from, to]) => ({ from, to }));

  const mode = writeFlag ? "write" : "check";

  const run = async (): Promise<number> => {
    let result: Awaited<ReturnType<typeof runPlanSyncPaths>>;
    try {
      result = await runPlanSyncPaths({ cwd, renames, mode });
    } catch (err) {
      const code = normalizeFsAuthorityConfigCode(
        (err as NodeJS.ErrnoException).code ?? "PLAN_SYNC_PATHS_FAILED",
      );
      if (code === "CONFIG_ERROR") {
        const message = err instanceof Error ? err.message : String(err);
        emitError(json, "CONFIG_ERROR", message);
        return 2;
      }
      throw err;
    }
    if (json) {
      emitOk(serializePlanSyncPathsData(result));
    } else {
      process.stderr.write(`${formatPlanSyncPathsHuman(result)}\n`);
    }
    return 0;
  };

  // Only --write mutates design YAML; the dry-run check is lock-free.
  return writeFlag
    ? withWriteLock(cwd, "plan sync-paths --write", json, run)
    : run();
}
