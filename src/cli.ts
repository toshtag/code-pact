#!/usr/bin/env node
import { parseArgs } from "node:util";
import { stat } from "./core/project-fs/raw-internal.ts";
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
import { withWriteLock, emitOk, emitError } from "./cli/util.ts";
import { runProgress, formatProgress } from "./commands/progress.ts";
import { runPack } from "./commands/pack.ts";
import { runVerify, formatVerify } from "./commands/verify.ts";
import { runRecommend, formatRecommend } from "./commands/recommend.ts";
import { runDoctor, formatDoctor } from "./commands/doctor.ts";
import { runValidate } from "./commands/validate.ts";
import { runStatus, type StatusResult } from "./commands/status.ts";
// Subcommand clusters each live in `./cli/commands/<group>.ts` and
// expose only their cluster-entry dispatch (`cmd<Group>`); the
// per-subcommand handlers are private to that module. cli.ts keeps the
// single-verb commands (init, tutorial, doctor, validate, recommend,
// verify, pack, progress) inline and routes the rest through here.
import { cmdAdapter } from "./cli/commands/adapter.ts";
import { cmdTask } from "./cli/commands/task.ts";
import { cmdPlan } from "./cli/commands/plan.ts";
import { cmdPhase } from "./cli/commands/phase.ts";
import { cmdState } from "./cli/commands/state.ts";
import { cmdSpec } from "./cli/commands/spec.ts";
import { cmdDecision } from "./cli/commands/decision.ts";
import type { LocaleCode } from "./core/schemas/locale.ts";
import { LocaleConfig } from "./core/schemas/locale.ts";
import { readProjectYamlStrictOrNull } from "./core/project-config-path.ts";

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

function detectCodePactEnvLocale(): Locale | null {
  const codePactLocale = process.env.CODE_PACT_LOCALE;
  if (codePactLocale && KNOWN_LOCALES.has(codePactLocale as Locale)) {
    return codePactLocale as Locale;
  }
  return null;
}

function detectLangLocale(): Locale | null {
  const lang = process.env.LANG ?? "";
  if (lang.startsWith("ja")) return "ja-JP";
  return null;
}

async function readProjectYamlForLocale(cwd: string): Promise<string | null> {
  return readProjectYamlStrictOrNull(cwd);
}

// Locale resolution priority:
// 1. --locale flag (handled in main before this is called)
// 2. CODE_PACT_LOCALE env var
// 3. .code-pact/project.yaml locale field
// 4. LANG env var
// 5. default en-US
async function detectLocale(
  cwd: string,
  opts?: { readProject?: boolean },
): Promise<Locale> {
  const envLocale = detectCodePactEnvLocale();
  if (envLocale !== null) return envLocale;

  if (opts?.readProject !== false) {
    const raw = await readProjectYamlForLocale(cwd);
    if (raw !== null) {
      try {
        const data = parseYaml(raw) as { locale?: unknown };
        if (data && typeof data === "object" && data.locale != null) {
          const result = LocaleConfig.safeParse(data.locale);
          if (result.success) {
            const cfg = result.data;
            const code =
              typeof cfg === "string" ? cfg : (cfg.cli ?? cfg.default);
            if (KNOWN_LOCALES.has(code as Locale)) return code as Locale;
          }
        }
      } catch {
        // project.yaml unparseable for locale discovery — continue
      }
    }
  }

  const langLocale = detectLangLocale();
  if (langLocale !== null) return langLocale;
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
        for (const w of result.warnings) {
          process.stderr.write(`  ⚠ ${w}\n`);
        }
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
    // Advisory write lock: only when `.code-pact/` already exists.
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
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const agentRaw = (values.agent as string | undefined) ?? "claude-code";
  const agents: SupportedAgent[] = agentRaw
    .split(",")
    .map(a => a.trim())
    .filter((a): a is SupportedAgent => KNOWN_AGENTS.has(a as SupportedAgent));

  if (agents.length === 0) {
    const msg = `Unknown agent(s): ${agentRaw}. Supported: ${[...KNOWN_AGENTS].join(", ")}`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const initLocale: LocaleCode =
    typeof values.locale === "string" &&
    KNOWN_LOCALES.has(values.locale as Locale)
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
        emitOk(result);
      } else {
        for (const f of result.created) {
          process.stderr.write(`  created  ${f}\n`);
        }
        for (const f of result.skipped) {
          process.stderr.write(`  skipped  ${f} (already exists)\n`);
        }
        process.stderr.write(`\n${m.init.done}\n`);
        for (const w of result.warnings) {
          process.stderr.write(`  ⚠ ${w}\n`);
        }
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
        emitError(json, "CONFIG_ERROR", msg);
        return 2;
      }
      throw err;
    }
  };

  // Advisory write lock: only when sample-phase will be created
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
      emitOk(result);
    }
    return 0;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    emitError(json, "TUTORIAL_FAILED", msg, {
      human: `tutorial failed: ${msg}`,
    });
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
      emitOk(result);
    } else {
      emitError(json, "DOCTOR_FAILED", "Project health check failed", {
        data: result,
      });
    }
  } else {
    process.stdout.write(`${formatDoctor(result)}\n`);
  }

  const hasErrors = result.issues.some(i => i.severity === "error");
  return hasErrors ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Command: validate
// ---------------------------------------------------------------------------

async function cmdValidate(
  argv: string[],
  globalJson: boolean,
): Promise<number> {
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
      emitOk(result);
    } else {
      emitError(
        json,
        "VALIDATE_FAILED",
        strict ? "Project has issues (strict mode)" : "Project has errors",
        { data: result },
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
// Command: status — read-only team activity overview
// ---------------------------------------------------------------------------

async function cmdStatus(argv: string[], globalJson: boolean): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    process.stdout.write(
      [
        "Usage: code-pact status [options]",
        "",
        "Team activity overview: in flight / blocked / available / waiting.",
        "Pure read — no --agent, no writes, no lock.",
        "",
        "Options:",
        "  --json        Emit the JSON envelope.",
        "  --phase <id>  Restrict to one phase.",
        "  --mine        Show only active work matching your current author identity.",
      ].join("\n") + "\n",
    );
    return 0;
  }

  // Strict parsing so a value-less `--phase` (which would silently degrade to
  // "no phase" and run the whole project), an unknown flag, or a stray
  // positional fails closed as CONFIG_ERROR (exit 2) — like the other commands.
  let values: Record<string, unknown>;
  try {
    ({ values } = strictParse("status", argv, {
      json: { type: "boolean" },
      mine: { type: "boolean" },
      phase: { type: "string" },
    }));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const json = globalJson || argv.includes("--json");
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const cwd = process.cwd();
  try {
    const result = await runStatus({
      cwd,
      ...(values.mine === true ? { mine: true } : {}),
      ...(typeof values.phase === "string" ? { phase: values.phase } : {}),
    });
    if (json) {
      emitOk(result);
    } else {
      process.stdout.write(`${formatStatus(result)}\n`);
    }
    return 0;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { phases?: string[] };
    const code = e.code ?? "INTERNAL_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    // PHASE_NOT_FOUND / AMBIGUOUS_PHASE_ID are argument-resolution errors → exit 2
    // (AMBIGUOUS surfaces the colliding paths in data.phases, like other handlers).
    // PHASE_SNAPSHOT_INVALID (design-docs-ephemeral step 4a, thrown by loadPlanState)
    // is a control-plane integrity error, NOT an internal bug → exit 2 clean envelope.
    const cleanExit2 =
      code === "PHASE_NOT_FOUND" ||
      code === "AMBIGUOUS_PHASE_ID" ||
      code === "PHASE_SNAPSHOT_INVALID" ||
      code === "CONFIG_ERROR";
    emitError(
      json,
      code,
      message,
      code === "AMBIGUOUS_PHASE_ID" ? { data: { phases: e.phases ?? [] } } : {},
    );
    return cleanExit2 ? 2 : 3;
  }
}

function formatStatus(r: StatusResult): string {
  const lines: string[] = [];
  if (r.filter.mine && r.filter.supported === false) {
    lines.push(`(--mine unavailable: ${r.filter.reason})`);
  } else if (r.filter.mine && r.filter.supported === true) {
    lines.push(
      `(filtered to author: ${r.filter.author} — matches your resolved author identity)`,
    );
  }
  const who = (a?: string) => (a ? ` — ${a}` : "");
  // Conflicts are an exception signal — printed first and only when present, so
  // a healthy project stays calm and a real conflict stands out. (The JSON
  // envelope always carries `conflicts`, possibly empty; this is human-only.)
  if (r.conflicts.length > 0) {
    lines.push(
      `Conflicts (${r.conflicts.length}) — reconcile progress events (see code-pact status --json data.conflicts[].details.events[]):`,
    );
    for (const c of r.conflicts) {
      // Normally always populated; if attribution degraded to empty sides, say so
      // rather than printing an empty `()` — the conflict signal still stands.
      const sides =
        c.details.events.length > 0
          ? c.details.events
              .map(e => (e.author ? `${e.status} by ${e.author}` : e.status))
              .join(" vs ")
          : "details unavailable";
      lines.push(`  ${c.task_id}  (${sides})`);
    }
  }
  lines.push(`In flight (${r.in_flight.length}):`);
  for (const e of r.in_flight) lines.push(`  ${e.task_id}${who(e.author)}`);
  lines.push(`Blocked (${r.blocked.length}):`);
  for (const e of r.blocked)
    lines.push(
      `  ${e.task_id}${who(e.author)}${e.reason ? `  reason: ${e.reason}` : ""}`,
    );
  lines.push(`Available to pick up (${r.available.length}):`);
  for (const e of r.available) lines.push(`  ${e.task_id}`);
  lines.push(`Waiting (${r.waiting.length}):`);
  for (const e of r.waiting) {
    const why = e.reasons
      .map(x =>
        x.code === "WAITING_FOR_DEPENDENCY"
          ? `needs ${x.task_id}`
          : x.decision_ref
            ? `needs accepted decision ${x.decision_ref}`
            : "needs accepted decision",
      )
      .join(", ");
    lines.push(`  ${e.task_id}  (${why})`);
  }
  const t = r.totals;
  lines.push(
    `Totals: ${t.tasks} task(s) — done ${t.by_state.done}, in-flight ${t.by_state.started + t.by_state.resumed}, blocked ${t.by_state.blocked}, planned ${t.by_state.planned}`,
  );
  if (r.filter.mine === true) {
    lines.push("(Totals are for the selected scope, not only --mine results.)");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command: recommend
// ---------------------------------------------------------------------------

async function cmdRecommend(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
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
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const cwd = process.cwd();

  try {
    const result = await runRecommend({ cwd, phaseId, taskId, agentName });
    if (json) {
      emitOk(result);
    } else {
      process.stdout.write(`${formatRecommend(result)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PHASE_NOT_FOUND") {
      const msg = m.recommend.phaseNotFound(phaseId);
      emitError(json, "PHASE_NOT_FOUND", msg);
      return 2;
    }
    if (code === "AMBIGUOUS_PHASE_ID") {
      const phases =
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      const msg =
        err instanceof Error ? err.message : `Phase "${phaseId}" is ambiguous.`;
      emitError(json, "AMBIGUOUS_PHASE_ID", msg, { data: { phases } });
      return 2;
    }
    if (code === "TASK_NOT_FOUND") {
      const msg = m.recommend.taskNotFound(taskId, phaseId);
      emitError(json, "TASK_NOT_FOUND", msg);
      return 2;
    }
    if (code === "AGENT_NOT_FOUND") {
      const msg = m.recommend.agentNotFound(agentName);
      emitError(json, "AGENT_NOT_FOUND", msg);
      return 2;
    }
    // A malformed agent profile / invalid context_budget block surfaces as a
    // clean CONFIG_ERROR (exit 2) rather than leaking a raw Zod/YAML throw —
    // `recommend` reads context_budget to resolve the contextFit byte override.
    // Mirrors task prepare's CONFIG_ERROR envelope.
    if (code === "CONFIG_ERROR") {
      const msg = err instanceof Error ? err.message : "Invalid configuration.";
      emitError(json, "CONFIG_ERROR", msg);
      return 2;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Command: verify
// ---------------------------------------------------------------------------

async function cmdVerify(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
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
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const cwd = process.cwd();

  try {
    const result = await runVerify({ cwd, phaseId, taskId, dryRun });
    if (json) {
      if (result.ok) {
        emitOk({ checks: result.checks });
      } else {
        emitError(json, "VERIFICATION_FAILED", "Verification failed", {
          data: { checks: result.checks },
        });
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
      emitError(json, "PHASE_NOT_FOUND", msg);
      return 2;
    }
    if (code === "AMBIGUOUS_PHASE_ID") {
      const phases =
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      const msg =
        err instanceof Error ? err.message : `Phase "${phaseId}" is ambiguous.`;
      emitError(json, "AMBIGUOUS_PHASE_ID", msg, { data: { phases } });
      return 2;
    }
    if (code === "TASK_NOT_FOUND") {
      const msg = m.verify.taskNotFound(taskId, phaseId);
      emitError(json, "TASK_NOT_FOUND", msg);
      return 2;
    }
    if (code === "CONFIG_ERROR") {
      // A contained-loader path-safety refusal / malformed roadmap or phase →
      // structured envelope (exit 2), not a top-level internal error / exit 3.
      emitError(
        json,
        "CONFIG_ERROR",
        err instanceof Error ? err.message : "Invalid configuration.",
      );
      return 2;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Command: pack
// ---------------------------------------------------------------------------

async function cmdPack(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
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
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const cwd = process.cwd();

  try {
    const result = await runPack({ cwd, phaseId, taskId, agentName });
    if (json) {
      emitOk(result);
    } else {
      process.stderr.write(
        `${m.pack.written(result.outputPath, result.charCount)}\n`,
      );
    }
    return 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "PHASE_NOT_FOUND") {
      const msg = m.pack.phaseNotFound(phaseId);
      emitError(json, "PHASE_NOT_FOUND", msg);
      return 2;
    }
    if (code === "AMBIGUOUS_PHASE_ID") {
      const phases =
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      const msg =
        err instanceof Error ? err.message : `Phase "${phaseId}" is ambiguous.`;
      emitError(json, "AMBIGUOUS_PHASE_ID", msg, { data: { phases } });
      return 2;
    }
    if (code === "TASK_NOT_FOUND") {
      const msg = m.pack.taskNotFound(taskId, phaseId);
      emitError(json, "TASK_NOT_FOUND", msg);
      return 2;
    }
    if (code === "CONFIG_ERROR") {
      // A control-plane read refused on path-safety grounds (a roadmap/phase
      // path that escapes the project via `..`/symlink → loadPhase/loadRoadmap
      // throw CONFIG_ERROR). Surface the structured envelope (exit 2) instead of
      // letting it fall through to the top-level internal-error / exit 3. Mirrors
      // `task context`, which already maps CONFIG_ERROR here.
      const msg = err instanceof Error ? err.message : "Invalid configuration.";
      emitError(json, "CONFIG_ERROR", msg);
      return 2;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Command: progress
// ---------------------------------------------------------------------------

async function cmdProgress(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
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
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const baselineName = (values.baseline as string | undefined) ?? "initial";
  const cwd = process.cwd();

  try {
    const result = await runProgress({ cwd, baseline: baselineName });
    if (json) {
      emitOk(result);
    } else {
      process.stdout.write(`${formatProgress(result)}\n`);
    }
    return 0;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code === "BASELINE_NOT_FOUND"
    ) {
      const msg = m.progress.baselineNotFound(baselineName);
      emitError(json, "BASELINE_NOT_FOUND", msg);
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
  const json = globalValues.json === true;

  if (globalValues.version) {
    const version = await readPackageVersion();
    if (json) {
      emitOk({ version });
    } else {
      process.stdout.write(`${version}\n`);
    }
    return 0;
  }

  const locale: Locale =
    globalValues.locale && KNOWN_LOCALES.has(globalValues.locale as Locale)
      ? (globalValues.locale as Locale)
      : await detectLocale(cwd, {
          readProject: !(globalValues.help || !command),
        });
  const m = messages[locale];

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

    case "state":
      return cmdState(rest, locale, json);

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

    case "status":
      return cmdStatus(rest, json);

    case "spec":
      return cmdSpec(rest, locale, json);

    case "decision":
      return cmdDecision(rest, locale, json);

    default: {
      emitError(json, "UNKNOWN_COMMAND", m.unknownCommand(command ?? ""));
      return 2;
    }
  }
}

main().then(
  code => process.exit(code),
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Safety net: a structured CONFIG_ERROR that no command-level catch mapped
    // (e.g. a contained control-plane loader's path-safety refusal surfacing from
    // a command whose catch this PR did not individually wire) must STILL be a
    // clean exit-2 envelope, never a top-level internal error / exit 3. This
    // guarantees CONFIG_ERROR completeness across every command in one place; the
    // per-command cases above stay for their nicer, localized messages.
    if ((err as NodeJS.ErrnoException)?.code === "CONFIG_ERROR") {
      emitError(process.argv.includes("--json"), "CONFIG_ERROR", msg);
      process.exit(2);
    }
    process.stderr.write(`internal error: ${msg}\n`);
    process.exit(3);
  },
);
