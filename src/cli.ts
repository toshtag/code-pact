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
import { withWriteLock } from "./cli/util.ts";
import { runProgress, formatProgress } from "./commands/progress.ts";
import { runPack } from "./commands/pack.ts";
import { runVerify, formatVerify } from "./commands/verify.ts";
import { runRecommend, formatRecommend } from "./commands/recommend.ts";
import { runDoctor, formatDoctor } from "./commands/doctor.ts";
import { runValidate } from "./commands/validate.ts";
// Subcommand clusters each live in `./cli/commands/<group>.ts` and
// expose only their cluster-entry dispatch (`cmd<Group>`); the
// per-subcommand handlers are private to that module. cli.ts keeps the
// single-verb commands (init, tutorial, doctor, validate, recommend,
// verify, pack, progress) inline and routes the rest through here.
import { cmdAdapter } from "./cli/commands/adapter.ts";
import { cmdTask } from "./cli/commands/task.ts";
import { cmdPlan } from "./cli/commands/plan.ts";
import { cmdPhase } from "./cli/commands/phase.ts";
import { cmdSpec } from "./cli/commands/spec.ts";
import type { LocaleCode } from "./core/schemas/locale.ts";
import { LocaleConfig } from "./core/schemas/locale.ts";

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
        for (const step of result.suggested_next_steps) {
          process.stderr.write(`  → ${step}\n`);
        }
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
        for (const step of result.suggested_next_steps) {
          process.stderr.write(`  → ${step}\n`);
        }
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
      "base-ref": { type: "string" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const baseRef = values["base-ref"] as string | undefined;
  const cwd = process.cwd();
  const result = await runDoctor(cwd, baseRef !== undefined ? { baseRef } : {});

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
      "base-ref": { type: "string" },
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const strict = values.strict === true;
  const baseRef = values["base-ref"] as string | undefined;
  const cwd = process.cwd();
  const result = await runValidate({
    cwd,
    strict,
    ...(baseRef !== undefined ? { baseRef } : {}),
  });

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
    // A malformed agent profile / invalid P47 context_budget block surfaces as a
    // clean CONFIG_ERROR (exit 2) rather than leaking a raw Zod/YAML throw — this
    // matters in P48 because `recommend` now reads context_budget to resolve the
    // contextFit byte override. Mirrors task prepare's CONFIG_ERROR envelope.
    if (code === "CONFIG_ERROR") {
      const msg = err instanceof Error ? err.message : "Invalid configuration.";
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
