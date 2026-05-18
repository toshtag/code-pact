#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
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
import { runProgress, formatProgress } from "./commands/progress.ts";
import { runPack } from "./commands/pack.ts";
import { runVerify, formatVerify } from "./commands/verify.ts";
import { runGenerateAdapter } from "./commands/adapter.ts";
import { runPlanBrief } from "./commands/plan-brief.ts";
import { runPlanPrompt } from "./commands/plan-prompt.ts";
import { runPlanConstitution } from "./commands/plan-constitution.ts";
import { runRecommend, formatRecommend } from "./commands/recommend.ts";
import { runDoctor, formatDoctor } from "./commands/doctor.ts";
import { runValidate } from "./commands/validate.ts";
import { runTaskContext } from "./commands/task-context.ts";
import { runTaskComplete } from "./commands/task-complete.ts";
import { runTaskStart } from "./commands/task-start.ts";
import { runTaskBlock } from "./commands/task-block.ts";
import { runTaskResume } from "./commands/task-resume.ts";
import { runTaskStatus } from "./commands/task-status.ts";
import { runPhaseNew } from "./commands/phase-new.ts";
import { runTaskAdd } from "./commands/task-add.ts";
import { runPhaseWizard } from "./lib/phase-wizard.ts";
import type { LocaleCode } from "./core/schemas/locale.ts";
import { LocaleConfig } from "./core/schemas/locale.ts";
import type { PhaseStatus } from "./core/schemas/phase.ts";

const KNOWN_LOCALES: ReadonlySet<Locale> = new Set(["en-US", "ja-JP"]);
const KNOWN_AGENTS: ReadonlySet<SupportedAgent> = new Set(SUPPORTED_AGENTS);

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

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "package.json");
  const raw = await readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
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
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const nonInteractive = values["non-interactive"] === true;
  const cwd = process.cwd();
  const force = values.force === true;

  // Wizard branch — TTY, no input flags supplied, no JSON contract requested,
  // and the user did not opt out via --non-interactive. Any of these signals
  // routes through the flag-based path below to keep CI and automation
  // safe (matching docs/cli-contract.md).
  const hasInitFlag =
    typeof values.agent === "string" ||
    typeof values.locale === "string" ||
    values.force === true;
  const useWizard = isInteractive() && !hasInitFlag && !json && !nonInteractive;

  if (useWizard) {
    try {
      const result = await runInitWizard({ cwd, force, json: false });
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

  try {
    const result = await runInit({
      cwd,
      locale: initLocale,
      agents,
      force,
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

  const msg = `plan: unknown subcommand "${subcommand ?? ""}". Use: brief | prompt | constitution`;
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
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const force = values.force === true;
  const cwd = process.cwd();

  if (!isInteractive()) {
    const msg = "plan brief is interactive and requires a TTY.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const result = await runPlanBrief({ cwd, locale, force });
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
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const force = values.force === true;
  const cwd = process.cwd();

  if (!isInteractive()) {
    const msg = "plan constitution is interactive and requires a TTY.";
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  const result = await runPlanConstitution({ cwd, locale, force });
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
  const cwd = process.cwd();

  try {
    const result = await runGenerateAdapter({ cwd, agentName, force, locale, modelVersion, regenSkills });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      for (const f of result.created) process.stderr.write(`  created  ${f}\n`);
      for (const f of result.skipped) process.stderr.write(`  skipped  ${f} (already exists)\n`);
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
      try {
        const input = await runPhaseWizard(prompter, messages[locale].wizard.phase);
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
        throw err;
      } finally {
        prompter.close();
      }
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
      throw err;
    }
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
      throw err;
    }
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
  }

  // Unknown subcommand
  const msg = `phase: unknown subcommand "${subcommand ?? ""}". Use: add | new | ls | show | import`;
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

  const msg = `task: unknown subcommand "${subcommand ?? ""}". Use: add | context | start | status | block | resume | complete`;
  if (globalJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
}

async function cmdTaskAdd(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const cwd = process.cwd();

  // Positional: phase-id
  const phaseId = argv.find((a) => !a.startsWith("-"));
  if (!phaseId) {
    const msg = "task add requires a phase id: code-pact task add <phase-id>";
    if (globalJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  // Optional --id flag
  const idFlagIdx = argv.indexOf("--id");
  const explicitId = idFlagIdx !== -1 ? argv[idFlagIdx + 1] : undefined;

  if (!isInteractive()) {
    const msg = "task add is interactive and requires a TTY. Use --non-interactive phase add with tasks in a phase import file instead.";
    if (globalJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
      );
    } else {
      process.stderr.write(`${msg}\n`);
    }
    return 2;
  }

  try {
    const result = await runTaskAdd({ cwd, phaseId, locale, id: explicitId });
    if (globalJson) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
    } else {
      process.stderr.write(`${m.task.added(result.taskId, result.phaseId, result.phasePath)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "PHASE_NOT_FOUND" || code === "DUPLICATE_TASK_ID") {
      if (globalJson) {
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
    const pack = await runTaskContext({ cwd, taskId, agent });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            task_id: pack.taskId,
            phase_id: pack.phaseId,
            agent: pack.agent,
            char_count: pack.charCount,
            content: pack.content,
          },
        })}\n`,
      );
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
