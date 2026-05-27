// P27-T1: extracted from src/cli.ts. The CLI wrapper layer for the
// `task` subcommand cluster. Routes `task <subcommand>` to the
// per-subcommand handlers defined below. JSON envelopes, exit codes,
// error codes, and flag surfaces are byte-identical to v1.13.
//
// `cmdTask` is the cluster-entry dispatch and is the only export.
// The per-subcommand handlers (cmdTaskAdd, cmdTaskContext, etc.) are
// private to this module.

import { parseArgs } from "node:util";
import { strictParse, strictParseAlias, ConfigError } from "../../lib/argv.ts";
import { isInteractive } from "../../lib/tty.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { withWriteLock } from "../util.ts";
import { runTaskContext } from "../../commands/task-context.ts";
import { runTaskComplete } from "../../commands/task-complete.ts";
import { runTaskPrepare } from "../../commands/task-prepare.ts";
import {
  runTaskFinalize,
  TaskFinalizeAuditStrictError,
} from "../../commands/task-finalize.ts";
import { runTaskRunbook } from "../../commands/task-runbook.ts";
import { runTaskStart } from "../../commands/task-start.ts";
import { runTaskBlock } from "../../commands/task-block.ts";
import { runTaskResume } from "../../commands/task-resume.ts";
import { runTaskStatus } from "../../commands/task-status.ts";
import {
  runTaskAdd,
  type TaskAddNonInteractiveSpec,
} from "../../commands/task-add.ts";
import {
  TaskType,
  AmbiguityLevel,
  RiskLevel,
  ContextSize,
  WriteSurface,
  VerificationStrength,
  ExpectedDuration,
} from "../../core/schemas/task.ts";

export async function cmdTask(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
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
  // `reconcile` is a beginner-friendly alias for `finalize` (verb-consistent
  // with `phase reconcile`). See design/decisions/cli-alias-ux-rfc.md. The
  // invoked name is threaded through so error messages name the alias.
  if (subcommand === "finalize" || subcommand === "reconcile") {
    return cmdTaskFinalize(rest, locale, globalJson, `task ${subcommand}`);
  }
  // `next` is a beginner-friendly alias for `runbook` ("what should I do next?").
  if (subcommand === "runbook" || subcommand === "next") {
    return cmdTaskRunbook(rest, locale, globalJson, `task ${subcommand}`);
  }

  const msg = `task: unknown subcommand "${subcommand ?? ""}". Use: add | context | prepare | start | status | block | resume | complete | finalize | runbook (aliases: reconcile = finalize, next = runbook)`;
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
        "budget-bytes": { type: "string" },
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

  // P24: --budget-bytes parsing. The arg-parser gives us a raw string;
  // validate it as a positive integer, reject zero / negative / NaN.
  const budgetRaw = values["budget-bytes"];
  let budgetBytes: number | undefined;
  if (typeof budgetRaw === "string") {
    const n = Number.parseInt(budgetRaw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== budgetRaw.trim()) {
      const msg = `task context: --budget-bytes requires a positive integer (got "${budgetRaw}").`;
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    budgetBytes = n;
  }

  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const pack = await runTaskContext({
      cwd,
      taskId,
      agent,
      ...(explain ? { explain: true as const } : {}),
      ...(budgetBytes !== undefined ? { budgetBytes } : {}),
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
    let envelopeData: Record<string, unknown> | undefined;
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
      case "CONTEXT_OVER_BUDGET": {
        const overBudget = err as Error & {
          budget_bytes?: number;
          minimum_achievable_bytes?: number;
          unelidable_sections?: ReadonlyArray<string>;
        };
        msg = err.message;
        outCode = "CONTEXT_OVER_BUDGET";
        envelopeData = {
          budget_bytes: overBudget.budget_bytes,
          minimum_achievable_bytes: overBudget.minimum_achievable_bytes,
          unelidable_sections: overBudget.unelidable_sections,
        };
        break;
      }
      default:
        throw err;
    }
    if (json) {
      const errorObj: Record<string, unknown> = { code: outCode, message: msg };
      if (envelopeData !== undefined) errorObj.data = envelopeData;
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: errorObj })}\n`,
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
        "budget-bytes": { type: "string" },
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

  // P24: --budget-bytes parsing. Same validation as task context —
  // positive integer; reject zero / negative / NaN.
  const budgetRaw = values["budget-bytes"];
  let budgetBytes: number | undefined;
  if (typeof budgetRaw === "string") {
    const n = Number.parseInt(budgetRaw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== budgetRaw.trim()) {
      const msg = `task prepare: --budget-bytes requires a positive integer (got "${budgetRaw}").`;
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ ok: false, error: { code: "CONFIG_ERROR", message: msg } })}\n`,
        );
      } else {
        process.stderr.write(`${msg}\n`);
      }
      return 2;
    }
    budgetBytes = n;
  }

  const cwd = process.cwd();

  try {
    const result = await runTaskPrepare({
      cwd,
      taskId,
      agent,
      dryRun,
      ...(budgetBytes !== undefined ? { budgetBytes } : {}),
    });
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
    let envelopeData: Record<string, unknown> | undefined;
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
      case "CONTEXT_OVER_BUDGET": {
        const overBudget = err as Error & {
          budget_bytes?: number;
          minimum_achievable_bytes?: number;
          unelidable_sections?: ReadonlyArray<string>;
        };
        msg = err.message;
        outCode = "CONTEXT_OVER_BUDGET";
        envelopeData = {
          budget_bytes: overBudget.budget_bytes,
          minimum_achievable_bytes: overBudget.minimum_achievable_bytes,
          unelidable_sections: overBudget.unelidable_sections,
        };
        break;
      }
      default:
        throw err;
    }
    if (json) {
      const errorObj: Record<string, unknown> = { code: outCode, message: msg };
      if (envelopeData !== undefined) errorObj.data = envelopeData;
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: errorObj })}\n`,
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
  invokedAs: string = "task finalize",
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParseAlias(
      invokedAs,
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
    const aliasNote = invokedAs === "task finalize" ? "" : " (alias for `task finalize`)";
    const msg = `${invokedAs} requires a task id (e.g. \`${invokedAs} P1-T1\`)${aliasNote}.`;
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
  invokedAs: string = "task runbook",
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParseAlias(
      invokedAs,
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
    const aliasNote = invokedAs === "task runbook" ? "" : " (alias for `task runbook`)";
    const msg = `${invokedAs} requires a task id (e.g. \`${invokedAs} P1-T1\`)${aliasNote}.`;
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
