// Lightweight usage/help for the subcommand clusters. Before this, a bare
// `code-pact plan` or `code-pact plan lint --help` hit strictParse and came
// back as CONFIG_ERROR — hostile to both humans and agents probing the CLI.
// These helpers let each cluster emit usage (exit 0) instead.

import { renderLeafHelp } from "./spec/render.ts";
import { TASK_SPECS } from "./spec/task.ts";

/** The subcommand list shown for each cluster, mirroring the unknown-subcommand hints. */
const CLUSTER_SUBCOMMANDS: Record<string, string> = {
  plan: "brief | prompt | adopt | constitution | lint | normalize | analyze | migrate | import (alias for \"phase import\")",
  task: "add | context | prepare | start | status | block | resume | complete | record-done | finalize | runbook (aliases: reconcile = finalize, next = runbook)",
  phase: "add | new | ls | show | import | reconcile | runbook (alias: next = runbook)",
  adapter: "list | install | upgrade | doctor | conformance",
};

/** True for the tokens that request help: `help`, `--help`, `-h`. */
export function isHelpToken(token: string | undefined): boolean {
  return token === "help" || token === "--help" || token === "-h";
}

/** True when `--help`/`-h` appears anywhere in a subcommand's argument list. */
export function hasHelpFlag(args: string[]): boolean {
  return args.some((a) => a === "--help" || a === "-h");
}

/** Cluster-level usage: the list of subcommands. */
export function clusterUsage(cluster: string): string {
  const subs = CLUSTER_SUBCOMMANDS[cluster] ?? "";
  return [
    `Usage: code-pact ${cluster} <subcommand> [options]`,
    `Subcommands: ${subs}`,
    `Run "code-pact ${cluster} <subcommand> --help" for a specific subcommand.`,
  ].join("\n");
}

/** Generic per-subcommand stub. Used when no rich leaf help is registered. */
function subcommandStub(cluster: string, subcommand: string): string {
  return [
    `Usage: code-pact ${cluster} ${subcommand} [options]`,
    `Run "code-pact ${cluster} --help" for the full subcommand list.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rich leaf help
//
// Agents probe the CLI by reading `--help`. A bare two-line stub is enough to
// say "this exists", but the lifecycle verbs agents actually drive are worth a
// full synopsis with flags and examples. Each entry below is keyed by
// `"<cluster> <subcommand>"`; commands without an entry fall back to the stub.
// Flag lists mirror the strictParse surface of the corresponding command.
// ---------------------------------------------------------------------------

const LEAF_USAGE: Record<string, () => string> = {
  // P46 step 1 — prepare / complete / finalize derive from CommandSpec
  // (src/cli/spec/task.ts) so parse + help + reference share one source.
  "task prepare": () => renderLeafHelp(TASK_SPECS.prepare!),

  "task complete": () => renderLeafHelp(TASK_SPECS.complete!),

  "task record-done": () => renderLeafHelp(TASK_SPECS["record-done"]!),

  "task finalize": () => renderLeafHelp(TASK_SPECS.finalize!),

  "plan prompt": () =>
    [
      "Usage: code-pact plan prompt [options]",
      "",
      "Emit a planning prompt that asks an agent to produce a code-pact roadmap",
      "YAML. By default it embeds design/brief.md and design/constitution.md; in",
      "--schema-only mode it emits just the YAML format example and output rules",
      "for agents that already hold the project context.",
      "",
      "Options:",
      "  --schema-only    Emit only the format example + output rules (no brief/constitution).",
      "  --clipboard      Copy the prompt to the system clipboard.",
      "  --json           Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan prompt --schema-only",
      "  code-pact plan prompt --clipboard",
    ].join("\n"),

  "plan brief": () =>
    [
      "Usage: code-pact plan brief [options]",
      "",
      "Write design/brief.md from a structured brief. Mutating — creates the file",
      "(use --force to overwrite an existing brief). Three mutually-exclusive input",
      "modes: --from-file <path>, --stdin, or the inline --what/--who/--differentiator",
      "trio.",
      "",
      "Options:",
      "  --from-file <path>      Read the brief YAML from a file.",
      "  --stdin                 Read the brief YAML from stdin.",
      "  --what <text>           Inline mode: what the project is.",
      "  --who <text>            Inline mode: who it is for.",
      "  --differentiator <text> Inline mode: what makes it different.",
      "  --force                 Overwrite an existing design/brief.md.",
      "  --json                  Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan brief --from-file brief.yaml --json",
      "  code-pact plan brief --what \"...\" --who \"...\" --differentiator \"...\" --json",
    ].join("\n"),

  "plan constitution": () =>
    [
      "Usage: code-pact plan constitution [options]",
      "",
      "Write design/constitution.md from a description + principles. Mutating —",
      "creates the file (use --force to overwrite). Three mutually-exclusive input",
      "modes: --from-file <path>, --stdin, or inline --description plus repeatable",
      "--principle.",
      "",
      "Options:",
      "  --from-file <path>    Read the constitution YAML from a file.",
      "  --stdin               Read the constitution YAML from stdin.",
      "  --description <text>  Inline mode: the constitution's framing description.",
      "  --principle <text>    Inline mode: one principle. Repeatable.",
      "  --force               Overwrite an existing design/constitution.md.",
      "  --json                Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan constitution --from-file constitution.yaml --json",
      "  code-pact plan constitution --description \"...\" --principle \"...\" --principle \"...\" --json",
    ].join("\n"),

  "plan adopt": () =>
    [
      "Usage: code-pact plan adopt <file> [options]",
      "",
      "Adopt an existing roadmap/spec draft into the code-pact control plane.",
      "Dry-run is the default — pass --write to apply. Mutating only with --write.",
      "",
      "Options:",
      "  --write                Apply the adoption (default is a dry-run preview).",
      "  --scaffold-decisions   Scaffold a `proposed` ADR stub for each requires_decision task.",
      "  --json                 Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan adopt design/roadmap-draft.yaml --json",
      "  code-pact plan adopt design/roadmap-draft.yaml --write --json",
    ].join("\n"),

  "plan normalize": () =>
    [
      "Usage: code-pact plan normalize [options]",
      "",
      "Rewrite roadmap/phase YAML into canonical form (stable key order, defaults",
      "applied). Without --write it runs in check mode (reports what would change,",
      "writes nothing, exits non-zero if anything is not already normalized); pass",
      "--write to apply. Mutating only with --write. --check and --write are",
      "mutually exclusive.",
      "",
      "Options:",
      "  --write    Apply the normalization.",
      "  --check    Check mode (the default): report drift, write nothing.",
      "  --json     Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan normalize --json          # check mode (default)",
      "  code-pact plan normalize --write --json  # apply",
    ].join("\n"),

  "plan migrate": () =>
    [
      "Usage: code-pact plan migrate [options]",
      "",
      "Convert a legacy monolithic .code-pact/state/progress.yaml into the",
      "per-event ledger (one file per event under .code-pact/state/events/).",
      "Idempotent and dry-run by default; progress.yaml is left in place (readers",
      "merge it). Reports any task whose derived state changes under the merged",
      "(at, id) ordering, so review those before committing.",
      "",
      "Options:",
      "  --write    Write the event files (default: dry run).",
      "  --json     Emit JSON.",
      "",
      "Examples:",
      "  code-pact plan migrate --json          # dry run",
      "  code-pact plan migrate --write --json  # migrate",
    ].join("\n"),

  "phase import": () =>
    [
      "Usage: code-pact phase import <file> [options]",
      "",
      "Import phases and tasks from a YAML draft into the roadmap. Lenient by",
      "default (applies schema defaults to AI-generated YAML); --strict rejects",
      "any input that needs defaulting. Reserved ids (e.g. TUTORIAL) and id",
      "collisions are rejected with the whole input left unwritten.",
      "",
      "Alias: `code-pact plan import` routes here.",
      "",
      "Options:",
      "  --force                Skip phases whose ids already exist in the roadmap",
      "                         (the rest still import). Task-id collisions are",
      "                         never bypassed.",
      "  --scaffold-decisions   Scaffold a `proposed` ADR stub for every",
      "                         requires_decision task that lacks one (RFC §3-D).",
      "  --strict               Reject input that relies on schema defaults.",
      "  --json                 Emit JSON.",
      "",
      "Examples:",
      "  code-pact phase import design/roadmap-draft.yaml --json",
      "  code-pact phase import design/roadmap-draft.yaml --scaffold-decisions --json",
    ].join("\n"),

  "phase add": () =>
    [
      "Usage: code-pact phase add [options]",
      "",
      "Append a phase to design/roadmap.yaml and create its phase YAML. Mutating.",
      "Two paths: with no flags on a TTY it runs an interactive wizard; with the",
      "required flags (or --non-interactive) it is flag-driven. For bulk creation",
      "from a draft, use `phase import` instead.",
      "",
      "Options:",
      "  --id <phase-id>          Phase id (e.g. P5). Required in non-interactive mode.",
      "  --name <text>            Phase name. Required in non-interactive mode.",
      "  --weight <n>             Phase weight. Required in non-interactive mode.",
      "  --objective <text>       Phase objective. Required in non-interactive mode.",
      "  --confidence <level>     Optional readiness field.",
      "  --risk <level>           Optional readiness field.",
      "  --verify-command <cmd>   Phase verify command. Repeatable.",
      "  --done-criterion <text>  Phase done criterion. Repeatable.",
      "  --non-interactive        Force the flag-driven path (no wizard).",
      "  --json                   Emit JSON.",
      "",
      "Examples:",
      "  code-pact phase add                              # interactive wizard (TTY)",
      "  code-pact phase add --id P5 --name \"...\" --weight 3 --objective \"...\" --json",
    ].join("\n"),

  "phase new": () =>
    [
      "Usage: code-pact phase new [<name>]",
      "",
      "Interactive wizard to create a phase. TTY-only — in a non-TTY context it",
      "errors and directs you to `phase add` with flags. Mutating (creates the",
      "phase YAML and registers it in the roadmap). Takes no flags (not even",
      "--json); the wizard prompts for every field. For non-interactive / scripted",
      "creation use `phase add`.",
      "",
      "Arguments:",
      "  <name>    Optional. Pre-fills the phase name; the wizard prompts for the rest.",
      "",
      "Examples:",
      "  code-pact phase new",
      "  code-pact phase new \"Authentication\"",
    ].join("\n"),

  "phase reconcile": () =>
    [
      "Usage: code-pact phase reconcile <phase-id> [options]",
      "",
      "Bulk-flip every task in the phase whose derived state is `done` but whose",
      "design status is still open. Dry-run is the default — pass --write to apply.",
      "Mutating only with --write. Never mutates the progress ledger; advisory-only on the",
      "phase's own status. Alias: `phase next` → `phase runbook` (not this command).",
      "",
      "Options:",
      "  --write    Apply the status flips (default is a dry-run preview).",
      "  --json     Emit JSON.",
      "",
      "Examples:",
      "  code-pact phase reconcile P9 --json",
      "  code-pact phase reconcile P9 --write --json",
    ].join("\n"),

  "task add": () => renderLeafHelp(TASK_SPECS.add!),

  "task context": () => renderLeafHelp(TASK_SPECS.context!),

  "task start": () => renderLeafHelp(TASK_SPECS.start!),

  "task status": () => renderLeafHelp(TASK_SPECS.status!),

  "task block": () => renderLeafHelp(TASK_SPECS.block!),

  "task resume": () => renderLeafHelp(TASK_SPECS.resume!),

  "task runbook": () => renderLeafHelp(TASK_SPECS.runbook!),

  "adapter install": () =>
    [
      "Usage: code-pact adapter install <agent> [options]",
      "",
      "Install an agent adapter — writes its instruction files and skills, and",
      "enables the agent in project config. Mutating. Use --force to overwrite",
      "existing managed files.",
      "",
      "Options:",
      "  --model <version>   Pin the agent's model_version at install time.",
      "  --regen-skills      Regenerate the agent's skill files.",
      "  --force             Overwrite existing managed adapter files.",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact adapter install claude-code --json",
      "  code-pact adapter install claude-code --model claude-opus-4-8 --json",
    ].join("\n"),

  "adapter upgrade": () =>
    [
      "Usage: code-pact adapter upgrade <agent> (--check | --write) [options]",
      "",
      "Re-sync an installed adapter's managed files to the current manifest.",
      "Exactly one of --check or --write is required (they are mutually exclusive):",
      "--check reports drift and exits non-zero if any, writing nothing; --write",
      "applies the upgrade. Mutating only with --write.",
      "",
      "Options:",
      "  --check             Report drift and exit non-zero if any (no writes).",
      "  --write             Apply the upgrade.",
      "  --accept-modified   Preserve manually-edited managed files during the upgrade.",
      "  --regen-skills      Regenerate the agent's skill files.",
      "  --model <version>   Update the agent's model_version (requires --write).",
      "  --force             Force the upgrade past conflict guards.",
      "  --json              Emit JSON.",
      "",
      "Examples:",
      "  code-pact adapter upgrade claude-code --check --json",
      "  code-pact adapter upgrade claude-code --write --json",
      "  code-pact adapter upgrade claude-code --accept-modified --write --json",
    ].join("\n"),
};

/**
 * Every rendered rich leaf-help string. Introspection helper: lets a guard
 * test scan all examples (e.g. assert every `--model <value>` example actually
 * validates) without reaching into the private LEAF_USAGE registry.
 */
export function allLeafUsages(): string[] {
  return Object.values(LEAF_USAGE).map((render) => render());
}

/**
 * Per-subcommand usage. Returns the rich leaf help when one is registered for
 * `"<cluster> <subcommand>"`, otherwise the generic two-line stub. Synopsis is
 * intentionally light for unregistered commands; points back to cluster help.
 */
export function subcommandUsage(cluster: string, subcommand: string): string {
  const rich = LEAF_USAGE[`${cluster} ${subcommand}`];
  return rich ? rich() : subcommandStub(cluster, subcommand);
}

/** Writes usage to stdout and returns exit code 0. Mirrors top-level `--help`. */
export function emitUsage(text: string): number {
  process.stdout.write(`${text}\n`);
  return 0;
}
