#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
import { runRecommend, formatRecommend } from "./commands/recommend.ts";
import { runDoctor, formatDoctor } from "./commands/doctor.ts";
import { runTaskContext } from "./commands/task-context.ts";
import { runTaskComplete } from "./commands/task-complete.ts";
import { runPhaseNew } from "./commands/phase-new.ts";
import type { LocaleCode } from "./core/schemas/locale.ts";
import type { PhaseStatus } from "./core/schemas/phase.ts";

const KNOWN_LOCALES: ReadonlySet<Locale> = new Set(["en-US", "ja-JP"]);
const KNOWN_AGENTS: ReadonlySet<SupportedAgent> = new Set(SUPPORTED_AGENTS);

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
    },
    strict: false,
    allowPositionals: false,
  });

  const json = globalJson || values.json === true;
  const agentName = (values.agent as string | undefined) ?? "claude-code";
  const force = values.force === true;
  const cwd = process.cwd();

  try {
    const result = await runGenerateAdapter({ cwd, agentName, force });
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
    const id = values.id as string | undefined;
    const name = values.name as string | undefined;
    const weightRaw = values.weight as string | undefined;
    const objective = values.objective as string | undefined;

    if (!id || !name || !weightRaw || !objective) {
      const msg = "phase add requires --id, --name, --weight, --objective";
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
      const result = await runPhaseImport({ cwd, inputPath, force });
      if (json) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: result })}\n`);
      } else {
        process.stderr.write(`${m.phase.importDone(result.imported_phases.length, result.imported_tasks.length, result.skipped_phases.length)}\n`);
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

  const msg = `task: unknown subcommand "${subcommand ?? ""}". Use: context | complete`;
  if (globalJson) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
    );
  } else {
    process.stderr.write(`${msg}\n`);
  }
  return 2;
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
  const locale: Locale =
    globalValues.locale && KNOWN_LOCALES.has(globalValues.locale as Locale)
      ? (globalValues.locale as Locale)
      : detectLocale();
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
