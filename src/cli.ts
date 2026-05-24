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
import { runTutorial } from "./commands/tutorial.ts";
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
import { withWriteLock } from "./cli/util.ts";
import { runProgress, formatProgress } from "./commands/progress.ts";
import { runPack } from "./commands/pack.ts";
import { runVerify, formatVerify } from "./commands/verify.ts";
// P27-T2: adapter cluster (cmdAdapter + 6 cmdAdapter*) lives in
// `./cli/commands/adapter.ts`. The per-subcommand functions are
// private to that module; only the cluster-entry dispatch is
// imported here.
import { cmdAdapter } from "./cli/commands/adapter.ts";
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
// P27-T1: task cluster (cmdTask + 10 cmdTask*) lives in
// `./cli/commands/task.ts`. The per-subcommand functions are private
// to that module; only the cluster-entry dispatch is imported here.
import { cmdTask } from "./cli/commands/task.ts";
// `runPhaseReconcile` and the phase-runbook helpers stay imported in
// cli.ts because the phase cluster's `cmdPhaseReconcile` /
// `cmdPhaseRunbook` functions still live in this file.
import { runPhaseReconcile } from "./commands/phase-reconcile.ts";
import {
  runPhaseRunbook,
  runPhaseRunbookAcrossPhases,
} from "./commands/phase-runbook.ts";
import { runPhaseNew } from "./commands/phase-new.ts";
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
// Command: tutorial
// ---------------------------------------------------------------------------

async function cmdTutorial(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      keep: { type: "boolean" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const keep = values.keep === true;

  try {
    const result = await runTutorial({ locale, json, keep });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "TUTORIAL_FAILED", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`tutorial failed: ${msg}\n`);
    }
    return 1;
  }
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

    case "tutorial":
      return cmdTutorial(rest, locale, json);

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
