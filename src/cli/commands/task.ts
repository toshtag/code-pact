// The CLI wrapper layer for the `task` subcommand cluster. Routes
// `task <subcommand>` to the per-subcommand handlers defined below.
// JSON envelopes, exit codes, error codes, and flag surfaces are part
// of the stable CLI contract.
//
// `cmdTask` is the cluster-entry dispatch and is the only export.
// The per-subcommand handlers (cmdTaskAdd, cmdTaskContext, etc.) are
// private to this module.

import { parseArgs } from "node:util";
import { strictParse, strictParseAlias, ConfigError } from "../../lib/argv.ts";
import { cmdTaskExecute } from "./task-execute.ts";
import { cmdTaskLock } from "./task-lock.ts";
import { cmdReviewBundle } from "./review-bundle.ts";
import { cmdCiParity } from "./ci-parity.ts";
import {
  clusterUsage,
  emitUsage,
  hasHelpFlag,
  isHelpToken,
  subcommandUsage,
} from "../usage.ts";
import { toParseOptions } from "../spec/render.ts";
import { TASK_SPECS } from "../spec/task.ts";
import { isInteractive } from "../../lib/tty.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import {
  withWriteLock,
  emitOk,
  emitError,
  createCliAbortSignal,
  parseTimeoutArg,
} from "../util.ts";
import { runTaskContext } from "../../commands/task-context.ts";
import {
  resolveContextBudgetProfile,
  ContextBudgetProfileError,
} from "../../core/context-fit/resolve-budget-profile.ts";
import {
  loadAgentContextBudget,
  loadAgentContextBudgetBestEffort,
} from "../../core/context-fit/load-context-budget.ts";
import { underlyingSystemCode } from "../../core/context-deferral/context-errors.ts";
import { isStandardContextBudgetProfile } from "../../core/context-fit/budget-profiles.ts";
import type { ContextBudgetProfiles } from "../../core/schemas/agent-profile.ts";
import {
  runTaskComplete,
  type PriorLocalSignal,
} from "../../commands/task-complete.ts";
import { projectVerifyForPublicJson } from "../../commands/verify.ts";
import {
  runTaskRecordDone,
  type DecisionRequiredData,
} from "../../commands/task-record-done.ts";
import { runTaskPrepare } from "../../commands/task-prepare.ts";
import type { TaskPrepareBudgetSelection } from "../../core/context-fit/applied-context-budget.ts";
import {
  runTaskFinalize,
  TaskFinalizeAuditStrictError,
} from "../../commands/task-finalize.ts";
import { runTaskCancel } from "../../commands/task-cancel.ts";
import { runTaskRunbook } from "../../commands/task-runbook.ts";
import {
  runTaskStart,
  runTaskBlock,
  runTaskResume,
} from "../../commands/task-progress.ts";
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
import { decisionRefPathReason } from "../../core/schemas/decision-ref.ts";
import {
  buildFailureSummaryFromChecks,
  buildFailureSummaryFromFinalizeCode,
  type FailureCheckLike,
  type FailureSummary,
} from "../../core/failure/failure-summary.ts";
import { renderFailureSummaryLines } from "../render/failure-summary.ts";
import {
  projectPreflightFailureForAgent,
  projectVerifyForAgent,
  projectVerifySummaryForAgent,
  stringifyBoundedAgentEnvelope,
} from "../../core/evidence/failure-capsule.ts";
import { formatRepairPolicySummary } from "../../core/recommend/repair-policy.ts";

function wantsAgentDetail(argv: string[], globalJson: boolean): boolean {
  const detailIndex = argv.indexOf("--detail");
  return (
    (globalJson || argv.includes("--json")) &&
    (argv.includes("--detail=agent") ||
      (detailIndex >= 0 && argv[detailIndex + 1] === "agent"))
  );
}

function emitAgentTaskCompleteError(
  error: { code: string; cause_code?: string; message: string },
  reason?: string,
  data: Record<string, unknown> = {},
): void {
  process.stdout.write(
    stringifyBoundedAgentEnvelope({
      ok: false,
      error,
      data: {
        ...data,
        ...projectPreflightFailureForAgent(
          error.cause_code === "ABORTED" ? "aborted" : "invalid_state",
          reason,
        ),
      },
    }),
  );
}

function messageForAgentError(code: string): string {
  switch (code) {
    case "TASK_NOT_FOUND":
      return "Task not found";
    case "AMBIGUOUS_TASK_ID":
      return "Ambiguous task id";
    case "AGENT_NOT_FOUND":
      return "Agent not found";
    case "AGENT_NOT_ENABLED":
      return "Agent not enabled";
    case "INVALID_TASK_TRANSITION":
      return "Invalid task transition";
    case "PHASE_SNAPSHOT_INVALID":
      return "Phase snapshot invalid";
    case "CONFIG_ERROR":
      return "Invalid configuration";
    default:
      return "Task complete failed";
  }
}

export async function cmdTask(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  // `task`, `task help`, `task --help`, `task -h` → cluster usage (exit 0).
  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("task"));
  }
  // `task <sub> --help` → per-subcommand usage (exit 0). subcommandUsage
  // returns rich leaf help for the lifecycle verbs, else a generic stub.
  if (hasHelpFlag(rest)) {
    return emitUsage(subcommandUsage("task", subcommand));
  }

  if (subcommand === "context") {
    return cmdTaskContext(rest, locale, globalJson);
  }
  if (subcommand === "complete") {
    return cmdTaskComplete(rest, locale, globalJson);
  }
  if (subcommand === "record-done") {
    return cmdTaskRecordDone(rest, locale, globalJson);
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
  // with `phase reconcile`). The invoked name is threaded through so error
  // messages name the alias.
  if (subcommand === "finalize" || subcommand === "reconcile") {
    return cmdTaskFinalize(rest, locale, globalJson, `task ${subcommand}`);
  }
  // `next` is a beginner-friendly alias for `runbook` ("what should I do next?").
  if (subcommand === "runbook" || subcommand === "next") {
    return cmdTaskRunbook(rest, locale, globalJson, `task ${subcommand}`);
  }
  if (subcommand === "cancel") {
    return cmdTaskCancel(rest, locale, globalJson);
  }
  if (subcommand === "execute") {
    return cmdTaskExecute(rest, locale, globalJson);
  }
  if (subcommand === "lock") {
    return cmdTaskLock(rest, locale, globalJson);
  }
  if (subcommand === "review-bundle") {
    return cmdReviewBundle(rest, locale, globalJson);
  }
  if (subcommand === "ci-parity") {
    return cmdCiParity(rest, locale, globalJson);
  }

  const msg = `task: unknown subcommand "${subcommand ?? ""}". Use: add | context | prepare | start | status | block | resume | complete | record-done | finalize | runbook | cancel | execute | lock | review-bundle | ci-parity (aliases: reconcile = finalize, next = runbook)`;
  emitError(globalJson, "CONFIG_ERROR", msg);
  return 2;
}

// Non-interactive-only flags for `task add`. Presence of any of these flags
// without `--description` triggers CONFIG_ERROR — the runbook never silently
// falls through to the wizard or silently ignores flags.
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

type LocaleMessages = (typeof messages)[Locale];

function emitConfigError(message: string, json: boolean): void {
  emitError(json, "CONFIG_ERROR", message);
}

/**
 * Shared `ConfigError → CONFIG_ERROR` envelope for the strict-parse catch at
 * the top of every `task` subcommand. Re-throws a non-ConfigError (a real bug)
 * so it still surfaces as an unhandled exception (exit 3). `--json` is read
 * from argv because parsing failed before `values.json` was available. Returns
 * 2 after emitting.
 */
function emitParseConfigError(
  err: unknown,
  argv: string[],
  globalJson: boolean,
): number {
  if (!(err instanceof ConfigError)) throw err;
  emitError(globalJson || argv.includes("--json"), "CONFIG_ERROR", err.message);
  return 2;
}

/**
 * Shared error-to-envelope mapping for `task context` and `task prepare`
 * (same codes, same `m.task.context.*` messages, same top-level `data` for
 * AMBIGUOUS_PHASE_ID / CONTEXT_OVER_BUDGET). Context cache operational
 * failures exit 1; argument/configuration failures exit 2. Unrecognized codes
 * re-throw (default) so a genuine bug surfaces as exit 3.
 */
function emitContextLikeError(
  err: Error,
  taskId: string,
  agent: string | undefined,
  m: LocaleMessages,
  json: boolean,
): number {
  const code = (err as NodeJS.ErrnoException).code;
  let msg: string;
  let outCode: string;
  let envelopeData: Record<string, unknown> | undefined;
  let exitCode = 2;
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
    case "AMBIGUOUS_PHASE_ID": {
      msg = err.message;
      outCode = "AMBIGUOUS_PHASE_ID";
      envelopeData = {
        phases:
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [],
      };
      break;
    }
    // design-docs-ephemeral (step 4a): a hand-deleted phase whose archive
    // snapshot is corrupt / identity-mismatched / task-id-colliding cannot release
    // the missing phase — fail-closed, even though the target task is live. Surface
    // it cleanly instead of crashing (so the collision check is not a silent bypass).
    case "PHASE_SNAPSHOT_INVALID":
      msg = err.message;
      outCode = "PHASE_SNAPSHOT_INVALID";
      break;
    case "AGENT_NOT_ENABLED":
      msg = m.task.context.agentNotEnabled(agent ?? "");
      outCode = "AGENT_NOT_ENABLED";
      break;
    case "AGENT_NOT_FOUND":
      msg = m.task.context.agentNotFound(agent ?? "");
      outCode = "AGENT_NOT_FOUND";
      break;
    // A malformed, explicitly-configured context_budget (surfaced while
    // resolving --context-budget) is a config problem, not an internal error.
    case "CONFIG_ERROR":
      msg = err.message;
      outCode = "CONFIG_ERROR";
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
    case "CONTEXT_NOT_FOUND":
    case "CONTEXT_INVALID":
    case "CONTEXT_DIGEST_MISMATCH":
    case "CONTEXT_PATH_UNSAFE":
    case "CONTEXT_READ_FAILED":
    case "CONTEXT_WRITE_FAILED": {
      msg = err.message;
      outCode = code;
      exitCode = 1;
      const systemCode = underlyingSystemCode(err);
      if (systemCode !== undefined) envelopeData = { system_code: systemCode };
      break;
    }
    default:
      throw err;
  }
  // Failure detail goes in a TOP-LEVEL `data` (the documented envelope
  // convention, matching doctor / validate and the cli-contract recovery prose
  // `data.minimum_achievable_bytes`), not under `error.data`.
  emitError(
    json,
    outCode,
    msg,
    envelopeData !== undefined ? { data: envelopeData } : {},
  );
  return exitCode;
}

// Resolve a context byte budget from the two mutually-exclusive flags
// `--budget-bytes` and `--context-budget`, shared by `task context` and
// `task prepare`. Returns:
//   { kind: "ok", budgetBytes }   — at most one source provided & valid
//   { kind: "error", exitCode }   — a CONFIG_ERROR envelope was already emitted
//
// Budget-flag handling is two-phase so `task prepare`'s early-return
// states (done / blocked / unmet-deps, which skip the pack build) never pay
// for profile resolution or an agent-profile read:
//
//   1. validateBudgetFlags() — PURE, no I/O. Checks --budget-bytes /
//      --context-budget mutual exclusion and the --budget-bytes integer form.
//      Returns the immediate byte budget (--budget-bytes), a pending profile
//      name (--context-budget, not yet resolved), or neither.
//   2. resolveContextBudgetFlag() — ASYNC, reads the agent profile. Turns a
//      pending profile name into a byte budget per the agent-less
//      contract. `task context` (always builds) calls it immediately; `task
//      prepare` defers it behind the early-return decision.

type ValidatedBudget =
  | { kind: "bytes"; budgetBytes: number }
  | { kind: "profile"; profileName: string }
  | { kind: "none" }
  | { kind: "error"; exitCode: number };

function validateBudgetFlags(
  command: "task context" | "task prepare",
  values: Record<string, unknown>,
  json: boolean,
): ValidatedBudget {
  const budgetRaw = values["budget-bytes"];
  const profileRaw = values["context-budget"];
  const hasBudgetBytes = typeof budgetRaw === "string";
  const hasContextBudget = typeof profileRaw === "string";

  // Mutual exclusion (mirrors plan brief's three-mode exclusion).
  if (hasBudgetBytes && hasContextBudget) {
    emitConfigError(
      `${command}: --budget-bytes and --context-budget are mutually exclusive.`,
      json,
    );
    return { kind: "error", exitCode: 2 };
  }

  // --budget-bytes: positive-integer validation.
  if (hasBudgetBytes) {
    const n = Number.parseInt(budgetRaw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== budgetRaw.trim()) {
      emitConfigError(
        `${command}: --budget-bytes requires a positive integer (got "${budgetRaw}").`,
        json,
      );
      return { kind: "error", exitCode: 2 };
    }
    return { kind: "bytes", budgetBytes: n };
  }

  if (hasContextBudget) {
    return { kind: "profile", profileName: profileRaw.trim() };
  }
  return { kind: "none" };
}

type ValidatedTaskPrepareBudget =
  | { kind: "ok"; selection: TaskPrepareBudgetSelection }
  | { kind: "error"; exitCode: number };

function validateTaskPrepareBudgetFlags(
  values: Record<string, unknown>,
  json: boolean,
): ValidatedTaskPrepareBudget {
  const budgetRaw = values["budget-bytes"];
  const profileRaw = values["context-budget"];
  const hasBudgetBytes = typeof budgetRaw === "string";
  const hasContextBudget = typeof profileRaw === "string";
  const hasRecommended = values["recommended-context-budget"] === true;
  const modeCount = [hasBudgetBytes, hasContextBudget, hasRecommended].filter(
    Boolean,
  ).length;

  if (modeCount > 1) {
    emitConfigError(
      "task prepare: --budget-bytes, --context-budget, and --recommended-context-budget are mutually exclusive.",
      json,
    );
    return { kind: "error", exitCode: 2 };
  }

  if (hasBudgetBytes) {
    const n = Number.parseInt(budgetRaw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== budgetRaw.trim()) {
      emitConfigError(
        `task prepare: --budget-bytes requires a positive integer (got "${budgetRaw}").`,
        json,
      );
      return { kind: "error", exitCode: 2 };
    }
    return {
      kind: "ok",
      selection: { kind: "explicit_bytes", budgetBytes: n },
    };
  }

  if (hasContextBudget) {
    return {
      kind: "ok",
      selection: { kind: "explicit_profile", profileName: profileRaw.trim() },
    };
  }

  if (hasRecommended) {
    return { kind: "ok", selection: { kind: "recommended_cli" } };
  }

  return { kind: "ok", selection: { kind: "none" } };
}

/**
 * Resolve a `--context-budget` profile name to a byte budget per the
 * agent-less-resolution contract. Throws `ContextBudgetProfileError`
 * (`CONFIG_ERROR`) on an unknown profile and `code`-tagged errors on a strict
 * agent-profile load failure (custom-name path only).
 *
 * - A STANDARD name (tight/balanced/wide) resolves to its built-in byte value
 *   WITHOUT requiring an agent profile; the profile is consulted best-effort
 *   only for an OVERRIDE, and its absence is never fatal.
 * - A CUSTOM name lives only inside an agent profile, so it requires the strict
 *   load and is CONFIG_ERROR when undeclared.
 */
async function resolveContextBudgetFlag(
  cwd: string,
  agent: string | undefined,
  profileName: string,
): Promise<number> {
  let contextBudget: ContextBudgetProfiles | undefined;
  let agentName: string | undefined = agent;
  if (isStandardContextBudgetProfile(profileName)) {
    contextBudget = await loadAgentContextBudgetBestEffort(cwd, agent);
  } else {
    const loaded = await loadAgentContextBudget(cwd, agent);
    agentName = loaded.agentName;
    contextBudget = loaded.contextBudget;
  }
  return resolveContextBudgetProfile({ profileName, contextBudget, agentName });
}

async function cmdTaskAdd(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];
  const cwd = process.cwd();

  // Parse all flags via the stdlib parser. Multi-value fields accept multiple
  // occurrences (e.g. `--depends-on a --depends-on b`); comma-separated
  // values are intentionally not parsed (path-with-comma ambiguity).
  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: toParseOptions(TASK_SPECS.add!),
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

  const specFile =
    typeof values["spec-file"] === "string"
      ? (values["spec-file"] as string)
      : undefined;

  // --spec-file is a complete, machine-readable contract. It cannot be
  // combined with any task-field flag or an explicit --id.
  if (specFile) {
    const conflictingFlags = [
      "id",
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
    ].filter(name => {
      const v = values[name];
      if (Array.isArray(v)) return v.length > 0;
      return typeof v === "string";
    });
    if (conflictingFlags.length > 0) {
      const flagList = conflictingFlags.map(f => "--" + f).join(", ");
      emitConfigError(
        "task add: --spec-file cannot be combined with task-field flags: " +
          flagList,
        json,
      );
      return 2;
    }
  }

  const description =
    typeof values.description === "string"
      ? (values.description as string)
      : undefined;

  // Detect any non-interactive-only flag that was passed.
  const nonInteractiveFlagsSeen = TASK_ADD_NON_INTERACTIVE_ONLY_FLAGS.filter(
    flag => {
      if (flag === "description") return false; // handled separately
      const v = values[flag];
      if (Array.isArray(v)) return v.length > 0;
      return typeof v === "string";
    },
  );

  // Resolution branches:
  //   (a) --description present → non-interactive
  //   (b) --description absent, no other non-interactive flags, TTY → wizard
  //   (c) --description absent, no other non-interactive flags, no TTY →
  //       CONFIG_ERROR (TTY-required message, updated to mention alternative)
  //   (d) --description absent, non-interactive flag(s) present →
  //       CONFIG_ERROR (never silently enter the wizard, never silently ignore)
  if (description === undefined && nonInteractiveFlagsSeen.length > 0) {
    emitConfigError(
      `task add: non-interactive flag(s) provided without --description: ${nonInteractiveFlagsSeen
        .map(f => `--${f}`)
        .join(
          ", ",
        )}. Pass --description "<text>" to use the non-interactive path, or omit the flags to use the wizard.`,
      json,
    );
    return 2;
  }

  if (description === undefined && !isInteractive() && !specFile) {
    emitConfigError(
      `task add is interactive and requires a TTY. Use \`task add ${phaseId} --description "<text>" --type <type>\` for the non-interactive path (v1.4+), or \`phase import\` for bulk task creation.`,
      json,
    );
    return 2;
  }

  // Build non-interactive spec when --description is present. --type is
  // required in this mode; other readiness flags are optional.
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

    const parseEnum = <
      T extends {
        safeParse: (v: unknown) => { success: boolean; data?: unknown };
      },
    >(
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

    const ambiguity = parseEnum(
      AmbiguityLevel,
      values.ambiguity,
      "ambiguity",
      AmbiguityLevel.options,
    );
    if (!ambiguity.ok) return 2;
    const risk = parseEnum(RiskLevel, values.risk, "risk", RiskLevel.options);
    if (!risk.ok) return 2;
    const contextSize = parseEnum(
      ContextSize,
      values["context-size"],
      "context-size",
      ContextSize.options,
    );
    if (!contextSize.ok) return 2;
    const writeSurface = parseEnum(
      WriteSurface,
      values["write-surface"],
      "write-surface",
      WriteSurface.options,
    );
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
      if (Array.isArray(raw))
        return raw.filter((v): v is string => typeof v === "string");
      return undefined;
    };

    // Validate --decision-ref at the CLI boundary. A bad value (`.env`, a
    // traversal, README/PRUNED) is USER INPUT — surface it as CONFIG_ERROR /
    // exit 2, not as the exit-3 internal fault a downstream Phase.parse ZodError
    // would become (which has no `code` and escapes the catch below). The schema
    // re-validates on write; this is the early, honest boundary error. The
    // phase YAML is never touched: we return before runTaskAdd.
    const declaredDecisionRefs = asStringArray(values["decision-ref"]);
    if (declaredDecisionRefs) {
      for (const ref of declaredDecisionRefs) {
        const reason = decisionRefPathReason(ref);
        if (reason !== "") {
          emitConfigError(
            `task add: invalid --decision-ref "${ref}": ${reason} (expected a .md record under design/decisions/)`,
            json,
          );
          return 2;
        }
      }
    }

    nonInteractiveSpec = {
      description,
      type: typeParsed.data,
      ...(ambiguity.value !== undefined
        ? {
            ambiguity:
              ambiguity.value as TaskAddNonInteractiveSpec["ambiguity"],
          }
        : {}),
      ...(risk.value !== undefined
        ? { risk: risk.value as TaskAddNonInteractiveSpec["risk"] }
        : {}),
      ...(contextSize.value !== undefined
        ? {
            context_size:
              contextSize.value as TaskAddNonInteractiveSpec["context_size"],
          }
        : {}),
      ...(writeSurface.value !== undefined
        ? {
            write_surface:
              writeSurface.value as TaskAddNonInteractiveSpec["write_surface"],
          }
        : {}),
      ...(verificationStrength.value !== undefined
        ? {
            verification_strength:
              verificationStrength.value as TaskAddNonInteractiveSpec["verification_strength"],
          }
        : {}),
      ...(expectedDuration.value !== undefined
        ? {
            expected_duration:
              expectedDuration.value as TaskAddNonInteractiveSpec["expected_duration"],
          }
        : {}),
      ...(asStringArray(values["depends-on"])
        ? { depends_on: asStringArray(values["depends-on"])! }
        : {}),
      ...(asStringArray(values["decision-ref"])
        ? { decision_refs: asStringArray(values["decision-ref"])! }
        : {}),
      ...(asStringArray(values.read)
        ? { reads: asStringArray(values.read)! }
        : {}),
      ...(asStringArray(values.write)
        ? { writes: asStringArray(values.write)! }
        : {}),
      ...(asStringArray(values["acceptance-ref"])
        ? { acceptance_refs: asStringArray(values["acceptance-ref"])! }
        : {}),
    };
  }

  // Advisory write lock: serialize task-add (phase YAML write)
  // against concurrent design mutations. Wizard prompts (when no
  // --description is supplied) ALSO run under the lock.
  return withWriteLock(
    cwd,
    specFile
      ? `task add ${phaseId} --spec-file ...`
      : nonInteractiveSpec !== undefined
        ? `task add ${phaseId} --description "..."`
        : `task add ${phaseId}`,
    json,
    async (): Promise<number> => {
      try {
        const addOptions: import("../../commands/task-add.ts").TaskAddOptions =
          {
            cwd,
            phaseId,
            locale,
            id: specFile ? undefined : explicitId,
            ...(specFile ? { specFile } : {}),
            ...(nonInteractiveSpec
              ? { nonInteractive: nonInteractiveSpec }
              : {}),
          };
        const result = await runTaskAdd(addOptions);
        if (json) {
          emitOk(result);
        } else {
          process.stderr.write(
            `${m.task.added(result.taskId, result.phaseId, result.phasePath)}\n`,
          );
        }
        return 0;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        const message = err instanceof Error ? err.message : String(err);
        if (
          code === "PHASE_NOT_FOUND" ||
          code === "AMBIGUOUS_PHASE_ID" ||
          code === "DUPLICATE_TASK_ID" ||
          code === "TASK_REGISTRATION_ROUND_TRIP"
        ) {
          emitError(
            json,
            code,
            message,
            code === "AMBIGUOUS_PHASE_ID"
              ? {
                  data: {
                    phases:
                      (err as NodeJS.ErrnoException & { phases?: string[] })
                        .phases ?? [],
                  },
                }
              : {},
          );
          return code === "DUPLICATE_TASK_ID" ? 1 : 2;
        }
        if (code === "CONFIG_ERROR") {
          // Contained roadmap/phase loader refusal → structured, not exit 3.
          emitError(json, "CONFIG_ERROR", message);
          return 2;
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
      toParseOptions(TASK_SPECS.context!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const explain = values.explain === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task context requires a task id (e.g. `task context P1-T1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  // --budget-bytes / --context-budget mutual exclusion + integer form.
  // Pure, no I/O; a bad combination emits CONFIG_ERROR and returns.
  const budget = validateBudgetFlags("task context", values, json);
  if (budget.kind === "error") return budget.exitCode;

  try {
    // task context always builds the pack, so resolve a profile now. A
    // profile/agent resolution error emits CONFIG_ERROR (ContextBudgetProfileError)
    // or throws a `code`-tagged error routed through the catch below.
    let budgetBytes: number | undefined;
    if (budget.kind === "bytes") {
      budgetBytes = budget.budgetBytes;
    } else if (budget.kind === "profile") {
      try {
        budgetBytes = await resolveContextBudgetFlag(
          cwd,
          agent,
          budget.profileName,
        );
      } catch (err) {
        if (err instanceof ContextBudgetProfileError) {
          emitConfigError(`task context: ${err.message}`, json);
          return 2;
        }
        throw err;
      }
    }

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
      if (pack.deferredContext) {
        data.deferred_context = {
          ...pack.deferredContext,
          persisted: false,
          retrieve_command: null,
        };
      }
      if (explain) {
        data.total_bytes = pack.totalBytes;
        data.context_pack_bytes = pack.totalBytes;
        data.sections = pack.sections;
        data.excluded = pack.excluded;
        // Additive byte metrics. `final_bytes` equals total_bytes ==
        // context_pack_bytes; `budget_bytes` is emitted only when a budget was
        // applied (--budget-bytes / --context-budget); `minimum_achievable_bytes`
        // is the same floor CONTEXT_OVER_BUDGET reports. Byte-based and
        // deterministic — no tokenizer / model / network.
        const em = pack.explainMetrics;
        if (em) {
          data.natural_bytes = em.naturalBytes;
          data.final_bytes = em.finalBytes;
          if (em.budgetBytes !== undefined) data.budget_bytes = em.budgetBytes;
          data.saved_bytes = em.savedBytes;
          data.deferred_bytes = em.deferredBytes;
          data.saved_ratio = em.savedRatio;
          data.minimum_achievable_bytes = em.minimumAchievableBytes;
          data.elided_sections = em.elidedSections.map(e => ({
            name: e.name,
            bytes: e.bytes,
          }));
        }
      }
      emitOk(data);
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
    return emitContextLikeError(err, taskId, agent, m, json);
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
      toParseOptions(TASK_SPECS.prepare!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task prepare requires a task id (e.g. `task prepare P1-T1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const agent = values.agent as string | undefined;
  const dryRun = values["dry-run"] === true;
  const detail = values.detail as string | undefined;
  if (detail !== undefined && detail !== "minimal" && detail !== "full") {
    const msg = `task prepare: --detail must be "minimal" or "full" (got "${detail}").`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  let taskPrepareDetail: "minimal" | "full" = detail ?? "minimal";

  const cwd = process.cwd();

  // --budget-bytes / --context-budget / --recommended-context-budget mutual
  // exclusion + integer form. Pure, no I/O; a bad combination emits
  // CONFIG_ERROR and returns before pack/profile reads.
  const budget = validateTaskPrepareBudgetFlags(values, json);
  if (budget.kind === "error") return budget.exitCode;

  // Explicit budget flags imply full detail: budgeting is about how much of the
  // full context pack to retain, not about suppressing it. An explicit budget
  // selection overrides --detail minimal and switches the output to full.
  if (budget.kind === "ok" && budget.selection.kind !== "none") {
    taskPrepareDetail = "full";
  }

  try {
    const result = await runTaskPrepare({
      cwd,
      taskId,
      agent,
      dryRun,
      budgetSelection: budget.selection,
      detail: taskPrepareDetail,
    });

    if (json) {
      emitOk(result);
      return 0;
    }

    if (result.detail === "minimal") {
      const lines: string[] = [];
      lines.push(`Task: ${result.task.id}`);
      lines.push(`State: ${result.task.state}`);
      lines.push(`Goal: ${result.task.goal}`);

      if (result.task.read_scope.length > 0) {
        lines.push("");
        lines.push("Read:");
        for (const r of result.task.read_scope) {
          lines.push(`- ${r}`);
        }
      }

      if (result.task.write_scope.length > 0) {
        lines.push("");
        lines.push("Write:");
        for (const w of result.task.write_scope) {
          lines.push(`- ${w}`);
        }
      }

      if (result.task.done_when.length > 0) {
        lines.push("");
        lines.push("Done when:");
        for (const d of result.task.done_when) {
          lines.push(`- ${d}`);
        }
      }

      if (result.task.verify.length > 0) {
        lines.push("");
        lines.push("Verify:");
        for (const v of result.task.verify) {
          lines.push(`- ${v}`);
        }
      }

      lines.push("");
      lines.push(`Decision required: ${result.task.decision_required}`);
      if (result.task.decision_refs && result.task.decision_refs.length > 0) {
        lines.push("Decision refs:");
        for (const d of result.task.decision_refs) {
          lines.push(`- ${d}`);
        }
      }

      if (result.blocked_by && result.blocked_by.length > 0) {
        lines.push("");
        lines.push("Blocked by:");
        for (const b of result.blocked_by) {
          lines.push(`- ${b}`);
        }
      }

      if (result.block) {
        lines.push("");
        lines.push(`Block summary: ${result.block.summary}`);
      }

      if (result.failure) {
        lines.push("");
        lines.push(`Failure summary: ${result.failure.summary ?? "(none)"}`);
      }

      lines.push("");
      lines.push(`Next: ${result.next.type}`);
      if (result.next.command) {
        lines.push(`  ${result.next.command}`);
      }

      lines.push("");
      lines.push("More:");
      lines.push(`  ${result.more.command}`);

      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }

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
      lines.push(
        `Repair:         ${formatRepairPolicySummary(result.recommendation.repairPolicy)}`,
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
    if (result.next_action.type !== "noop_cancelled") {
      const commands =
        result.commands as import("../../commands/task-prepare.ts").TaskPrepareCommands;
      lines.push("");
      lines.push("Commands:");
      lines.push(`  context:  ${commands.context}`);
      lines.push(`  start:    ${commands.start}`);
      lines.push(`  verify:   ${commands.verify}`);
      lines.push(`  complete: ${commands.complete}`);
      lines.push(`  finalize: ${commands.finalize}`);
      lines.push(`  record-done: ${commands["record-done"]}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    return emitContextLikeError(err, taskId, agent, m, json);
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
      toParseOptions(TASK_SPECS.complete!),
      { allowPositionals: true },
    ));
  } catch (error) {
    if (error instanceof ConfigError && wantsAgentDetail(argv, globalJson)) {
      emitAgentTaskCompleteError(
        { code: "CONFIG_ERROR", message: "Invalid configuration" },
        error.message,
      );
      return 2;
    }
    return emitParseConfigError(error, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const dryRun = values["dry-run"] === true;
  const detail = values.detail as string | undefined;
  const taskId = positionals[0];
  if (detail !== undefined && !json) {
    emitError(false, "CONFIG_ERROR", "task complete: --detail requires --json");
    return 2;
  }
  if (detail !== undefined && detail !== "full" && detail !== "agent") {
    emitError(
      json,
      "CONFIG_ERROR",
      `task complete: invalid --detail "${detail}" (expected full or agent)`,
    );
    return 2;
  }
  if (!taskId) {
    if (detail === "agent") {
      emitAgentTaskCompleteError(
        { code: "CONFIG_ERROR", message: "Invalid configuration" },
        "task complete requires a task id (e.g. `task complete P1-T1`).",
      );
      return 2;
    }
    emitError(
      json,
      "CONFIG_ERROR",
      "task complete requires a task id (e.g. `task complete P1-T1`).",
    );
    return 2;
  }
  const parsedTimeout = parseTimeoutArg(
    values.timeout as string | undefined,
    json,
    {
      emit: detail !== "agent",
    },
  );
  if (!parsedTimeout.ok) {
    if (detail === "agent") {
      emitAgentTaskCompleteError(
        { code: "CONFIG_ERROR", message: "Invalid configuration" },
        "Invalid timeout.",
        { task_id: taskId },
      );
    }
    return parsedTimeout.exitCode;
  }

  const agent = values.agent as string | undefined;
  const { signal, cleanup } = createCliAbortSignal();
  try {
    const result = await runTaskComplete({
      cwd: process.cwd(),
      taskId,
      agent,
      dryRun,
      timeoutMs: parsedTimeout.value,
      signal,
    });

    if (result.kind === "already_done") {
      if (json) {
        const data = {
          already_done: true,
          task_id: result.task_id,
          phase_id: result.phase_id,
          agent: result.agent,
        };
        if (detail === "agent") {
          process.stdout.write(
            stringifyBoundedAgentEnvelope({ ok: true, data }),
          );
        } else {
          emitOk(data);
        }
      } else {
        process.stdout.write(`${m.task.complete.alreadyDone(taskId)}\n`);
      }
      return 0;
    }

    if (result.kind === "dry_run") {
      if (json) {
        const data = {
          dry_run: true,
          task_id: result.task_id,
          phase_id: result.phase_id,
          agent: result.agent,
          would_append: result.would_append,
        };
        if (detail === "agent") {
          process.stdout.write(
            stringifyBoundedAgentEnvelope({ ok: true, data }),
          );
        } else {
          emitOk(data);
        }
      } else {
        process.stdout.write(`${m.task.complete.dryRun(taskId)}\n`);
      }
      return 0;
    }

    if (json) {
      const data = {
        task_id: result.task_id,
        phase_id: result.phase_id,
        agent: result.agent,
        event: result.event,
        verify:
          detail === "agent"
            ? projectVerifySummaryForAgent(result.verify)
            : projectVerifyForPublicJson(result.verify),
        ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
      };
      if (detail === "agent") {
        process.stdout.write(stringifyBoundedAgentEnvelope({ ok: true, data }));
      } else {
        emitOk(data);
      }
    } else {
      process.stdout.write(
        `${m.task.complete.success(taskId, result.agent)}\n`,
      );
    }
    return 0;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw error;
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ABORTED") {
      const errorObj = {
        code: "VERIFICATION_FAILED",
        cause_code: "ABORTED",
        message: m.task.complete.aborted(taskId),
      };
      if (json) {
        if (detail === "agent") {
          process.stdout.write(
            stringifyBoundedAgentEnvelope({
              ok: false,
              error: {
                code: "VERIFICATION_FAILED",
                cause_code: "ABORTED",
                message: "Verification aborted",
              },
              data: {
                task_id: taskId,
                aborted: true,
                ...projectPreflightFailureForAgent(
                  "aborted",
                  m.task.complete.aborted(taskId),
                ),
              },
            }),
          );
        } else {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: errorObj,
              data: { task_id: taskId, aborted: true },
            })}\n`,
          );
        }
      } else {
        process.stderr.write(`${errorObj.message}\n`);
      }
      return 1;
    }

    if (code === "VERIFICATION_FAILED") {
      const checks =
        (error as NodeJS.ErrnoException & { checks?: FailureCheckLike[] })
          .checks ?? [];
      const warnings =
        (error as NodeJS.ErrnoException & { warnings?: unknown[] }).warnings ??
        undefined;
      const priorLocalSignal =
        (
          error as NodeJS.ErrnoException & {
            priorLocalSignal?: PriorLocalSignal;
          }
        ).priorLocalSignal ?? undefined;
      const summary = buildFailureSummaryFromChecks(checks, taskId);
      const wasAborted = checks.some(
        check =>
          (check as FailureCheckLike & { aborted?: boolean }).aborted === true,
      );
      let errorObj: { code: string; cause_code?: string; message: string };
      if (wasAborted) {
        errorObj = {
          code: "VERIFICATION_FAILED",
          cause_code: "ABORTED",
          message: m.task.complete.aborted(taskId),
        };
      } else {
        switch (summary.first_failure?.name) {
          case "decision":
            errorObj = {
              code: "VERIFICATION_FAILED",
              cause_code: "DECISION_REQUIRED",
              message: m.task.complete.causeDecision(
                taskId,
                summary.first_failure?.reason ?? "",
              ),
            };
            break;
          case "commands":
            errorObj = {
              code: "VERIFICATION_FAILED",
              cause_code: "COMMANDS_FAILED",
              message: m.task.complete.causeCommands(
                taskId,
                summary.first_failure?.reason ?? "",
              ),
            };
            break;
          default:
            errorObj = {
              code: "VERIFICATION_FAILED",
              message: m.task.complete.verificationFailed(taskId),
            };
        }
      }

      if (json) {
        const verifyResult = { ok: false as const, checks };
        if (detail === "agent") {
          process.stdout.write(
            stringifyBoundedAgentEnvelope({
              ok: false,
              error: {
                code: "VERIFICATION_FAILED",
                ...(errorObj.cause_code
                  ? { cause_code: errorObj.cause_code }
                  : {}),
                message: wasAborted
                  ? "Verification aborted"
                  : "Verification failed",
              },
              data: {
                task_id: taskId,
                ...(await projectVerifyForAgent(process.cwd(), verifyResult)),
                ...(priorLocalSignal !== undefined
                  ? { prior_local_signal: priorLocalSignal }
                  : {}),
                suggested_next_command: summary.suggested_next_command,
                ...(warnings !== undefined ? { warnings } : {}),
                ...(wasAborted ? { aborted: true } : {}),
              },
            }),
          );
        } else {
          process.stdout.write(
            `${JSON.stringify({
              ok: false,
              error: errorObj,
              data: {
                task_id: taskId,
                verify: projectVerifyForPublicJson(verifyResult),
                failed_checks: summary.failed_checks,
                first_failure: summary.first_failure,
                suggested_next_command: summary.suggested_next_command,
                ...(warnings !== undefined ? { warnings } : {}),
                ...(wasAborted ? { aborted: true } : {}),
              },
            })}\n`,
          );
        }
      } else {
        process.stderr.write(`${errorObj.message}\n`);
        const lines = renderFailureSummaryLines(m.task.failure, summary);
        if (lines.length > 0) process.stderr.write(`${lines.join("\n")}\n`);
      }
      return 1;
    }

    let message: string;
    let outCode: string;
    let errorData: Record<string, unknown> | undefined;
    switch (code) {
      case "TASK_NOT_FOUND":
        message = m.task.complete.taskNotFound(taskId);
        outCode = "TASK_NOT_FOUND";
        break;
      case "AMBIGUOUS_TASK_ID": {
        const phases =
          (error as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        message = m.task.complete.ambiguous(taskId, phases);
        outCode = "AMBIGUOUS_TASK_ID";
        break;
      }
      case "AGENT_NOT_ENABLED":
        message = m.task.complete.agentNotEnabled(agent ?? "");
        outCode = "AGENT_NOT_ENABLED";
        break;
      case "AGENT_NOT_FOUND":
        message = m.task.complete.agentNotFound(agent ?? "");
        outCode = "AGENT_NOT_FOUND";
        break;
      case "TASK_DEPENDENCY_INCOMPLETE": {
        const deps =
          (error as NodeJS.ErrnoException & { deps?: string[] }).deps ?? [];
        message = m.task.complete.dependencyIncomplete(taskId, deps);
        outCode = "TASK_DEPENDENCY_INCOMPLETE";
        errorData = { deps };
        break;
      }
      case "INVALID_TASK_TRANSITION": {
        const current =
          (error as NodeJS.ErrnoException & { current?: string }).current ?? "";
        message = m.task.complete.invalidTransition(taskId, current);
        outCode = "INVALID_TASK_TRANSITION";
        break;
      }
      case "PHASE_SNAPSHOT_INVALID":
        message = error.message;
        outCode = "PHASE_SNAPSHOT_INVALID";
        break;
      case "TASK_CONTRACT_LOCK_REQUIRED": {
        message = error.message;
        outCode = "TASK_CONTRACT_LOCK_REQUIRED";
        break;
      }
      case "TASK_CONTRACT_DRIFT": {
        const drift =
          (error as NodeJS.ErrnoException & { drift?: { message: string }[] })
            .drift ?? [];
        const changed =
          (error as NodeJS.ErrnoException & { changed_fields?: string[] })
            .changed_fields ?? [];
        message = `TASK_CONTRACT_DRIFT for "${taskId}": ${drift.map(d => d.message).join("; ")}`;
        outCode = "TASK_CONTRACT_DRIFT";
        errorData = {
          locked_digest:
            (error as NodeJS.ErrnoException & { locked_digest?: string })
              .locked_digest ?? "",
          current_digest:
            (error as NodeJS.ErrnoException & { current_digest?: string })
              .current_digest ?? "",
          changed_fields: changed,
          drift,
        };
        break;
      }
      case "TASK_CANCELLED":
        message = error.message;
        outCode = "TASK_CANCELLED";
        break;
      case "CONFIG_ERROR":
        message = error.message;
        outCode = "CONFIG_ERROR";
        break;
      default:
        throw error;
    }
    if (detail === "agent") {
      emitAgentTaskCompleteError(
        { code: outCode, message: messageForAgentError(outCode) },
        message,
        { task_id: taskId, agent, ...(errorData ?? {}) },
      );
    } else {
      emitError(
        json,
        outCode,
        message,
        errorData !== undefined ? { data: errorData } : {},
      );
    }
    return 2;
  } finally {
    cleanup();
  }
}

async function cmdTaskRecordDone(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task record-done",
      argv,
      toParseOptions(TASK_SPECS["record-done"]!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const dryRun = values["dry-run"] === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg =
      "task record-done requires a task id (e.g. `task record-done P1-T1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const agent = values.agent as string | undefined;
  const evidence = values.evidence as string | undefined;
  const notes = values.notes as string | undefined;
  // Early CLI-side check for a clear message; runTaskRecordDone re-validates
  // as the final defense for direct/internal callers.
  if (evidence === undefined || evidence.trim().length === 0) {
    const msg = m.task.recordDone.evidenceRequired;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const cwd = process.cwd();

  try {
    const result = await runTaskRecordDone({
      cwd,
      taskId,
      agent,
      evidence: [evidence],
      notes,
      dryRun,
    });

    if (result.kind === "already_done") {
      if (json) {
        emitOk({
          already_done: true,
          task_id: result.task_id,
          phase_id: result.phase_id,
          agent: result.agent,
        });
      } else {
        process.stdout.write(`${m.task.recordDone.alreadyDone(taskId)}\n`);
      }
      return 0;
    }

    if (result.kind === "dry_run") {
      if (json) {
        emitOk({
          dry_run: true,
          task_id: result.task_id,
          phase_id: result.phase_id,
          agent: result.agent,
          would_append: result.would_append,
        });
      } else {
        process.stdout.write(`${m.task.recordDone.dryRun(taskId)}\n`);
      }
      return 0;
    }

    // result.kind === "done"
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        agent: result.agent,
        event: result.event,
      });
    } else {
      process.stdout.write(
        `${m.task.recordDone.success(taskId, result.agent)}\n`,
      );
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "DECISION_REQUIRED") {
      const data = (
        err as NodeJS.ErrnoException & { data?: DecisionRequiredData }
      ).data;
      const msg = m.task.recordDone.decisionRequired(taskId);
      emitError(
        json,
        "DECISION_REQUIRED",
        msg,
        data !== undefined ? { data } : {},
      );
      return 2;
    }

    if (code === "CONFIG_ERROR") {
      emitError(json, "CONFIG_ERROR", err.message);
      return 2;
    }

    let msg: string;
    let outCode: string;
    let errorData: Record<string, unknown> | undefined;
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
      case "TASK_DEPENDENCY_INCOMPLETE": {
        const deps =
          (err as NodeJS.ErrnoException & { deps?: string[] }).deps ?? [];
        msg = m.task.recordDone.dependencyIncomplete(taskId, deps);
        outCode = "TASK_DEPENDENCY_INCOMPLETE";
        errorData = { deps };
        break;
      }
      case "INVALID_TASK_TRANSITION": {
        const current =
          (err as NodeJS.ErrnoException & { current?: string }).current ?? "";
        msg = m.task.recordDone.invalidTransition(taskId, current);
        outCode = "INVALID_TASK_TRANSITION";
        break;
      }
      case "TASK_CONTRACT_LOCK_REQUIRED":
        msg = err.message;
        outCode = "TASK_CONTRACT_LOCK_REQUIRED";
        break;
      case "TASK_CONTRACT_DRIFT": {
        const drift =
          (err as NodeJS.ErrnoException & { drift?: { message: string }[] })
            .drift ?? [];
        const changed =
          (err as NodeJS.ErrnoException & { changed_fields?: string[] })
            .changed_fields ?? [];
        msg = `TASK_CONTRACT_DRIFT for "${taskId}": ${drift.map(d => d.message).join("; ")}`;
        outCode = "TASK_CONTRACT_DRIFT";
        errorData = {
          locked_digest:
            (err as NodeJS.ErrnoException & { locked_digest?: string })
              .locked_digest ?? "",
          current_digest:
            (err as NodeJS.ErrnoException & { current_digest?: string })
              .current_digest ?? "",
          changed_fields: changed,
          drift,
        };
        break;
      }
      case "PHASE_SNAPSHOT_INVALID":
        msg = err.message;
        outCode = "PHASE_SNAPSHOT_INVALID";
        break;
      case "TASK_CANCELLED":
        msg = err.message;
        outCode = "TASK_CANCELLED";
        break;
      // A path-safety refusal / malformed roadmap or phase from the now-contained
      // control-plane loaders (resolveTaskInRoadmap → loadRoadmap → loadPhase):
      // structured (exit 2), never an uncoded internal error (exit 3).
      case "CONFIG_ERROR":
        msg = err.message;
        outCode = "CONFIG_ERROR";
        break;
      default:
        throw err;
    }
    emitError(
      json,
      outCode,
      msg,
      errorData !== undefined ? { data: errorData } : {},
    );
    return code === "TASK_CONTRACT_DRIFT" ||
      code === "TASK_CONTRACT_LOCK_REQUIRED"
      ? 1
      : 2;
  }
}

// ---------------------------------------------------------------------------
// Command: task finalize
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
      toParseOptions(TASK_SPECS.finalize!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const write = values.write === true;
  const baseRef =
    typeof values["base-ref"] === "string" ? values["base-ref"] : undefined;
  const auditStrict = values["audit-strict"] === true;
  const taskId = positionals[0];
  if (!taskId) {
    const aliasNote =
      invokedAs === "task finalize" ? "" : " (alias for `task finalize`)";
    const msg = `${invokedAs} requires a task id (e.g. \`${invokedAs} P1-T1\`)${aliasNote}.`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  // `--base-ref` requires `--json` so human mode never spawns git and the
  // audit field always lands in a machine-readable envelope. Silent ignore
  // would mislead users into thinking the branch-level audit ran when it did not.
  if (baseRef !== undefined && !json) {
    const msg =
      "task finalize --base-ref requires --json because write_audit is emitted only in JSON output.";
    process.stderr.write(`CONFIG_ERROR: ${msg}\n`);
    return 2;
  }

  // `--audit-strict` requires `--json` for the same reason — the audit only
  // runs in JSON mode, so a strict gate without --json would silently degrade
  // to a no-op.
  if (auditStrict && !json) {
    const msg =
      "task finalize --audit-strict requires --json because it gates the JSON write_audit.";
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
          emitOk({
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
          });
        } else {
          process.stdout.write(`${m.task.finalize.alreadyFinalized(taskId)}\n`);
        }
        return 0;
      }

      if (result.kind === "would_finalize") {
        if (json) {
          emitOk({
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
          });
        } else {
          process.stdout.write(
            `${m.task.finalize.wouldFinalize(taskId, result.file)}\n`,
          );
        }
        return 0;
      }

      // result.kind === "finalized"
      if (json) {
        emitOk({
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
        });
      } else {
        process.stdout.write(
          `${m.task.finalize.success(taskId, result.file)}\n`,
        );
      }
      return 0;
    } catch (err: unknown) {
      if (!(err instanceof Error)) throw err;

      // Strict-audit failure surfaces as WRITES_AUDIT_STRICT_FAILED with
      // exit 1 (NOT 2 — this is not a CONFIG_ERROR; the invocation was
      // well-formed but the audit gate refused to proceed). The envelope
      // carries the full audit result so consumers see the same `write_audit`
      // shape they would on the success path, plus `applied: false` to make
      // the no-mutation guarantee machine-readable.
      if (err instanceof TaskFinalizeAuditStrictError) {
        const summary = buildFailureSummaryFromFinalizeCode(
          "WRITES_AUDIT_STRICT_FAILED",
          err.task_id,
          err.message,
        );
        if (json) {
          emitError(json, "WRITES_AUDIT_STRICT_FAILED", err.message, {
            data: {
              task_id: err.task_id,
              phase_id: err.phase_id,
              applied: err.applied,
              write_audit: err.write_audit,
              failed_checks: summary.failed_checks,
              first_failure: summary.first_failure,
              suggested_next_command: summary.suggested_next_command,
            },
          });
        } else {
          process.stderr.write(`${err.message}\n`);
          const lines = renderFailureSummaryLines(m.task.failure, summary);
          if (lines.length > 0) process.stderr.write(`${lines.join("\n")}\n`);
        }
        return 1;
      }

      const code = (err as NodeJS.ErrnoException).code;

      let msg: string;
      let outCode: string;
      let extraData: Record<string, unknown> | undefined;
      // Set only for the finalize failure codes that map to a clarity summary
      // (NOT_ELIGIBLE / WRITE_REFUSED). TASK_NOT_FOUND / AMBIGUOUS_TASK_ID are
      // resolution errors, not finalize-gate failures, so they get no summary.
      let summary: FailureSummary | null = null;

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
            (err as NodeJS.ErrnoException & { phase_id?: string }).phase_id ??
            "";
          msg = m.task.finalize.notEligible(taskId, current);
          outCode = "TASK_FINALIZE_NOT_ELIGIBLE";
          summary = buildFailureSummaryFromFinalizeCode(
            "TASK_FINALIZE_NOT_ELIGIBLE",
            taskId,
            err.message,
          );
          extraData = {
            task_id: taskId,
            phase_id,
            current,
            failed_checks: summary.failed_checks,
            first_failure: summary.first_failure,
            suggested_next_command: summary.suggested_next_command,
          };
          break;
        }
        case "TASK_FINALIZE_WRITE_REFUSED": {
          const reason =
            (err as NodeJS.ErrnoException & { reason?: string }).reason ?? "";
          const file =
            (err as NodeJS.ErrnoException & { file?: string }).file ?? "";
          msg = m.task.finalize.writeRefused(taskId, err.message);
          outCode = "TASK_FINALIZE_WRITE_REFUSED";
          summary = buildFailureSummaryFromFinalizeCode(
            "TASK_FINALIZE_WRITE_REFUSED",
            taskId,
            err.message,
          );
          extraData = {
            task_id: taskId,
            file,
            reason,
            failed_checks: summary.failed_checks,
            first_failure: summary.first_failure,
            suggested_next_command: summary.suggested_next_command,
          };
          break;
        }
        case "TASK_CONTRACT_DRIFT": {
          const drift =
            (err as NodeJS.ErrnoException & { drift?: { message: string }[] })
              .drift ?? [];
          msg = m.task.finalize.contractDrift(
            taskId,
            drift.map(d => d.message),
          );
          outCode = "TASK_CONTRACT_DRIFT";
          break;
        }
        case "TASK_CONTRACT_LOCK_REQUIRED":
          msg = err.message;
          outCode = "TASK_CONTRACT_LOCK_REQUIRED";
          break;
        case "PHASE_SNAPSHOT_INVALID":
          msg = err.message;
          outCode = "PHASE_SNAPSHOT_INVALID";
          break;
        case "TASK_CANCELLED":
          msg = err.message;
          outCode = "TASK_CANCELLED";
          break;
        // Contained control-plane loader refusal → structured (exit 2), not exit 3.
        case "CONFIG_ERROR":
          msg = err.message;
          outCode = "CONFIG_ERROR";
          break;
        default:
          throw err;
      }
      if (json) {
        emitError(json, outCode, msg, extraData ? { data: extraData } : {});
      } else {
        process.stderr.write(`${msg}\n`);
        if (summary) {
          const lines = renderFailureSummaryLines(m.task.failure, summary);
          if (lines.length > 0) process.stderr.write(`${lines.join("\n")}\n`);
        }
      }
      return 2;
    }
  };

  // Only --write mutates phase YAML; dry-run is lock-free.
  if (write) {
    return withWriteLock(cwd, `task finalize ${taskId} --write`, json, runImpl);
  }
  return runImpl();
}

// ---------------------------------------------------------------------------
// Command: task runbook
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
      toParseOptions(TASK_SPECS.runbook!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    const aliasNote =
      invokedAs === "task runbook" ? "" : " (alias for `task runbook`)";
    const msg = `${invokedAs} requires a task id (e.g. \`${invokedAs} P1-T1\`)${aliasNote}.`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const cwd = process.cwd();

  try {
    const result = await runTaskRunbook({ cwd, taskId });

    if (json) {
      emitOk(result);
    } else {
      process.stdout.write(
        `${m.task.runbook.header(taskId, result.phase_id)}\n`,
      );
      process.stdout.write(
        `${m.task.runbook.stateSummary(result.state_summary)}\n`,
      );
      if (result.state_summary.depends_on.length > 0) {
        process.stdout.write("  depends_on:\n");
        for (const dep of result.state_summary.depends_on) {
          const locator = dep.phase_id ? ` (cross-phase: ${dep.phase_id})` : "";
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
      const phases = (err as NodeJS.ErrnoException & { phases?: string[] })
        .phases;
      if (phases) extraData = { phases };
    } else if (code === "CONFIG_ERROR") {
      outCode = "CONFIG_ERROR";
    } else if (code === "PHASE_SNAPSHOT_INVALID") {
      outCode = "PHASE_SNAPSHOT_INVALID";
    }
    emitError(json, outCode, msg, extraData ? { data: extraData } : {});
    return 2;
  }
}

// design-docs-ephemeral (step 4a): `PHASE_SNAPSHOT_INVALID` can be thrown by the
// SHARED task resolver (`resolveTaskInRoadmap`) and the plan-state loaders, so it can
// surface from ANY task command that resolves a task — not just `task context` /
// `task prepare`. It is a control-plane integrity error, NOT an internal bug, so
// every task command's error switch handles it as a clean envelope (exit 2) rather
// than crashing (exit 3). See each `case "PHASE_SNAPSHOT_INVALID"` below and in
// emitContextLikeError / emitTaskCommonError / cmdTaskComplete / cmdTaskRecordDone /
// cmdTaskFinalize / cmdTaskStatus / cmdTaskRunbook.

// ---------------------------------------------------------------------------
// Command: task cancel
// ---------------------------------------------------------------------------

async function cmdTaskCancel(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParse(
      "task cancel",
      argv,
      toParseOptions(TASK_SPECS.cancel!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const write = values.write === true;
  const taskId = positionals[0];
  if (!taskId) {
    emitError(json, "CONFIG_ERROR", m.task.cancel.missingTaskId);
    return 2;
  }

  const cwd = process.cwd();
  try {
    const result = await runTaskCancel({ cwd, taskId, write });

    if (json) {
      emitOk(result);
      return 0;
    }

    switch (result.kind) {
      case "already_cancelled":
        process.stdout.write(`${m.task.cancel.alreadyCancelled(taskId)}\n`);
        break;
      case "cancel_preview":
        process.stdout.write(
          `${m.task.cancel.wouldCancel(
            taskId,
            result.current_design_status,
          )}\n`,
        );
        break;
      case "cancelled":
        process.stdout.write(`${m.task.cancel.success(taskId)}\n`);
        break;
    }
    return 0;
  } catch (err: unknown) {
    if (!(err instanceof Error)) throw err;
    const code = (err as NodeJS.ErrnoException).code;

    if (code === "TASK_CANCEL_NOT_ALLOWED") {
      emitError(
        json,
        "TASK_CANCEL_NOT_ALLOWED",
        m.task.cancel.notAllowed(taskId),
      );
      return 2;
    }

    if (code === "TASK_CANCEL_DEPENDENTS_EXIST") {
      const deps =
        (
          err as NodeJS.ErrnoException & {
            dependents?: { task_id: string; phase_id?: string }[];
          }
        ).dependents ?? [];
      const depIds = deps.map(d => d.task_id);
      emitError(
        json,
        "TASK_CANCEL_DEPENDENTS_EXIST",
        m.task.cancel.dependentsExist(taskId, depIds),
        {
          data: { dependents: depIds },
        },
      );
      return 2;
    }

    if (code === "TASK_CANCELLED") {
      emitError(json, "TASK_CANCELLED", m.task.cancel.cancelled(taskId));
      return 2;
    }

    if (code === "TASK_CANCEL_WRITE_CONFLICT") {
      emitError(
        json,
        "TASK_CANCEL_WRITE_CONFLICT",
        m.task.cancel.writeConflict(taskId),
      );
      return 2;
    }

    if (code === "TASK_CANCEL_WRITE_FAILURE") {
      const rollbackStatus = (
        err as NodeJS.ErrnoException & { rollback_status?: string }
      ).rollback_status;
      emitError(
        json,
        "TASK_CANCEL_WRITE_FAILURE",
        m.task.cancel.writeFailure(taskId, rollbackStatus ?? "unknown"),
        {
          data: { rollback_status: rollbackStatus ?? "unknown" },
        },
      );
      return 2;
    }

    if (code === "TASK_NOT_FOUND") {
      emitError(json, "TASK_NOT_FOUND", m.task.complete.taskNotFound(taskId));
      return 2;
    }

    if (code === "AMBIGUOUS_TASK_ID") {
      const phases =
        (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
      emitError(
        json,
        "AMBIGUOUS_TASK_ID",
        m.task.complete.ambiguous(taskId, phases),
        {
          data: { phases },
        },
      );
      return 2;
    }

    if (code === "CONFIG_ERROR" || code === "PHASE_SNAPSHOT_INVALID") {
      emitError(json, code, (err as Error).message);
      return 2;
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Command: task start / block / resume / status
// ---------------------------------------------------------------------------

type TaskStateErrorKey = "start" | "block" | "resume";

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
      emitError(json, outCode, msg);
      return 1;
    }
    case "TASK_DEPENDENCY_INCOMPLETE": {
      if (key !== "start") throw err;
      const deps =
        (err as NodeJS.ErrnoException & { deps?: string[] }).deps ?? [];
      msg = m.task.start.dependencyIncomplete(taskId, deps);
      outCode = "TASK_DEPENDENCY_INCOMPLETE";
      emitError(json, outCode, msg, { data: { deps } });
      return 2;
    }
    case "TASK_CONTRACT_DRIFT": {
      const drift =
        (
          err as NodeJS.ErrnoException & {
            drift?: { kind: string; message: string }[];
          }
        ).drift ?? [];
      const changed =
        (err as NodeJS.ErrnoException & { changed_fields?: string[] })
          .changed_fields ?? [];
      msg = m.task.lock.contractDrift(
        taskId,
        drift.map(d => d.message),
      );
      outCode = "TASK_CONTRACT_DRIFT";
      const lockedDigest = (
        err as NodeJS.ErrnoException & { locked_digest?: string }
      ).locked_digest;
      const currentDigest = (
        err as NodeJS.ErrnoException & { current_digest?: string }
      ).current_digest;
      emitError(json, outCode, msg, {
        data: {
          locked_digest: lockedDigest,
          current_digest: currentDigest,
          changed_fields: changed,
          drift,
        },
      });
      return 2;
    }
    case "WORKTREE_NOT_CLEAN":
      msg = err.message;
      outCode = "WORKTREE_NOT_CLEAN";
      emitError(json, outCode, msg);
      return 1;
    case "TASK_CONTRACT_LOCK_EXISTS":
      msg = err.message;
      outCode = "TASK_CONTRACT_LOCK_EXISTS";
      emitError(json, outCode, msg);
      return 1;
    case "TASK_CANCELLED":
      msg = err.message;
      outCode = "TASK_CANCELLED";
      emitError(json, outCode, msg);
      return 2;
    // Control-plane integrity error from the shared resolver / plan-state loaders.
    case "PHASE_SNAPSHOT_INVALID":
      msg = err.message;
      outCode = "PHASE_SNAPSHOT_INVALID";
      break;
    // Path-safety refusal / malformed roadmap or phase from the now-contained
    // loaders (resolveTaskInRoadmap → loadRoadmap → loadPhase): structured (exit
    // 2), not an uncoded internal error (exit 3). Covers task start/block/resume.
    case "CONFIG_ERROR":
      msg = err.message;
      outCode = "CONFIG_ERROR";
      break;
    default:
      return null;
  }
  emitError(json, outCode, msg);
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
      toParseOptions(TASK_SPECS.start!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task start requires a task id (e.g. `task start P1-T1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskStart({ cwd, taskId, agent });
    if (result.kind === "already_started") {
      if (json) {
        emitOk({
          already_started: true,
          task_id: result.task_id,
          phase_id: result.phase_id,
          agent: result.agent,
        });
      } else {
        process.stdout.write(`${m.task.start.alreadyStarted(taskId)}\n`);
      }
      return 0;
    }

    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        agent: result.agent,
        event: result.event,
      });
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
      toParseOptions(TASK_SPECS.block!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg =
      "task block requires a task id (e.g. `task block P1-T1 --reason ...`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const reason = (values.reason as string | undefined) ?? "";
  if (!reason || reason.trim().length === 0) {
    const msg = m.task.block.reasonRequired;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskBlock({ cwd, taskId, reason, agent });
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        agent: result.agent,
        event: result.event,
      });
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
      toParseOptions(TASK_SPECS.resume!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task resume requires a task id (e.g. `task resume P1-T1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const agent = values.agent as string | undefined;
  const cwd = process.cwd();

  try {
    const result = await runTaskResume({ cwd, taskId, agent });
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        agent: result.agent,
        event: result.event,
      });
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
      toParseOptions(TASK_SPECS.status!),
      { allowPositionals: true },
    ));
  } catch (err) {
    return emitParseConfigError(err, argv, globalJson);
  }

  const json = globalJson || values.json === true;
  const taskId = positionals[0];
  if (!taskId) {
    const msg = "task status requires a task id (e.g. `task status P1-T1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const cwd = process.cwd();

  try {
    const result = await runTaskStatus({ cwd, taskId });
    if (json) {
      emitOk({
        task_id: result.task_id,
        phase_id: result.phase_id,
        current: result.current,
        last_event: result.last_event,
        history: result.history,
      });
    } else {
      process.stdout.write(
        `${m.task.status.headline(taskId, result.current)}\n`,
      );
      if (result.history.length === 0) {
        process.stdout.write(`${m.task.status.noEvents(taskId)}\n`);
      } else {
        for (const ev of result.history) {
          const extras: string[] = [];
          // "who" first — author (human) before agent (tool) before reason.
          if (ev.author) extras.push(`author=${ev.author}`);
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
      case "PHASE_SNAPSHOT_INVALID":
        msg = err.message;
        outCode = "PHASE_SNAPSHOT_INVALID";
        break;
      // A path-safety refusal / malformed roadmap or phase from the now-contained
      // control-plane loaders (resolveTaskInRoadmap → loadRoadmap → loadPhase):
      // structured (exit 2), never an uncoded internal error (exit 3).
      case "CONFIG_ERROR":
        msg = err.message;
        outCode = "CONFIG_ERROR";
        break;
      default:
        throw err;
    }
    emitError(json, outCode, msg);
    return 2;
  }
}
