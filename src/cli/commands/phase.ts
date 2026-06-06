// The CLI wrapper layer for the `phase` subcommand cluster. Routes
// `phase <subcommand>` to the per-subcommand handlers defined below.
// JSON envelopes, exit codes, error codes, and flag surfaces are part
// of the stable CLI contract.
//
// `cmdPhase` is the cluster-entry dispatch and is the only export.
// The `reconcile` / `runbook` handlers are private to this module.

import { parseArgs } from "node:util";
import { strictParse, strictParseAlias, ConfigError } from "../../lib/argv.ts";
import { clusterUsage, emitUsage, hasHelpFlag, isHelpToken, subcommandUsage } from "../usage.ts";
import { isInteractive } from "../../lib/tty.ts";
import { messages, type Locale } from "../../i18n/index.ts";
import { withWriteLock, emitOk, emitError } from "../util.ts";
import {
  runPhaseAdd,
  runPhaseLs,
  runPhaseShow,
  formatPhaseLsTable,
  formatPhaseShow,
} from "../../commands/phase.ts";
import { runPhaseImport } from "../../commands/phase-import.ts";
import { runPhaseReconcile } from "../../commands/phase-reconcile.ts";
import {
  runPhaseRunbook,
  runPhaseRunbookAcrossPhases,
} from "../../commands/phase-runbook.ts";
import { runPhaseNew } from "../../commands/phase-new.ts";
import { runPhaseWizard } from "../../lib/phase-wizard.ts";
import type { PhaseStatus } from "../../core/schemas/phase.ts";

export async function cmdPhase(argv: string[], locale: Locale, globalJson: boolean): Promise<number> {
  const m = messages[locale];
  const subcommand = argv[0];
  const rest = argv.slice(1);
  const cwd = process.cwd();

  // `phase`, `phase help`, `phase --help`, `phase -h` → cluster usage (exit 0).
  if (subcommand === undefined || isHelpToken(subcommand)) {
    return emitUsage(clusterUsage("phase"));
  }
  // `phase <sub> --help` → per-subcommand usage (exit 0).
  if (hasHelpFlag(rest)) {
    return emitUsage(subcommandUsage("phase", subcommand));
  }

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
      emitError(json, "CONFIG_ERROR", msg);
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
      const { Prompter } = await import("../../lib/prompt.ts");
      const prompter = Prompter.fromIO();
      let input: Awaited<ReturnType<typeof runPhaseWizard>>;
      try {
        input = await runPhaseWizard(prompter, messages[locale].wizard.phase);
      } catch (err) {
        prompter.close();
        throw err;
      }
      // Wizard prompts complete — acquire the write lock before
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
            // Reserved-id (TUTORIAL) block surfaces as CONFIG_ERROR.
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
      emitError(json, "CONFIG_ERROR", msg);
      return 2;
    }

    const weight = Number(weightRaw);
    if (!Number.isFinite(weight) || weight <= 0) {
      const msg = "--weight must be a positive number";
      emitError(json, "CONFIG_ERROR", msg);
      return 2;
    }

    const confidence = (values.confidence as string | undefined) ?? "medium";
    const risk = (values.risk as string | undefined) ?? "medium";
    const verifyCommands = (values["verify-command"] as string[] | undefined) ?? ["pnpm test"];
    const definitionOfDone = (values["done-criterion"] as string[] | undefined) ?? [
      "All tasks are done",
    ];

    // Advisory write lock: serializes the phase YAML + roadmap
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
          emitOk(result);
        } else {
          process.stderr.write(`${m.phase.added(id, result.path)}\n`);
        }
        return 0;
      } catch (err: unknown) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "DUPLICATE_PHASE_ID") {
          const msg = m.phase.duplicateId(id);
          emitError(json, "DUPLICATE_PHASE_ID", msg);
          return 2;
        }
        // Reserved-id (TUTORIAL) block surfaces as CONFIG_ERROR from
        // createPhase. Propagate the message verbatim — it already names
        // the reserved id and points at `init --sample-phase`.
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
          emitError(json, "CONFIG_ERROR", err.message);
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
      emitError(globalJson, "CONFIG_ERROR", msg);
      return 2;
    }
    const initialName = rest[0]?.startsWith("-") ? undefined : rest[0];
    // Advisory write lock: serialize the wizard's createPhase write.
    // The lock IS held through the wizard prompts.
    return withWriteLock(
      cwd,
      `phase new${initialName ? ` ${initialName}` : ""}`,
      globalJson,
      async (): Promise<number> => {
        try {
          const result = await runPhaseNew({ cwd, locale, initialName });
          if (globalJson) {
            emitOk(result);
          } else {
            process.stderr.write(`${m.phase.added(result.ref.id, result.path)}\n`);
          }
          return 0;
        } catch (err: unknown) {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "DUPLICATE_PHASE_ID") {
            const id =
              err.message.match(/"([^"]+)"/)?.[1] ?? "";
            const msg = m.phase.duplicateId(id);
            emitError(globalJson, "DUPLICATE_PHASE_ID", msg);
            return 2;
          }
          // Reserved-id (TUTORIAL) block surfaces as CONFIG_ERROR from
          // createPhase (the wizard never asks for the bypass flag).
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === "CONFIG_ERROR") {
            emitError(globalJson, "CONFIG_ERROR", err.message);
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
      emitError(json, "CONFIG_ERROR", err.message);
      return 2;
    }

    const json = globalJson || values.json === true;
    const statusFilter = values.status as PhaseStatus | undefined;

    try {
      const items = await runPhaseLs({ cwd, status: statusFilter });
      if (json) {
        emitOk(items);
      } else {
        process.stdout.write(`${formatPhaseLsTable(items)}\n`);
      }
      return 0;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      emitError(json, "INTERNAL_ERROR", msg);
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
      emitError(json, "CONFIG_ERROR", msg);
      return 2;
    }

    try {
      const phase = await runPhaseShow({ cwd, id });
      if (json) {
        emitOk(phase);
      } else {
        process.stdout.write(`${formatPhaseShow(phase)}\n`);
      }
      return 0;
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "PHASE_NOT_FOUND") {
        const msg = m.phase.notFound(id);
        emitError(json, "PHASE_NOT_FOUND", msg);
        return 2;
      }
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === "AMBIGUOUS_PHASE_ID") {
        const phases =
          (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [];
        emitError(json, "AMBIGUOUS_PHASE_ID", err.message, { data: { phases } });
        return 2;
      }
      throw err;
    }
  }

  // ---- phase reconcile / runbook ----
  if (subcommand === "reconcile") {
    return cmdPhaseReconcile(rest, locale, globalJson);
  }

  // `next` is a beginner-friendly alias for `runbook` ("what should I do next?").
  if (subcommand === "runbook" || subcommand === "next") {
    return cmdPhaseRunbook(rest, locale, globalJson, `phase ${subcommand}`);
  }

  // ---- phase import ---- (also reachable as the `plan import` alias)
  if (subcommand === "import") {
    return cmdPhaseImport(rest, locale, globalJson);
  }

  const msg = `phase: unknown subcommand "${subcommand ?? ""}". Use: add | new | ls | show | import | reconcile | runbook (alias: next = runbook)`;
  emitError(globalJson, "CONFIG_ERROR", msg);
  return 2;
}

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
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const write = values.write === true;
  const phaseId = positionals[0];
  if (!phaseId) {
    const msg =
      "phase reconcile requires a phase id (e.g. `phase reconcile P1`).";
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }
  const cwd = process.cwd();

  const runImpl = async (): Promise<number> => {
  try {
    const result = await runPhaseReconcile({ cwd, phaseId, write });

    if (result.kind === "no_eligible_tasks") {
      if (json) {
        emitOk({
          kind: "no_eligible_tasks",
          phase_id: result.phase_id,
          file: result.file,
          tasks: result.tasks,
          phase_status_candidate: result.phase_status_candidate,
          phase_status_note: result.phase_status_note,
        });
      } else {
        process.stdout.write(
          `${m.phase.reconcile.noEligible(phaseId)}\n`,
        );
      }
      return 0;
    }

    if (result.kind === "would_reconcile") {
      if (json) {
        emitOk({
          kind: "would_reconcile",
          phase_id: result.phase_id,
          file: result.file,
          tasks: result.tasks,
          planned_writes: result.planned_writes,
          phase_status_candidate: result.phase_status_candidate,
          phase_status_note: result.phase_status_note,
        });
      } else {
        process.stdout.write(
          `${m.phase.reconcile.wouldReconcile(phaseId, result.planned_writes.length)}\n`,
        );
      }
      return 0;
    }

    // result.kind === "reconciled"
    if (json) {
      emitOk({
        kind: "reconciled",
        phase_id: result.phase_id,
        file: result.file,
        tasks: result.tasks,
        applied_writes: result.applied_writes,
        skipped_writes: result.skipped_writes,
        phase_status_candidate: result.phase_status_candidate,
        phase_status_note: result.phase_status_note,
      });
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
      case "AMBIGUOUS_PHASE_ID":
        msg = (err as Error).message;
        outCode = "AMBIGUOUS_PHASE_ID";
        extraData = {
          phases:
            (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [],
        };
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
    emitError(json, outCode, msg, extraData ? { data: extraData } : {});
    return 2;
  }
  };

  // Only --write mutates phase YAML; dry-run is lock-free.
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

// Shared by `phase import` and the `plan import` alias. `invokedAs` labels the
// user-facing CONFIG_ERROR messages so an alias names itself; the write-lock
// identity stays canonical.
export async function cmdPhaseImport(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
  invokedAs: string = "phase import",
): Promise<number> {
  const m = messages[locale];
  const cwd = process.cwd();

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParseAlias(
      invokedAs,
      "phase import",
      argv,
      {
        force: { type: "boolean" },
        strict: { type: "boolean" },
        "scaffold-decisions": { type: "boolean" },
        json: { type: "boolean" },
      },
      { allowPositionals: true },
    ));
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const json = globalJson || argv.includes("--json");
    emitError(json, "CONFIG_ERROR", err.message);
    return 2;
  }

  const json = globalJson || values.json === true;
  const force = values.force === true;
  const strict = values.strict === true;
  const scaffoldDecisions = values["scaffold-decisions"] === true;
  const inputPath = positionals[0];
  if (!inputPath) {
    const aliasNote = invokedAs === "phase import" ? "" : " (alias for `phase import`)";
    const msg = `${invokedAs} requires an input YAML path, e.g. \`${invokedAs} design/roadmap-draft.yaml\`${aliasNote}`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  // Advisory write lock: a single acquisition covers runPhaseImport's
  // multi-phase apply loop (every inner createPhase runs under the same lock).
  return withWriteLock(cwd, "phase import", json, async (): Promise<number> => {
    try {
      const result = await runPhaseImport({ cwd, inputPath, force, strict, scaffoldDecisions });
      if (json) {
        emitOk(result);
      } else {
        process.stderr.write(`${m.phase.importDone(result.imported_phases.length, result.imported_tasks.length, result.skipped_phases.length)}\n`);
        for (const cf of result.completed_fields) {
          process.stderr.write(`  completed defaults for ${cf.taskId}: ${cf.fields.join(", ")}\n`);
        }
        for (const w of result.warnings) {
          process.stderr.write(`  warning [${w.code}]${w.phase_id ? ` ${w.phase_id}` : ""}: ${w.message}\n`);
        }
        for (const p of result.scaffolded_decisions) {
          process.stderr.write(`  scaffolded decision (proposed): ${p}\n`);
        }
        for (const s of result.scaffold_skipped) {
          process.stderr.write(`  scaffold skipped [${s.reason}]: ${s.ref}\n`);
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
        emitError(json, code, message);
        return 2;
      }
      throw err;
    }
  });
}

async function cmdPhaseRunbook(
  argv: string[],
  locale: Locale,
  globalJson: boolean,
  invokedAs: string = "phase runbook",
): Promise<number> {
  const m = messages[locale];

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = strictParseAlias(
      invokedAs,
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
    emitError(json, "CONFIG_ERROR", err.message);
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
        emitOk(result);
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
      let outCode = "INTERNAL_ERROR";
      if (code === "CONFIG_ERROR") {
        outCode = "CONFIG_ERROR";
      } else if (code === "AMBIGUOUS_PHASE_ID") {
        outCode = "AMBIGUOUS_PHASE_ID";
      }
      emitError(
        json,
        outCode,
        msg,
        code === "AMBIGUOUS_PHASE_ID"
          ? {
              data: {
                phases:
                  (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [],
              },
            }
          : {},
      );
      return 2;
    }
  }

  if (!phaseId) {
    const aliasNote = invokedAs === "phase runbook" ? "" : " (alias for `phase runbook`)";
    const msg = `${invokedAs} requires a phase id (e.g. \`${invokedAs} P1\`) or \`--across-phases\`${aliasNote}.`;
    emitError(json, "CONFIG_ERROR", msg);
    return 2;
  }

  try {
    const result = await runPhaseRunbook({ cwd, phaseId });

    if (json) {
      emitOk(result);
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
    } else if (code === "AMBIGUOUS_PHASE_ID") {
      outCode = "AMBIGUOUS_PHASE_ID";
    } else if (code === "CONFIG_ERROR") {
      outCode = "CONFIG_ERROR";
    }
    emitError(
      json,
      outCode,
      msg,
      code === "AMBIGUOUS_PHASE_ID"
        ? {
            data: {
              phases:
                (err as NodeJS.ErrnoException & { phases?: string[] }).phases ?? [],
            },
          }
        : {},
    );
    return 2;
  }
}
