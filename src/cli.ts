#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readPackageVersion } from "./lib/package-version.ts";
import { splitArgv, strictParse, ConfigError } from "./lib/argv.ts";
import { isInteractive, isCIEnv } from "./lib/tty.ts";
import { messages, type Locale } from "./i18n/index.ts";
import { runInit, type SupportedAgent } from "./commands/init.ts";
import { runInitWizard } from "./commands/init-wizard.ts";
import { SUPPORTED_AGENTS } from "./core/agents.ts";
import {
  runPhaseAdd,
  runPhaseLs,
  runPhaseShow,
  formatPhaseLsTable,
  formatPhaseShow,
} from "./commands/phase.ts";
import { runPhaseImport } from "./commands/phase-import.ts";
import {
  runSpecImport,
  runSpecSuggest,
  SpecImportError,
} from "./commands/spec-import.ts";
import {
  acquireWriteLock,
  isLockHeldError,
  type LockHandle,
} from "./core/locks/write-lock.ts";
import { runProgress, formatProgress } from "./commands/progress.ts";
import { runPack } from "./commands/pack.ts";
import { runVerify, formatVerify } from "./commands/verify.ts";
import {
  runAdapterInstall,
  runAdapterList,
  runAdapterDoctor,
  runAdapterUpgrade,
} from "./commands/adapter.ts";
import {
  type BriefAnswers,
  loadBriefFromFile,
  loadBriefFromStdin,
  PlanBriefFromFileError,
  PlanBriefFromStdinError,
  runPlanBrief,
} from "./commands/plan-brief.ts";
import { runPlanPrompt } from "./commands/plan-prompt.ts";
import {
  type ConstitutionAnswers,
  loadConstitutionFromFile,
  loadConstitutionFromStdin,
  PlanConstitutionFromFileError,
  PlanConstitutionFromStdinError,
  runPlanConstitution,
} from "./commands/plan-constitution.ts";
import {
  formatPlanLintHuman,
  runPlanLint,
  serializePlanLintData,
} from "./commands/plan-lint.ts";
import {
  formatPlanNormalizeHuman,
  runPlanNormalize,
  serializePlanNormalizeData,
} from "./commands/plan-normalize.ts";
import {
  formatPlanAnalyzeHuman,
  runPlanAnalyze,
  serializePlanAnalyzeData,
} from "./commands/plan-analyze.ts";
import { runRecommend, formatRecommend } from "./commands/recommend.ts";
import { runDoctor, formatDoctor } from "./commands/doctor.ts";
import { runValidate } from "./commands/validate.ts";
import { runTaskContext } from "./commands/task-context.ts";
import { runTaskComplete } from "./commands/task-complete.ts";
import { runTaskPrepare } from "./commands/task-prepare.ts";
import {
  runTaskFinalize,
  TaskFinalizeAuditStrictError,
} from "./commands/task-finalize.ts";
import { runTaskRunbook } from "./commands/task-runbook.ts";
import { runPhaseReconcile } from "./commands/phase-reconcile.ts";
import {
  runPhaseRunbook,
  runPhaseRunbookAcrossPhases,
} from "./commands/phase-runbook.ts";
import { runTaskStart } from "./commands/task-start.ts";
import { runTaskBlock } from "./commands/task-block.ts";
import { runTaskResume } from "./commands/task-resume.ts";
import { runTaskStatus } from "./commands/task-status.ts";
import { runPhaseNew } from "./commands/phase-new.ts";
import { runTaskAdd, type TaskAddNonInteractiveSpec } from "./commands/task-add.ts";
import {
  TaskType,
  AmbiguityLevel,
  RiskLevel,
  ContextSize,
  WriteSurface,
  VerificationStrength,
  ExpectedDuration,
} from "./core/schemas/task.ts";
import { runPhaseWizard } from "./lib/phase-wizard.ts";
import type { LocaleCode } from "./core/schemas/locale.ts";
import { LocaleConfig } from "./core/schemas/locale.ts";
import type { PhaseStatus } from "./core/schemas/phase.ts";

const KNOWN_LOCALES: ReadonlySet<Locale> = new Set(["en-US", "ja-JP"]);
const KNOWN_AGENTS: ReadonlySet<SupportedAgent> = new Set(SUPPORTED_AGENTS);

/**
 * `true` when `<cwd>/.code-pact/` exists on disk. Used by `cmdInit` to
 * decide whether to wrap with the advisory write lock: fresh init (no
 * `.code-pact/` yet) bootstraps the project tree, and the lock helper's
 * `mkdir -p` of `.code-pact/locks/` would itself create `.code-pact/`
 * as a side effect — which then trips the ALREADY_INITIALIZED guard in
 * `runInit`. Fresh init also has no possible concurrent code-pact
 * mutation to defend against (no project exists yet), so skipping the
 * lock is semantically correct. Re-init (with `--force` on an existing
 * project) still acquires the lock — concurrent mutations are possible
 * there and need the same serialization guarantee.
 */
async function codePactDirExists(cwd: string): Promise<boolean> {
  try {
    const s = await stat(join(cwd, ".code-pact"));
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Wrap a design-mutating CLI handler in the advisory write lock
 * (P14 governance). Acquires the lock at command-handler entry,
 * runs the handler, and releases on every exit path. On contention,
 * emits the `LOCK_HELD` JSON envelope (or stderr message) and
 * returns exit 2 without invoking `run`.
 *
 * `cmdLabel` is the user-facing command string ("task finalize P14-T5
 * --write" etc.) recorded in the lock file for diagnostic display.
 */
async function withWriteLock(
  cwd: string,
  cmdLabel: string,
  json: boolean,
  run: () => Promise<number>,
): Promise<number> {
  let lock: LockHandle;
  try {
    lock = await acquireWriteLock(cwd, cmdLabel);
  } catch (err) {
    if (isLockHeldError(err)) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "LOCK_HELD", message: err.message },
            data: { lock_holder: err.lock_holder, lock_path: err.lock_path },
          })}\n`,
        );
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      return 2;
    }
    throw err;
  }
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

// Locale resolution priority:
// 1. --locale flag (handled in main before this is called)
// 2. CODE_PACT_LOCALE env var
// 3. .code-pact/project.yaml locale field
// 4. LANG env var
// 5. default en-US
async function detectLocale(cwd: string): Promise<Locale> {
  const codePactLocale = process.env.CODE_PACT_LOCALE;
  if (codePactLocale && KNOWN_LOCALES.has(codePactLocale as Locale)) {
    return codePactLocale as Locale;
  }

  try {
    const raw = await readFile(join(cwd, ".code-pact", "project.yaml"), "utf8");
    const data = parseYaml(raw) as { locale?: unknown };
    if (data && typeof data === "object" && data.locale != null) {
      const result = LocaleConfig.safeParse(data.locale);
      if (result.success) {
        const cfg = result.data;
        const code = typeof cfg === "string" ? cfg : (cfg.cli ?? cfg.default);
        if (KNOWN_LOCALES.has(code as Locale)) return code as Locale;
      }
    }
  } catch {
    // project.yaml absent or unparseable — continue
  }

  const lang = process.env.LANG ?? "";
  if (lang.startsWith("ja")) return "ja-JP";
  return "en-US";
}

// ---------------------------------------------------------------------------
// Command: init
// ---------------------------------------------------------------------------

async function cmdInit(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      locale: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      "non-interactive": { type: "boolean" },
      "sample-phase": { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const nonInteractive = values["non-interactive"] === true;
  const samplePhase = values["sample-phase"] === true;
  const cwd = process.cwd();
  const force = values.force === true;

  // Wizard branch — TTY, no input flags supplied, no JSON contract requested,
  // and the user did not opt out via --non-interactive. Any of these signals
  // routes through the flag-based path below to keep CI and automation
  // safe (matching docs/cli-contract.md). `--sample-phase` does not switch
  // modes — it only controls whether the sample phase is created.
  const hasInitFlag =
    typeof values.agent === "string" ||
    typeof values.locale === "string" ||
    values.force === true;
  const useWizard = isInteractive() && !hasInitFlag && !json && !nonInteractive;

  if (useWizard) {
    const wizardImpl = async (): Promise<number> => {
      try {
        const result = await runInitWizard({
          cwd,
          force,
          json: false,
          samplePhaseOverride: samplePhase ? true : undefined,
        });
        for (const f of result.created) {
          process.stderr.write(`  created  ${f}\n`);
        }
        for (const f of result.skipped) {
          process.stderr.write(`  skipped  ${f} (already exists)\n`);
        }
        process.stderr.write(`\n${m.init.done}\n`);
        return 0;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          (err as NodeJS.ErrnoException).code === "ALREADY_INITIALIZED"
        ) {
          process.stderr.write(`${m.init.alreadyInitialized(cwd)}\n`);
          return 2;
        }
        throw err;
      }
    };
    // P14 advisory write lock: only when `.code-pact/` already exists.
    // Fresh init bootstraps the project; acquiring the lock would
    // create `.code-pact/` as a side effect and trip `ALREADY_INITIALIZED`.
    // See codePactDirExists() doc-comment.
    if (await codePactDirExists(cwd)) {
      return withWriteLock(cwd, "init (wizard)", false, wizardImpl);
    }
    return wizardImpl();
  }

  // Automation mode = explicit --non-interactive OR detected CI=true.
  // Per docs/cli-contract.md, missing required flags must fail with
  // CONFIG_ERROR (exit 2) instead of silently picking defaults.
  const automation = nonInteractive || isCIEnv();
  const localeProvided = typeof values.locale === "string";
  const agentProvided = typeof values.agent === "string";

  if (automation && (!localeProvided || !agentProvided)) {
    const missing = [
      !localeProvided ? "--locale" : null,
      !agentProvided ? "--agent" : null,
    ]
      .filter((v): v is string => v !== null)
      .join(", ");
    const msg = `init in non-interactive/CI mode requires ${missing}. See docs/cli-contract.md.`;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

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

  const runImpl = async (): Promise<number> => {
    try {
      const result = await runInit({
        cwd,
        locale: initLocale,
        agents,
        force,
        json,
        ...(samplePhase ? { createSamplePhase: true } : {}),
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
  };

  // P14 advisory write lock: only when sample-phase will be created
  // (the only path that mutates roadmap.yaml / design/phases). Plain
  // init without --sample-phase writes only `.code-pact/` bootstrap
  // artifacts, which fall outside the design-mutation lock contract.
  // Additional gate: only acquire when `.code-pact/` already exists.
  // Fresh init bootstraps the directory; the lock helper would create
  // `.code-pact/` as a side effect and trip `ALREADY_INITIALIZED`.
  // See codePactDirExists() doc-comment.
  if (samplePhase && (await codePactDirExists(cwd))) {
    return withWriteLock(cwd, "init --sample-phase", json, runImpl);
  }
  return runImpl();
}

// ---------------------------------------------------------------------------
// Command: doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(argv: string[], globalJson: boolean): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const cwd = process.cwd();
  const result = await runDoctor(cwd);

  if (json) {
    if (result.ok) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: { code: "DOCTOR_FAILED", message: "Project health check failed" },
          data: result,
        })}\n`,
      );
    }
  } else {
    process.stdout.write(`${formatDoctor(result)}\n`);
  }

  const hasErrors = result.issues.some((i) => i.severity === "error");
  return hasErrors ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Command: validate
// ---------------------------------------------------------------------------

async function cmdValidate(argv: string[], globalJson: boolean): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      strict: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const strict = values.strict === true;
  const cwd = process.cwd();
  const result = await runValidate({ cwd, strict });

  if (json) {
    if (result.ok) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: {
            code: "VALIDATE_FAILED",
            message: strict ? "Project has issues (strict mode)" : "Project has errors",
          },
          data: result,
        })}\n`,
      );
    }
  } else {
    if (result.ok) {
      process.stdout.write("Project validation passed.\n");
    } else {
      for (const issue of result.issues) {
        const mark = issue.severity === "error" ? "[error]" : "[warn] ";
        process.stderr.write(`  ${mark} ${issue.code}: ${issue.message}\n`);
      }
      process.stderr.write("Validation failed.\n");
    }
  }

  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Command: spec (P18 — Spec Kit bridge)
// ---------------------------------------------------------------------------

async function cmdSpec(argv: string[], _locale: Locale, globalJson: boolean): Promise<number> {
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

// ---------------------------------------------------------------------------
// Command: recommend
// ---------------------------------------------------------------------------

async function cmdRecommend(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      phase: { type: "string" },
      task: { type: "string" },
      agent: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const phaseId = values.phase as string | undefined;
  const taskId = values.task as string | undefined;
  const agentName = (values.agent as string | undefined) ?? "claude-code";

  if (!phaseId || !taskId) {
    const msg = "recommend requires --phase and --task";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const cwd = process.cwd();

  try {
    const result = await runRecommend({ cwd, phaseId, taskId, agentName });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stdout.write(`${formatRecommend(result)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PHASE_NOT_FOUND") {
      const msg = m.recommend.phaseNotFound(phaseId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "PHASE_NOT_FOUND", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    if (code === "TASK_NOT_FOUND") {
      const msg = m.recommend.taskNotFound(taskId, phaseId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "TASK_NOT_FOUND", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    if (code === "AGENT_NOT_FOUND") {
      const msg = m.recommend.agentNotFound(agentName);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
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
// Command: plan
// ---------------------------------------------------------------------------

async function cmdPlan(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === "brief") {
    return cmdPlanBrief(rest, locale, globalJson);
  }

  if (subcommand === "prompt") {
    return cmdPlanPrompt(rest, locale, globalJson);
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

  const msg = `plan: unknown subcommand "${subcommand ?? ""}". Use: brief | prompt | constitution | lint | normalize | analyze`;
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
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const clipboard = values.clipboard === true;
  const cwd = process.cwd();

  const result = await runPlanPrompt({ cwd, locale, clipboard });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        data: {
          prompt: result.prompt,
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

  if (!result.hasBrief) {
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

// ---------------------------------------------------------------------------
// Command: adapter
// ---------------------------------------------------------------------------

async function cmdAdapter(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const sub = argv[0];

  if (sub === "list") return cmdAdapterList(argv.slice(1), globalJson);
  if (sub === "install") return cmdAdapterInstall(argv.slice(1), locale, globalJson);
  if (sub === "doctor") return cmdAdapterDoctor(argv.slice(1), locale, globalJson);
  if (sub === "upgrade") return cmdAdapterUpgrade(argv.slice(1), locale, globalJson);

  // Effective --json honors both the global flag (before the command) and
  // a --json embedded in the subcommand args (after the command).
  const effectiveJson = globalJson || argv.includes("--json");

  // Reject other unknown sub-words (anything that doesn't start with `-`).
  if (sub !== undefined && !sub.startsWith("-")) {
    const msg = `adapter: unknown subcommand "${sub}". Use: list | install | upgrade | doctor`;
    if (effectiveJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // Bare-form back-compat: `code-pact adapter [--agent X] ...` routes to
  // install with a deprecation notice on stderr (suppressed under --json
  // so agents consuming the JSON envelope are not surprised by an extra
  // stderr line). Removal is scheduled for v0.10.
  return cmdAdapterBareForm(argv, locale, globalJson);
}

async function cmdAdapterList(argv: string[], globalJson: boolean): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean" } },
    strict: false,
    allowPositionals: false,
  });
  const json = globalJson || values.json === true;
  const result = await runAdapterList({ cwd: process.cwd() });

  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    return 0;
  }

  for (const a of result.agents) {
    const flags = [
      a.enabled ? "enabled" : "disabled",
      a.experimental ? "experimental" : null,
      a.manifestPresent ? `manifest (${a.fileCount ?? 0} files)` : "no manifest",
      a.manifestInvalid ? "INVALID" : null,
    ]
      .filter((s): s is string => s !== null)
      .join(", ");
    process.stderr.write(`  ${a.name.padEnd(12)} ${flags}\n`);
  }
  return 0;
}

async function cmdAdapterInstall(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean" },
      json: { type: "boolean" },
      model: { type: "string" },
      "regen-skills": { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  const json = globalJson || values.json === true;
  const agentName = positionals[0];
  const force = values.force === true;
  const modelVersion = values.model as string | undefined;
  const regenSkills = values["regen-skills"] === true;

  if (!agentName) {
    const msg = "adapter install requires an <agent> argument (e.g. claude-code).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  return runAdapterInstallAndEmit({
    agentName,
    force,
    locale,
    modelVersion,
    regenSkills,
    json,
    m,
    deprecated: false,
  });
}

async function cmdAdapterDoctor(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const agentName = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runAdapterDoctor({ cwd, agentName, locale });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      if (result.issues.length === 0) {
        process.stderr.write("No adapter issues found.\n");
      } else {
        for (const issue of result.issues) {
          const sev = issue.severity === "error" ? "ERROR " : "WARN  ";
          const where = issue.path ? ` (${issue.path})` : "";
          process.stderr.write(
            `  ${sev} ${issue.code.padEnd(28)} [${issue.agent}] ${issue.message}${where}\n`,
          );
        }
      }
    }
    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "AGENT_NOT_FOUND") {
      const msg = messages[locale].adapter.agentNotFound(agentName ?? "");
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    throw err;
  }
}

async function cmdAdapterUpgrade(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean" },
      write: { type: "boolean" },
      force: { type: "boolean" },
      "accept-modified": { type: "boolean" },
      "regen-skills": { type: "boolean" },
      model: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: true,
  });

  const json = globalJson || values.json === true;
  const agentName = positionals[0];
  const check = values.check === true;
  const write = values.write === true;
  const force = values.force === true;
  const acceptModified = values["accept-modified"] === true;
  const regenSkills = values["regen-skills"] === true;
  const modelVersion = values.model as string | undefined;

  if (!agentName) {
    const msg = "adapter upgrade requires an <agent> argument (e.g. claude-code).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  if (check === write) {
    // Both true or both false → require explicit choice.
    const msg = check
      ? "adapter upgrade: --check and --write are mutually exclusive."
      : "adapter upgrade requires either --check or --write.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const mode = check ? "check" : "write";

  try {
    const result = await runAdapterUpgrade({
      cwd: process.cwd(),
      agentName,
      mode,
      force,
      acceptModified,
      locale,
      modelVersion,
      regenSkills,
    });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      for (const entry of result.plan) {
        if (entry.action === "skip") continue;
        process.stderr.write(
          `  ${entry.action.padEnd(18)} ${entry.relPath} [${entry.local} × ${entry.desired}]\n`,
        );
      }
      if (mode === "check") {
        if (result.clean) {
          process.stderr.write("Clean — no upgrade actions needed.\n");
        } else {
          process.stderr.write(`Drift detected — run "code-pact adapter upgrade ${agentName} --write" to apply.\n`);
        }
      } else {
        const refused = result.plan.filter((p) => p.action === "refuse").length;
        if (refused > 0) {
          process.stderr.write(
            `${refused} file(s) refused — re-run with --accept-modified to overwrite local changes.\n`,
          );
        } else {
          process.stderr.write(`${m.adapter.done(agentName)} Manifest: ${result.manifestPath}\n`);
        }
      }
    }

    // Exit codes:
    //   --check: 0 clean / 1 drift
    //   --write: 0 ok / 1 if anything was refused
    if (mode === "check") {
      return result.clean ? 0 : 1;
    }
    const hasRefused = result.plan.some((p) => p.action === "refuse");
    return hasRefused ? 1 : 0;
  } catch (err: unknown) {
    if (err instanceof Error) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "AGENT_NOT_FOUND") {
        const msg = m.adapter.agentNotFound(agentName);
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
          );
        } else {
          process.stderr.write(`${msg}\n`);
        }
        return 2;
      }
      if (code === "MANIFEST_NOT_FOUND") {
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "MANIFEST_NOT_FOUND", message: err.message } })}\n`,
          );
        } else {
          process.stderr.write(`${err.message}\n`);
        }
        return 2;
      }
    }
    throw err;
  }
}

async function cmdAdapterBareForm(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      model: { type: "string" },
      "regen-skills": { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const agentName = (values.agent as string | undefined) ?? "claude-code";
  const force = values.force === true;
  const modelVersion = values.model as string | undefined;
  const regenSkills = values["regen-skills"] === true;

  if (!json) {
    process.stderr.write(
      `[deprecated] bare 'code-pact adapter' is deprecated; use 'code-pact adapter install ${agentName}'. The bare form will be removed in v1.1.\n`,
    );
  }

  return runAdapterInstallAndEmit({
    agentName,
    force,
    locale,
    modelVersion,
    regenSkills,
    json,
    m,
    deprecated: true,
  });
}

async function runAdapterInstallAndEmit(args: {
  agentName: string;
  force: boolean;
  locale: Locale;
  modelVersion: string | undefined;
  regenSkills: boolean;
  json: boolean;
  m: (typeof messages)[Locale];
  deprecated: boolean;
}): Promise<number> {
  const { agentName, force, locale, modelVersion, regenSkills, json, m } = args;
  const cwd = process.cwd();

  try {
    const result = await runAdapterInstall({
      cwd,
      agentName,
      force,
      locale,
      modelVersion,
      regenSkills,
    });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      for (const f of result.created) process.stderr.write(`  created   ${f}\n`);
      for (const f of result.adopted) process.stderr.write(`  adopted   ${f}\n`);
      for (const f of result.skipped)
        process.stderr.write(`  skipped   ${f} (already exists)\n`);
      process.stderr.write(`  manifest  ${result.manifestPath}\n`);
      process.stderr.write(`${m.adapter.done(agentName)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "AGENT_NOT_FOUND") {
      const msg = m.adapter.agentNotFound(agentName);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "AGENT_NOT_FOUND", message: msg } })}\n`,
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
// Command: verify
// ---------------------------------------------------------------------------

async function cmdVerify(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      phase: { type: "string" },
      task: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const phaseId = values.phase as string | undefined;
  const taskId = values.task as string | undefined;
  const dryRun = values["dry-run"] === true;

  if (!phaseId || !taskId) {
    const msg = "verify requires --phase and --task";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const cwd = process.cwd();

  try {
    const result = await runVerify({ cwd, phaseId, taskId, dryRun });
    if (json) {
      if (result.ok) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: { checks: result.checks } })}\n`);
      } else {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "VERIFICATION_FAILED", message: "Verification failed" },
            data: { checks: result.checks },
          })}\n`,
        );
      }
    } else {
      for (const c of result.checks) {
        if (c.stdout) process.stderr.write(c.stdout);
        if (c.stderr) process.stderr.write(c.stderr);
      }
      process.stdout.write(`${formatVerify(result)}\n`);
    }
    return result.ok ? 0 : 1;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PHASE_NOT_FOUND") {
      const msg = m.verify.phaseNotFound(phaseId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "PHASE_NOT_FOUND", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    if (code === "TASK_NOT_FOUND") {
      const msg = m.verify.taskNotFound(taskId, phaseId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "TASK_NOT_FOUND", message: msg } })}\n`,
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
// Command: pack
// ---------------------------------------------------------------------------

async function cmdPack(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const m = messages[locale];
  const { values } = parseArgs({
    args: argv,
    options: {
      phase: { type: "string" },
      task: { type: "string" },
      agent: { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const phaseId = values.phase as string | undefined;
  const taskId = values.task as string | undefined;
  const agentName = (values.agent as string | undefined) ?? "claude-code";

  if (!phaseId || !taskId) {
    const msg = "pack requires --phase and --task";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const cwd = process.cwd();

  try {
    const result = await runPack({ cwd, phaseId, taskId, agentName });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stderr.write(`${m.pack.written(result.outputPath, result.charCount)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PHASE_NOT_FOUND") {
      const msg = m.pack.phaseNotFound(phaseId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "PHASE_NOT_FOUND", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    if (code === "TASK_NOT_FOUND") {
      const msg = m.pack.taskNotFound(taskId, phaseId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "TASK_NOT_FOUND", message: msg } })}\n`,
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
// Command: progress
// ---------------------------------------------------------------------------

async function cmdProgress(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const m = messages[locale];
  let values: Record<string, unknown>;
  try {
    ({ values } = strictParse("progress", argv, {
      baseline: { type: "string" },
      json: { type: "boolean" },
    }));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    // Strict parsing failed before --json could be read from values; fall back
    // to argv inspection so post-command --json is still honored.
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
  const baselineName = (values.baseline as string | undefined) ?? "initial";
  const cwd = process.cwd();

  try {
    const result = await runProgress({ cwd, baseline: baselineName });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stdout.write(`${formatProgress(result)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "BASELINE_NOT_FOUND") {
      const msg = m.progress.baselineNotFound(baselineName);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "BASELINE_NOT_FOUND", message: msg } })}\n`,
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
// Command: plan lint (v0.7)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command: plan normalize (v0.7)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command: plan analyze (v0.7)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Command: phase
// ---------------------------------------------------------------------------

async function cmdPhase(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const m = messages[locale];
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const cwd = process.cwd();

  // ---- phase add ----
  if (subcommand === "add") {
    let values: Record<string, unknown>;
    try {
      ({ values } = strictParse("phase add", rest, {
        id: { type: "string" },
        name: { type: "string" },
        weight: { type: "string" },
        objective: { type: "string" },
        confidence: { type: "string" },
        risk: { type: "string" },
        "verify-command": { type: "string", multiple: true },
        "done-criterion": { type: "string", multiple: true },
        json: { type: "boolean" },
        "non-interactive": { type: "boolean" },
      }));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      const msg = `${err.message}. Quote multi-word values, e.g. --verify-command "node --version".`;
      const json = globalJson || rest.includes("--json");
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    const json = globalJson || values.json === true;
    const nonInteractive = values["non-interactive"] === true;
    const id = values.id as string | undefined;
    const name = values.name as string | undefined;
    const weightRaw = values.weight as string | undefined;
    const objective = values.objective as string | undefined;

    const missingRequiredFlags = !id || !name || !weightRaw || !objective;

    // Wizard branch: TTY, flags missing, not non-interactive, not JSON
    if (missingRequiredFlags && isInteractive() && !nonInteractive && !json) {
      const { Prompter } = await import("./lib/prompt.ts");
      const prompter = Prompter.fromIO();
      let input: Awaited<ReturnType<typeof runPhaseWizard>>;
      try {
        input = await runPhaseWizard(prompter, messages[locale].wizard.phase);
      } catch (err) {
        prompter.close();
        throw err;
      }
      // Wizard prompts complete — acquire the P14 write lock before
      // the phase YAML / roadmap.yaml mutation. Release in finally.
      return withWriteLock(
        cwd,
        `phase add ${input.id}`,
        false /* wizard branch never uses --json */,
        async (): Promise<number> => {
          try {
            const result = await runPhaseAdd({
              cwd,
              id: input.id,
              name: input.name,
              weight: input.weight,
              objective: input.objective,
              confidence: input.confidence,
              risk: input.risk,
              verifyCommands: input.verifyCommands,
              definitionOfDone: input.doneCriteria,
            });
            process.stderr.write(`${m.phase.added(input.id, result.path)}\n`);
            return 0;
          } catch (err: unknown) {
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === "DUPLICATE_PHASE_ID") {
              const phaseId = err.message.match(/"([^"]+)"/)?.[1] ?? "";
              process.stderr.write(`${m.phase.duplicateId(phaseId)}\n`);
              return 1;
            }
            // P14 reserved-id (TUTORIAL) block surfaces as CONFIG_ERROR.
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
              process.stderr.write(`${err.message}\n`);
              return 2;
            }
            throw err;
          } finally {
            prompter.close();
          }
        },
      );
    }

    if (missingRequiredFlags) {
      const msg = nonInteractive
        ? m.cliContract.nonInteractiveMissing("--id, --name, --weight, --objective")
        : "phase add requires --id, --name, --weight, --objective";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    const weight = Number(weightRaw);
    if (!Number.isFinite(weight) || weight <= 0) {
      const msg = "--weight must be a positive number";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    const confidence = (values.confidence as string | undefined) ?? "medium";
    const risk = (values.risk as string | undefined) ?? "medium";
    const verifyCommands = (values["verify-command"] as string[] | undefined) ?? ["pnpm test"];
    const definitionOfDone = (values["done-criterion"] as string[] | undefined) ?? [
      "All tasks are done",
    ];

    // P14 advisory write lock: serializes the phase YAML + roadmap
    // mutation against concurrent design mutations.
    return withWriteLock(cwd, `phase add ${id}`, json, async (): Promise<number> => {
      try {
        const result = await runPhaseAdd({
          cwd,
          id,
          name,
          weight,
          objective,
          confidence: confidence as "low" | "medium" | "high",
          risk: risk as "low" | "medium" | "high",
          verifyCommands,
          definitionOfDone,
        });
        if (json) {
          process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
        } else {
          process.stderr.write(`${m.phase.added(id, result.path)}\n`);
        }
        return 0;
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "DUPLICATE_PHASE_ID") {
          const msg = m.phase.duplicateId(id);
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: false, error: { code: "DUPLICATE_PHASE_ID", message: msg } })}\n`,
            );
          } else {
            process.stderr.write(`${msg}\n`);
          }
          return 2;
        }
        // P14 reserved-id (TUTORIAL) block surfaces as CONFIG_ERROR from
        // createPhase. Propagate the message verbatim — it already names
        // the reserved id and points at `init --sample-phase`.
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: err.message } })}\n`,
            );
          } else {
            process.stderr.write(`${err.message}\n`);
          }
          return 2;
        }
        throw err;
      }
    });
  }

  // ---- phase new ----
  if (subcommand === "new") {
    if (!isInteractive()) {
      const msg =
        "phase new is interactive and cannot run in a non-TTY context. Use \`phase add\` with flags instead.";
      if (globalJson) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    const initialName = rest[0]?.startsWith("-") ? undefined : rest[0];
    // P14 advisory write lock: serialize the wizard's createPhase
    // write. The lock IS held through the wizard prompts — see
    // RFC § Open question 1 for the prompt-hold trade-off.
    return withWriteLock(
      cwd,
      `phase new${initialName ? ` ${initialName}` : ""}`,
      globalJson,
      async (): Promise<number> => {
        try {
          const result = await runPhaseNew({ cwd, locale, initialName });
          if (globalJson) {
            process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
          } else {
            process.stderr.write(`${m.phase.added(result.ref.id, result.path)}\n`);
          }
          return 0;
        } catch (err: unknown) {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "DUPLICATE_PHASE_ID") {
            const id =
              err.message.match(/"([^"]+)"/)?.[1] ?? "";
            const msg = m.phase.duplicateId(id);
            if (globalJson) {
              process.stdout.write(
                `${JSON.stringify({ ok: false, error: { code: "DUPLICATE_PHASE_ID", message: msg } })}\n`,
              );
            } else {
              process.stderr.write(`${msg}\n`);
            }
            return 2;
          }
          // P14 reserved-id (TUTORIAL) block surfaces as CONFIG_ERROR from
          // createPhase (the wizard never asks for the bypass flag).
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
            if (globalJson) {
              process.stdout.write(
                `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: err.message } })}\n`,
              );
            } else {
              process.stderr.write(`${err.message}\n`);
            }
            return 2;
          }
          throw err;
        }
      },
    );
  }

  // ---- phase ls ----
  if (subcommand === "ls") {
    let values: Record<string, unknown>;
    try {
      ({ values } = strictParse("phase ls", rest, {
        status: { type: "string" },
        json: { type: "boolean" },
      }));
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
    const statusFilter = values.status as PhaseStatus | undefined;

    try {
      const items = await runPhaseLs({ cwd, status: statusFilter });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: items })}\n`);
      } else {
        process.stdout.write(`${formatPhaseLsTable(items)}\n`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 3;
    }
  }

  // ---- phase show ----
  if (subcommand === "show") {
    const { values, positionals: pos } = parseArgs({
      args: rest,
      options: { json: { type: "boolean" } },
      strict: false,
      allowPositionals: true,
    });

    const json = globalJson || values.json === true;
    const id = pos[0];
    if (!id) {
      const msg = "phase show requires a phase ID";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    try {
      const phase = await runPhaseShow({ cwd, id });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: phase })}\n`);
      } else {
        process.stdout.write(`${formatPhaseShow(phase)}\n`);
      }
      return 0;
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "PHASE_NOT_FOUND") {
        const msg = m.phase.notFound(id);
        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, error: { code: "PHASE_NOT_FOUND", message: msg } })}\n`,
          );
        } else {
          process.stderr.write(`${msg}\n`);
        }
        return 2;
      }
      throw err;
    }
  }

  // ---- phase import ----
  if (subcommand === "reconcile") {
    return cmdPhaseReconcile(rest, locale, globalJson);
  }

  if (subcommand === "runbook") {
    return cmdPhaseRunbook(rest, locale, globalJson);
  }

  if (subcommand === "import") {
    let values: Record<string, unknown>;
    let positionals: string[];
    try {
      ({ values, positionals } = strictParse(
        "phase import",
        rest,
        {
          force: { type: "boolean" },
          strict: { type: "boolean" },
          json: { type: "boolean" },
        },
        { allowPositionals: true },
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
    const force = values.force === true;
    const strict = values.strict === true;
    const inputPath = positionals[0];
    if (!inputPath) {
      const msg = "phase import requires an input YAML path, e.g. `phase import design/roadmap-draft.yaml`";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }

    // P14 advisory write lock: a single acquisition covers
    // `runPhaseImport`'s multi-phase apply loop (every `createPhase`
    // call inside runs under the same lock — batch transactionality).
    // `createPhase` itself stays lock-agnostic so the inner calls
    // don't try to re-acquire.
    return withWriteLock(cwd, "phase import", json, async (): Promise<number> => {
      try {
        const result = await runPhaseImport({ cwd, inputPath, force, strict });
        if (json) {
          process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
        } else {
          process.stderr.write(`${m.phase.importDone(result.imported_phases.length, result.imported_tasks.length, result.skipped_phases.length)}\n`);
          for (const cf of result.completed_fields) {
            process.stderr.write(`  completed defaults for ${cf.taskId}: ${cf.fields.join(", ")}\n`);
          }
        }
        return 0;
      } catch (err: unknown) {
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
    });
  }

  // Unknown subcommand
  const msg = `phase: unknown subcommand "${subcommand ?? ""}". Use: add | new | ls | show | import | reconcile | runbook`;
  if (globalJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}

// ---------------------------------------------------------------------------
// Command: task
// ---------------------------------------------------------------------------

async function cmdTask(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === "context") {
    return cmdTaskContext(rest, locale, globalJson);
  }
  if (subcommand === "complete") {
    return cmdTaskComplete(rest, locale, globalJson);
  }
  if (subcommand === "add") {
    return cmdTaskAdd(rest, locale, globalJson);
  }
  if (subcommand === "prepare") {
    return cmdTaskPrepare(rest, locale, globalJson);
  }
  if (subcommand === "start") {
    return cmdTaskStart(rest, locale, globalJson);
  }
  if (subcommand === "status") {
    return cmdTaskStatus(rest, locale, globalJson);
  }
  if (subcommand === "block") {
    return cmdTaskBlock(rest, locale, globalJson);
  }
  if (subcommand === "resume") {
    return cmdTaskResume(rest, locale, globalJson);
  }
  if (subcommand === "finalize") {
    return cmdTaskFinalize(rest, locale, globalJson);
  }
  if (subcommand === "runbook") {
    return cmdTaskRunbook(rest, locale, globalJson);
  }

  const msg = `task: unknown subcommand "${subcommand ?? ""}". Use: add | context | prepare | start | status | block | resume | complete | finalize | runbook`;
  if (globalJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}

// Non-interactive-only flags for `task add` (v1.4 P13-T3). Presence of
// any of these flags without `--description` triggers CONFIG_ERROR — the
// runbook never silently falls through to the wizard or silently ignores
// flags, per the P13 RFC § Task creation non-TTY model.
//
// `--id` and `--json` are NOT in this set — they are valid in both wizard
// and non-interactive paths.
const TASK_ADD_NON_INTERACTIVE_ONLY_FLAGS = [
  "description",
  "type",
  "ambiguity",
  "risk",
  "context-size",
  "write-surface",
  "verification-strength",
  "expected-duration",
  "depends-on",
  "decision-ref",
  "read",
  "write",
  "acceptance-ref",
] as const;

function emitConfigError(
  message: string,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message } })}\n`,
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
}

async function cmdTaskAdd(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const cwd = process.cwd();

  // Parse all flags via the stdlib parser. P10 fields accept multiple
  // occurrences (e.g. `--depends-on a --depends-on b`); comma-separated
  // values are intentionally not parsed (path-with-comma ambiguity).
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        id: { type: "string" },
        description: { type: "string" },
        type: { type: "string" },
        ambiguity: { type: "string" },
        risk: { type: "string" },
        "context-size": { type: "string" },
        "write-surface": { type: "string" },
        "verification-strength": { type: "string" },
        "expected-duration": { type: "string" },
        "depends-on": { type: "string", multiple: true },
        "decision-ref": { type: "string", multiple: true },
        read: { type: "string", multiple: true },
        write: { type: "string", multiple: true },
        "acceptance-ref": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitConfigError(message, globalJson || argv.includes("--json"));
    return 2;
  }

  const json = globalJson || values.json === true;
  const phaseId = positionals[0];
  const explicitId =
    typeof values.id === "string" ? (values.id as string) : undefined;

  if (!phaseId) {
    emitConfigError(
      "task add requires a phase id: code-pact task add <phase-id>",
      json,
    );
    return 2;
  }

  const description =
    typeof values.description === "string"
      ? (values.description as string)
      : undefined;

  // Detect any non-interactive-only flag that was passed.
  const nonInteractiveFlagsSeen = TASK_ADD_NON_INTERACTIVE_ONLY_FLAGS.filter(
    (flag) => {
      if (flag === "description") return false; // handled separately
      const v = values[flag];
      if (Array.isArray(v)) return v.length > 0;
      return typeof v === "string";
    },
  );

  // 3-branch resolution per RFC § Task creation non-TTY model:
  //   (a) --description present → non-interactive
  //   (b) --description absent, no other non-interactive flags, TTY → wizard
  //   (c) --description absent, no other non-interactive flags, no TTY →
  //       CONFIG_ERROR (TTY-required message, updated to mention alternative)
  //   (d) --description absent, non-interactive flag(s) present →
  //       CONFIG_ERROR (never silently enter the wizard, never silently ignore)
  if (description === undefined && nonInteractiveFlagsSeen.length > 0) {
    emitConfigError(
      `task add: non-interactive flag(s) provided without --description: ${nonInteractiveFlagsSeen
        .map((f) => `--${f}`)
        .join(", ")}. Pass --description "<text>" to use the non-interactive path, or omit the flags to use the wizard.`,
      json,
    );
    return 2;
  }

  if (description === undefined && !isInteractive()) {
    emitConfigError(
      `task add is interactive and requires a TTY. Use \`task add ${phaseId} --description "<text>" --type <type>\` for the non-interactive path (v1.4+), or \`phase import\` for bulk task creation.`,
      json,
    );
    return 2;
  }

  // Build non-interactive spec when --description is present. --type is
  // required in this mode; other readiness/P10 flags are optional.
  let nonInteractiveSpec: TaskAddNonInteractiveSpec | undefined;
  if (description !== undefined) {
    const typeRaw =
      typeof values.type === "string" ? (values.type as string) : undefined;
    if (typeRaw === undefined) {
      emitConfigError(
        "task add: --type is required when --description is provided. Valid values: " +
          TaskType.options.join(", "),
        json,
      );
      return 2;
    }
    const typeParsed = TaskType.safeParse(typeRaw);
    if (!typeParsed.success) {
      emitConfigError(
        `task add: invalid --type "${typeRaw}". Valid values: ${TaskType.options.join(", ")}`,
        json,
      );
      return 2;
    }

    const parseEnum = <T extends { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>(
      schema: T,
      raw: unknown,
      flagName: string,
      validValues: readonly string[],
    ): { ok: true; value: unknown | undefined } | { ok: false } => {
      if (raw === undefined) return { ok: true, value: undefined };
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        emitConfigError(
          `task add: invalid --${flagName} "${String(raw)}". Valid values: ${validValues.join(", ")}`,
          json,
        );
        return { ok: false };
      }
      return { ok: true, value: parsed.data };
    };

    const ambiguity = parseEnum(AmbiguityLevel, values.ambiguity, "ambiguity", AmbiguityLevel.options);
    if (!ambiguity.ok) return 2;
    const risk = parseEnum(RiskLevel, values.risk, "risk", RiskLevel.options);
    if (!risk.ok) return 2;
    const contextSize = parseEnum(ContextSize, values["context-size"], "context-size", ContextSize.options);
    if (!contextSize.ok) return 2;
    const writeSurface = parseEnum(WriteSurface, values["write-surface"], "write-surface", WriteSurface.options);
    if (!writeSurface.ok) return 2;
    const verificationStrength = parseEnum(
      VerificationStrength,
      values["verification-strength"],
      "verification-strength",
      VerificationStrength.options,
    );
    if (!verificationStrength.ok) return 2;
    const expectedDuration = parseEnum(
      ExpectedDuration,
      values["expected-duration"],
      "expected-duration",
      ExpectedDuration.options,
    );
    if (!expectedDuration.ok) return 2;

    const asStringArray = (raw: unknown): string[] | undefined => {
      if (raw === undefined) return undefined;
      if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string");
      return undefined;
    };

    nonInteractiveSpec = {
      description,
      type: typeParsed.data,
      ...(ambiguity.value !== undefined ? { ambiguity: ambiguity.value as TaskAddNonInteractiveSpec["ambiguity"] } : {}),
      ...(risk.value !== undefined ? { risk: risk.value as TaskAddNonInteractiveSpec["risk"] } : {}),
      ...(contextSize.value !== undefined ? { context_size: contextSize.value as TaskAddNonInteractiveSpec["context_size"] } : {}),
      ...(writeSurface.value !== undefined ? { write_surface: writeSurface.value as TaskAddNonInteractiveSpec["write_surface"] } : {}),
      ...(verificationStrength.value !== undefined ? { verification_strength: verificationStrength.value as TaskAddNonInteractiveSpec["verification_strength"] } : {}),
      ...(expectedDuration.value !== undefined ? { expected_duration: expectedDuration.value as TaskAddNonInteractiveSpec["expected_duration"] } : {}),
      ...(asStringArray(values["depends-on"]) ? { depends_on: asStringArray(values["depends-on"])! } : {}),
      ...(asStringArray(values["decision-ref"]) ? { decision_refs: asStringArray(values["decision-ref"])! } : {}),
      ...(asStringArray(values.read) ? { reads: asStringArray(values.read)! } : {}),
      ...(asStringArray(values.write) ? { writes: asStringArray(values.write)! } : {}),
      ...(asStringArray(values["acceptance-ref"]) ? { acceptance_refs: asStringArray(values["acceptance-ref"])! } : {}),
    };
  }

  // P14 advisory write lock: serialize task-add (phase YAML write)
  // against concurrent design mutations. Wizard prompts (when no
  // --description is supplied) ALSO run under the lock — see RFC
  // § Open question 1 for the prompt-hold trade-off.
  return withWriteLock(
    cwd,
    nonInteractiveSpec !== undefined
      ? `task add ${phaseId} --description "..."`
      : `task add ${phaseId}`,
    json,
    async (): Promise<number> => {
      try {
        const result = await runTaskAdd({
          cwd,
          phaseId,
          locale,
          id: explicitId,
          ...(nonInteractiveSpec ? { nonInteractive: nonInteractiveSpec } : {}),
        });
        if (json) {
          process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
        } else {
          process.stderr.write(`${m.task.added(result.taskId, result.phaseId, result.phasePath)}\n`);
        }
        return 0;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : String(err);
        if (code === "PHASE_NOT_FOUND" || code === "DUPLICATE_TASK_ID") {
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ok: false, error: { code, message } })}\n`,
            );
          } else {
            process.stderr.write(`${message}\n`);
          }
          return code === "PHASE_NOT_FOUND" ? 2 : 1;
        }
        throw err;
      }
    },
  );
}

async function cmdTaskContext(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task context",
      argv,
      {
        agent: { type: "string" },
        json: { type: "boolean" },
        explain: { type: "boolean" },
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
  const explain = values.explain === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task context requires a task id (e.g. `task context P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const pack = await runTaskContext({
      cwd,
      taskId,
      agent,
      ...(explain ? { explain: true as const } : {}),
    });
    if (json) {
      const data: Record<string, unknown> = {
        task_id: pack.taskId,
        phase_id: pack.phaseId,
        agent: pack.agent,
        char_count: pack.charCount,
        content: pack.content,
      };
      if (explain) {
        data.total_bytes = pack.totalBytes;
        data.context_pack_bytes = pack.totalBytes;
        data.sections = pack.sections;
        data.excluded = pack.excluded;
      }
      process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    } else if (explain) {
      // --explain without --json prints the section breakdown table
      // instead of the pack body.
      const lines: string[] = [];
      lines.push(`Task:        ${pack.phaseId} / ${pack.taskId}`);
      lines.push(`Agent:       ${pack.agent}`);
      lines.push(`Total bytes: ${pack.totalBytes}`);
      lines.push(``);
      lines.push(`Included sections:`);
      for (const s of pack.sections ?? []) {
        const padded = String(s.bytes).padStart(7);
        lines.push(`  ${padded} bytes  ${s.name.padEnd(24)} ${s.reason_code}`);
      }
      if ((pack.excluded ?? []).length > 0) {
        lines.push(``);
        lines.push(`Excluded sections:`);
        for (const x of pack.excluded ?? []) {
          lines.push(`              ${x.name.padEnd(24)} ${x.reason_code}`);
        }
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    } else {
      process.stdout.write(pack.content);
      if (!pack.content.endsWith("\n")) process.stdout.write("\n");
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    let msg: string;
    let outCode: string;
    switch (code) {
      case "TASK_NOT_FOUND":
        msg = m.task.context.taskNotFound(taskId);
        outCode = "TASK_NOT_FOUND";
        break;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        msg = m.task.context.ambiguous(taskId, phases);
        outCode = "AMBIGUOUS_TASK_ID";
        break;
      }
      case "AGENT_NOT_ENABLED":
        msg = m.task.context.agentNotEnabled(agent ?? "");
        outCode = "AGENT_NOT_ENABLED";
        break;
      case "AGENT_NOT_FOUND":
        msg = m.task.context.agentNotFound(agent ?? "");
        outCode = "AGENT_NOT_FOUND";
        break;
      default:
        throw err;
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
}

async function cmdTaskPrepare(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task prepare",
      argv,
      {
        agent: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
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
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task prepare requires a task id (e.g. `task prepare P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const agent = values.agent as string | undefined;
  const dryRun = values["dry-run"] === true;
  const cwd = process.cwd();

  try {
    const result = await runTaskPrepare({ cwd, taskId, agent, dryRun });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      const lines: string[] = [];
      lines.push(`Task:           ${result.phase_id} / ${result.task_id}`);
      lines.push(`Agent:          ${result.agent}`);
      lines.push(`Current state:  ${result.current_state}`);
      lines.push(`Next action:    ${result.next_action.type}`);
      lines.push(`                ${result.next_action.message}`);
      if (result.recommendation) {
        lines.push(
          `Recommendation: tier=${result.recommendation.tier} model=${result.recommendation.modelId} effort=${result.recommendation.effort}`,
        );
      }
      if (result.blocked_by.length > 0) {
        lines.push(`Blocked by:     ${result.blocked_by.join(", ")}`);
      }
      if (result.context_pack_path) {
        lines.push(
          `Context pack:   ${result.context_pack_path} (${result.context_pack_bytes} bytes)`,
        );
      } else if (result.would_write_context_pack_path) {
        lines.push(
          `Context pack:   (dry-run) would write to ${result.would_write_context_pack_path} (${result.context_pack_bytes} bytes)`,
        );
      }
      lines.push("");
      lines.push("Commands:");
      lines.push(`  context:  ${result.commands.context}`);
      lines.push(`  start:    ${result.commands.start}`);
      lines.push(`  verify:   ${result.commands.verify}`);
      lines.push(`  complete: ${result.commands.complete}`);
      lines.push(`  finalize: ${result.commands.finalize}`);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    let msg: string;
    let outCode: string;
    switch (code) {
      case "TASK_NOT_FOUND":
        msg = m.task.context.taskNotFound(taskId);
        outCode = "TASK_NOT_FOUND";
        break;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        msg = m.task.context.ambiguous(taskId, phases);
        outCode = "AMBIGUOUS_TASK_ID";
        break;
      }
      case "AGENT_NOT_ENABLED":
        msg = m.task.context.agentNotEnabled(agent ?? "");
        outCode = "AGENT_NOT_ENABLED";
        break;
      case "AGENT_NOT_FOUND":
        msg = m.task.context.agentNotFound(agent ?? "");
        outCode = "AGENT_NOT_FOUND";
        break;
      default:
        throw err;
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
}

async function cmdTaskComplete(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task complete",
      argv,
      {
        agent: { type: "string" },
        json: { type: "boolean" },
        "dry-run": { type: "boolean" },
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
  const dryRun = values["dry-run"] === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task complete requires a task id (e.g. `task complete P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskComplete({ cwd, taskId, agent, dryRun });

    if (result.kind === "already_done") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              already_done: true,
              task_id: result.task_id,
              phase_id: result.phase_id,
              agent: result.agent,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(`${m.task.complete.alreadyDone(taskId)}\n`);
      }
      return 0;
    }

    if (result.kind === "dry_run") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              dry_run: true,
              task_id: result.task_id,
              phase_id: result.phase_id,
              agent: result.agent,
              would_append: result.would_append,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(`${m.task.complete.dryRun(taskId)}\n`);
      }
      return 0;
    }

    // result.kind === "done"
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            task_id: result.task_id,
            phase_id: result.phase_id,
            agent: result.agent,
            event: result.event,
            verify: { ok: true, checks: result.verify.checks },
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${m.task.complete.success(taskId, result.agent)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "VERIFICATION_FAILED") {
      const checks =
        (err as NodeJS.ErrnoException & { checks?: unknown[] }).checks ?? [];
      const msg = m.task.complete.verificationFailed(taskId);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: { code: "VERIFICATION_FAILED", message: msg },
            data: { task_id: taskId, verify: { ok: false, checks } },
          })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 1;
    }

    let msg: string;
    let outCode: string;
    switch (code) {
      case "TASK_NOT_FOUND":
        msg = m.task.complete.taskNotFound(taskId);
        outCode = "TASK_NOT_FOUND";
        break;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        msg = m.task.complete.ambiguous(taskId, phases);
        outCode = "AMBIGUOUS_TASK_ID";
        break;
      }
      case "AGENT_NOT_ENABLED":
        msg = m.task.complete.agentNotEnabled(agent ?? "");
        outCode = "AGENT_NOT_ENABLED";
        break;
      case "AGENT_NOT_FOUND":
        msg = m.task.complete.agentNotFound(agent ?? "");
        outCode = "AGENT_NOT_FOUND";
        break;
      case "INVALID_TASK_TRANSITION": {
        const current =
          (err as NodeJS.ErrnoException & { current?: string }).current ?? "";
        msg = m.task.complete.invalidTransition(taskId, current);
        outCode = "INVALID_TASK_TRANSITION";
        break;
      }
      default:
        throw err;
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Command: task finalize (v1.2 P11)
// ---------------------------------------------------------------------------

async function cmdTaskFinalize(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task finalize",
      argv,
      {
        json: { type: "boolean" },
        write: { type: "boolean" },
        "base-ref": { type: "string" },
        "audit-strict": { type: "boolean" },
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
  const baseRef = typeof values["base-ref"] === "string" ? values["base-ref"] : undefined;
  const auditStrict = values["audit-strict"] === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task finalize requires a task id (e.g. `task finalize P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // v1.6 P15-T1: `--base-ref` requires `--json` so human mode never
  // spawns git and the audit field always lands in a machine-readable
  // envelope. Silent ignore would mislead users into thinking the
  // branch-level audit ran when it did not.
  if (baseRef !== undefined && !json) {
    const msg = "task finalize --base-ref requires --json (write_audit is JSON-only in v1.6).";
    process.stderr.write(`CONFIG_ERROR: ${msg}\n`);
    return 2;
  }

  // v1.6 P15-T6: `--audit-strict` requires `--json` for the same
  // reason — the audit only runs in JSON mode, so a strict gate
  // without --json would silently degrade to a no-op.
  if (auditStrict && !json) {
    const msg = "task finalize --audit-strict requires --json (the audit it gates is JSON-only in v1.6).";
    process.stderr.write(`CONFIG_ERROR: ${msg}\n`);
    return 2;
  }

  const cwd = process.cwd();
  const includeWriteAudit = json;

  const runImpl = async (): Promise<number> => {
  try {
    const result = await runTaskFinalize({
      cwd,
      taskId,
      write,
      baseRef,
      includeWriteAudit,
      auditStrict,
    });

    if (result.kind === "already_finalized") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              kind: "already_finalized",
              task_id: result.task_id,
              phase_id: result.phase_id,
              file: result.file,
              current_status: result.current_status,
              target_status: result.target_status,
              acceptance_refs_check: result.acceptance_refs_check,
              declared_writes: result.declared_writes,
              depends_on_check: result.depends_on_check,
              write_audit: result.write_audit,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(`${m.task.finalize.alreadyFinalized(taskId)}\n`);
      }
      return 0;
    }

    if (result.kind === "would_finalize") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              kind: "would_finalize",
              task_id: result.task_id,
              phase_id: result.phase_id,
              file: result.file,
              current_status: result.current_status,
              target_status: result.target_status,
              planned_writes: result.planned_writes,
              acceptance_refs_check: result.acceptance_refs_check,
              declared_writes: result.declared_writes,
              depends_on_check: result.depends_on_check,
              write_audit: result.write_audit,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(
          `${m.task.finalize.wouldFinalize(taskId, result.file)}\n`,
        );
      }
      return 0;
    }

    // result.kind === "finalized"
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            kind: "finalized",
            task_id: result.task_id,
            phase_id: result.phase_id,
            file: result.file,
            current_status: result.current_status,
            target_status: result.target_status,
            applied_writes: result.applied_writes,
            skipped_writes: result.skipped_writes,
            acceptance_refs_check: result.acceptance_refs_check,
            declared_writes: result.declared_writes,
            depends_on_check: result.depends_on_check,
            write_audit: result.write_audit,
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${m.task.finalize.success(taskId, result.file)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;

    // v1.6 P15-T6: strict-audit failure surfaces as
    // WRITES_AUDIT_STRICT_FAILED with exit 1 (NOT 2 — this is not
    // a CONFIG_ERROR; the invocation was well-formed but the audit
    // gate refused to proceed). The envelope carries the full audit
    // result so consumers see the same `write_audit` shape they
    // would on the success path, plus `applied: false` to make the
    // no-mutation guarantee machine-readable.
    if (err instanceof TaskFinalizeAuditStrictError) {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            error: {
              code: "WRITES_AUDIT_STRICT_FAILED",
              message: err.message,
            },
            data: {
              task_id: err.task_id,
              phase_id: err.phase_id,
              applied: err.applied,
              write_audit: err.write_audit,
            },
          })}\n`,
        );
      } else {
        process.stderr.write(`${err.message}\n`);
      }
      return 1;
    }

    const code = (err as NodeJS.ErrnoException).code;

    let msg: string;
    let outCode: string;
    let extraData: Record<string, unknown> | undefined;

    switch (code) {
      case "TASK_NOT_FOUND":
        msg = m.task.finalize.taskNotFound(taskId);
        outCode = "TASK_NOT_FOUND";
        break;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        msg = m.task.finalize.ambiguous(taskId, phases);
        outCode = "AMBIGUOUS_TASK_ID";
        break;
      }
      case "TASK_FINALIZE_NOT_ELIGIBLE": {
        const current =
          (err as NodeJS.ErrnoException & { current?: string }).current ?? "";
        const phase_id =
          (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id ?? "";
        msg = m.task.finalize.notEligible(taskId, current);
        outCode = "TASK_FINALIZE_NOT_ELIGIBLE";
        extraData = { task_id: taskId, phase_id, current };
        break;
      }
      case "TASK_FINALIZE_WRITE_REFUSED": {
        const reason =
          (err as NodeJS.ErrnoException & { reason?: string }).reason ?? "";
        const file =
          (err as NodeJS.ErrnoException & { file?: string }).file ?? "";
        msg = m.task.finalize.writeRefused(taskId, err.message);
        outCode = "TASK_FINALIZE_WRITE_REFUSED";
        extraData = { task_id: taskId, file, reason };
        break;
      }
      default:
        throw err;
    }
    if (json) {
      const envelope: Record<string, unknown> = {
        ok: false,
        error: { code: outCode, message: msg },
      };
      if (extraData) envelope.data = extraData;
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  };

  // P14: only --write mutates phase YAML; dry-run is lock-free.
  if (write) {
    return withWriteLock(
      cwd,
      `task finalize ${taskId} --write`,
      json,
      runImpl,
    );
  }
  return runImpl();
}

// ---------------------------------------------------------------------------
// Command: task runbook (v1.3 P12)
// ---------------------------------------------------------------------------

async function cmdTaskRunbook(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task runbook",
      argv,
      {
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
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task runbook requires a task id (e.g. `task runbook P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const cwd = process.cwd();

  try {
    const result = await runTaskRunbook({ cwd, taskId });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stdout.write(`${m.task.runbook.header(taskId, result.phase_id)}\n`);
      process.stdout.write(`${m.task.runbook.stateSummary(result.state_summary)}\n`);
      if (result.state_summary.depends_on.length > 0) {
        process.stdout.write("  depends_on:\n");
        for (const dep of result.state_summary.depends_on) {
          const locator = dep.phase_id
            ? ` (cross-phase: ${dep.phase_id})`
            : "";
          const satisfied = dep.satisfied ? "satisfied" : "unsatisfied";
          process.stdout.write(
            `    - ${dep.task_id}${locator}: derived=${dep.current} (${satisfied})\n`,
          );
        }
      }
      if (result.next_steps.length === 0) {
        process.stdout.write(`${m.task.runbook.noSteps}\n`);
      } else {
        for (let i = 0; i < result.next_steps.length; i++) {
          const step = result.next_steps[i]!;
          process.stdout.write(`${m.task.runbook.step(i + 1, step)}\n`);
        }
      }
    }
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = (err as Error).message;
    let outCode = "INTERNAL_ERROR";
    let extraData: Record<string, unknown> | null = null;
    if (code === "TASK_NOT_FOUND") {
      outCode = "TASK_NOT_FOUND";
    } else if (code === "AMBIGUOUS_TASK_ID") {
      outCode = "AMBIGUOUS_TASK_ID";
      const phases = (err as NodeJS.ErrnoException & { phases?: string[] }).phases;
      if (phases) extraData = { phases };
    } else if (code === "CONFIG_ERROR") {
      outCode = "CONFIG_ERROR";
    }
    if (json) {
      const envelope: Record<string, unknown> = {
        ok: false,
        error: { code: outCode, message: msg },
      };
      if (extraData) envelope.data = extraData;
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Command: phase reconcile (v1.2 P11)
// ---------------------------------------------------------------------------

async function cmdPhaseReconcile(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "phase reconcile",
      argv,
      {
        json: { type: "boolean" },
        write: { type: "boolean" },
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
  const phaseId = positionals[0];
  if (!phaseId) {
    const msg =
      "phase reconcile requires a phase id (e.g. `phase reconcile P1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const cwd = process.cwd();

  const runImpl = async (): Promise<number> => {
  try {
    const result = await runPhaseReconcile({ cwd, phaseId, write });

    if (result.kind === "no_eligible_tasks") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              kind: "no_eligible_tasks",
              phase_id: result.phase_id,
              file: result.file,
              tasks: result.tasks,
              phase_status_candidate: result.phase_status_candidate,
              phase_status_note: result.phase_status_note,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(
          `${m.phase.reconcile.noEligible(phaseId)}\n`,
        );
      }
      return 0;
    }

    if (result.kind === "would_reconcile") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              kind: "would_reconcile",
              phase_id: result.phase_id,
              file: result.file,
              tasks: result.tasks,
              planned_writes: result.planned_writes,
              phase_status_candidate: result.phase_status_candidate,
              phase_status_note: result.phase_status_note,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(
          `${m.phase.reconcile.wouldReconcile(phaseId, result.planned_writes.length)}\n`,
        );
      }
      return 0;
    }

    // result.kind === "reconciled"
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            kind: "reconciled",
            phase_id: result.phase_id,
            file: result.file,
            tasks: result.tasks,
            applied_writes: result.applied_writes,
            skipped_writes: result.skipped_writes,
            phase_status_candidate: result.phase_status_candidate,
            phase_status_note: result.phase_status_note,
          },
        })}\n`,
      );
    } else {
      process.stdout.write(
        `${m.phase.reconcile.reconciled(phaseId, result.applied_writes.length, result.skipped_writes.length)}\n`,
      );
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;

    let msg: string;
    let outCode: string;
    let extraData: Record<string, unknown> | undefined;

    switch (code) {
      case "PHASE_NOT_FOUND":
        msg = m.phase.reconcile.phaseNotFound(phaseId);
        outCode = "PHASE_NOT_FOUND";
        break;
      case "PHASE_RECONCILE_WRITE_REFUSED": {
        const file =
          (err as NodeJS.ErrnoException & { file?: string }).file ?? "";
        const skipped =
          (err as NodeJS.ErrnoException & {
            skipped_writes?: unknown[];
          }).skipped_writes ?? [];
        msg = m.phase.reconcile.writeRefused(phaseId);
        outCode = "PHASE_RECONCILE_WRITE_REFUSED";
        extraData = { phase_id: phaseId, file, skipped_writes: skipped };
        break;
      }
      default:
        throw err;
    }
    if (json) {
      const envelope: Record<string, unknown> = {
        ok: false,
        error: { code: outCode, message: msg },
      };
      if (extraData) envelope.data = extraData;
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  };

  // P14: only --write mutates phase YAML; dry-run is lock-free.
  if (write) {
    return withWriteLock(
      cwd,
      `phase reconcile ${phaseId} --write`,
      json,
      runImpl,
    );
  }
  return runImpl();
}

// ---------------------------------------------------------------------------
// Command: phase runbook (v1.3 P12)
// ---------------------------------------------------------------------------

async function cmdPhaseRunbook(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "phase runbook",
      argv,
      {
        json: { type: "boolean" },
        "across-phases": { type: "boolean" },
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
  const acrossPhases = values["across-phases"] === true;
  const phaseId = positionals[0];
  const cwd = process.cwd();

  if (acrossPhases) {
    try {
      const result = await runPhaseRunbookAcrossPhases({ cwd });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
      } else {
        process.stdout.write(
          `Aggregated runbook across ${result.phases_considered.length} phase(s): ${result.phases_considered.join(", ")}\n`,
        );
        for (const phaseResult of result.phases) {
          process.stdout.write(`\n${m.phase.runbook.header(phaseResult.phase_id)}\n`);
          process.stdout.write(
            `${m.phase.runbook.phaseSummary(phaseResult.phase_summary)}\n`,
          );
          if (phaseResult.next_steps.length === 0) {
            process.stdout.write(`${m.phase.runbook.noSteps}\n`);
          } else {
            for (let i = 0; i < phaseResult.next_steps.length; i++) {
              const step = phaseResult.next_steps[i]!;
              process.stdout.write(`${m.phase.runbook.step(i + 1, step)}\n`);
            }
          }
        }
      }
      return 0;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const msg = (err as Error).message;
      const outCode = code === "CONFIG_ERROR" ? "CONFIG_ERROR" : "INTERNAL_ERROR";
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
  }

  if (!phaseId) {
    const msg = "phase runbook requires a phase id (e.g. `phase runbook P1`) or `--across-phases`.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  try {
    const result = await runPhaseRunbook({ cwd, phaseId });

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stdout.write(`${m.phase.runbook.header(phaseId)}\n`);
      process.stdout.write(
        `${m.phase.runbook.phaseSummary(result.phase_summary)}\n`,
      );
      if (result.next_steps.length === 0) {
        process.stdout.write(`${m.phase.runbook.noSteps}\n`);
      } else {
        for (let i = 0; i < result.next_steps.length; i++) {
          const step = result.next_steps[i]!;
          process.stdout.write(`${m.phase.runbook.step(i + 1, step)}\n`);
        }
      }
    }
    return 0;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const msg = (err as Error).message;
    let outCode = "INTERNAL_ERROR";
    if (code === "PHASE_NOT_FOUND") {
      outCode = "PHASE_NOT_FOUND";
    } else if (code === "CONFIG_ERROR") {
      outCode = "CONFIG_ERROR";
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Command: task start / block / resume / status (v0.6)
// ---------------------------------------------------------------------------

type TaskStateErrorKey = "start" | "block" | "resume";
type LocaleMessages = (typeof messages)[Locale];

function emitTaskCommonError(
  err: NodeJS.ErrnoException,
  key: TaskStateErrorKey,
  m: LocaleMessages,
  taskId: string,
  agent: string | undefined,
  json: boolean,
): number | null {
  const code = err.code;
  let msg: string;
  let outCode: string;
  switch (code) {
    case "TASK_NOT_FOUND":
      msg = m.task.complete.taskNotFound(taskId);
      outCode = "TASK_NOT_FOUND";
      break;
    case "AMBIGUOUS_TASK_ID": {
      const phases =
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      msg = m.task.complete.ambiguous(taskId, phases);
      outCode = "AMBIGUOUS_TASK_ID";
      break;
    }
    case "AGENT_NOT_FOUND":
      msg = m.task.complete.agentNotFound(agent ?? "");
      outCode = "AGENT_NOT_FOUND";
      break;
    case "AGENT_NOT_ENABLED":
      msg = m.task.complete.agentNotEnabled(agent ?? "");
      outCode = "AGENT_NOT_ENABLED";
      break;
    case "INVALID_TASK_TRANSITION": {
      const current =
        (err as NodeJS.ErrnoException & { current?: string }).current ?? "";
      msg = m.task[key].invalidTransition(taskId, current);
      outCode = "INVALID_TASK_TRANSITION";
      break;
    }
    default:
      return null;
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}

async function cmdTaskStart(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task start",
      argv,
      {
        agent: { type: "string" },
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
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task start requires a task id (e.g. `task start P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskStart({ cwd, taskId, agent });
    if (result.kind === "already_started") {
      if (json) {
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            data: {
              already_started: true,
              task_id: result.task_id,
              phase_id: result.phase_id,
              agent: result.agent,
            },
          })}\n`,
        );
      } else {
        process.stdout.write(`${m.task.start.alreadyStarted(taskId)}\n`);
      }
      return 0;
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            task_id: result.task_id,
            phase_id: result.phase_id,
            agent: result.agent,
            event: result.event,
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${m.task.start.success(taskId, result.agent)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const handled = emitTaskCommonError(
      err as NodeJS.ErrnoException,
      "start",
      m,
      taskId,
      agent,
      json,
    );
    if (handled !== null) return handled;
    throw err;
  }
}

async function cmdTaskBlock(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task block",
      argv,
      {
        agent: { type: "string" },
        reason: { type: "string" },
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
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task block requires a task id (e.g. `task block P1-T1 --reason ...`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const reason = (values.reason as string | undefined) ?? "";
  if (!reason || reason.trim().length === 0) {
    const msg = m.task.block.reasonRequired;
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskBlock({ cwd, taskId, reason, agent });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            task_id: result.task_id,
            phase_id: result.phase_id,
            agent: result.agent,
            event: result.event,
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${m.task.block.success(taskId, reason)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const handled = emitTaskCommonError(
      err as NodeJS.ErrnoException,
      "block",
      m,
      taskId,
      agent,
      json,
    );
    if (handled !== null) return handled;
    throw err;
  }
}

async function cmdTaskResume(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task resume",
      argv,
      {
        agent: { type: "string" },
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
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task resume requires a task id (e.g. `task resume P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskResume({ cwd, taskId, agent });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            task_id: result.task_id,
            phase_id: result.phase_id,
            agent: result.agent,
            event: result.event,
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${m.task.resume.success(taskId)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const handled = emitTaskCommonError(
      err as NodeJS.ErrnoException,
      "resume",
      m,
      taskId,
      agent,
      json,
    );
    if (handled !== null) return handled;
    throw err;
  }
}

async function cmdTaskStatus(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task status",
      argv,
      {
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
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task status requires a task id (e.g. `task status P1-T1`).";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
  const cwd = process.cwd();

  try {
    const result = await runTaskStatus({ cwd, taskId });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            task_id: result.task_id,
            phase_id: result.phase_id,
            current: result.current,
            last_event: result.last_event,
            history: result.history,
          },
        })}\n`,
      );
    } else {
      process.stdout.write(`${m.task.status.headline(taskId, result.current)}\n`);
      if (result.history.length === 0) {
        process.stdout.write(`${m.task.status.noEvents(taskId)}\n`);
      } else {
        for (const ev of result.history) {
          const extras: string[] = [];
          if (ev.agent) extras.push(`agent=${ev.agent}`);
          if (ev.reason) extras.push(`reason=${ev.reason}`);
          const suffix = extras.length > 0 ? `  (${extras.join(", ")})` : "";
          process.stdout.write(`  ${ev.at}  ${ev.status}${suffix}\n`);
        }
      }
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    let msg: string;
    let outCode: string;
    switch (code) {
      case "TASK_NOT_FOUND":
        msg = m.task.complete.taskNotFound(taskId);
        outCode = "TASK_NOT_FOUND";
        break;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        msg = m.task.complete.ambiguous(taskId, phases);
        outCode = "AMBIGUOUS_TASK_ID";
        break;
      }
      default:
        throw err;
    }
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: outCode, message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { globalValues, command, rest } = splitArgv(process.argv.slice(2));
  const cwd = process.cwd();
  const locale: Locale =
    globalValues.locale && KNOWN_LOCALES.has(globalValues.locale as Locale)
      ? (globalValues.locale as Locale)
      : await detectLocale(cwd);
  const m = messages[locale];
  const json = globalValues.json === true;

  if (globalValues.version) {
    const version = await readPackageVersion();
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { version } })}\n`);
    } else {
      process.stdout.write(`${version}\n`);
    }
    return 0;
  }

  if (globalValues.help || !command) {
    process.stdout.write(`${m.usage}\n`);
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit(rest, locale, json);

    case "plan":
      return cmdPlan(rest, locale, json);

    case "phase":
      return cmdPhase(rest, locale, json);

    case "task":
      return cmdTask(rest, locale, json);

    case "progress":
      return cmdProgress(rest, locale, json);

    case "pack":
      return cmdPack(rest, locale, json);

    case "verify":
      return cmdVerify(rest, locale, json);

    case "adapter":
      return cmdAdapter(rest, locale, json);

    case "recommend":
      return cmdRecommend(rest, locale, json);

    case "doctor":
      return cmdDoctor(rest, json);

    case "validate":
      return cmdValidate(rest, json);

    case "spec":
      return cmdSpec(rest, locale, json);

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
