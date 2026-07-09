// The single source for the phase cluster's CLI flag/help/reference surface.
//
// Scope: flag/usage/example reference only. Stable JSON envelopes, exit codes,
// filesystem guarantees, and lifecycle semantics remain in docs/cli-contract.md.

import type { CommandSpec } from "./types.ts";

const add: CommandSpec = {
  cluster: "phase",
  command: "add",
  summary: [
    "Append a phase to design/roadmap.yaml and create its phase YAML. Mutating.",
    "Two paths: with no flags on a TTY it runs an interactive wizard; with the",
    "required flags (or --non-interactive) it is flag-driven. For bulk creation",
    "from a draft, use `phase import` instead.",
  ].join("\n"),
  flags: [
    { name: "id", value: "<phase-id>", required: true, description: "Phase id (e.g. P5). Required in non-interactive mode." },
    { name: "name", value: "<text>", required: true, description: "Phase name. Required in non-interactive mode." },
    { name: "weight", value: "<n>", required: true, description: "Phase weight. Required in non-interactive mode." },
    { name: "objective", value: "<text>", required: true, description: "Phase objective. Required in non-interactive mode." },
    { name: "confidence", value: "<level>", description: "Optional readiness field." },
    { name: "risk", value: "<level>", description: "Optional readiness field." },
    { name: "verify-command", value: "<cmd>", repeatable: true, description: "Phase verify command." },
    { name: "done-criterion", value: "<text>", repeatable: true, description: "Phase done criterion." },
    { name: "json", description: "Emit JSON." },
    { name: "non-interactive", description: "Force the flag-driven path (no wizard)." },
  ],
  examples: [
    "code-pact phase add                              # interactive wizard (TTY)",
    'code-pact phase add --id P5 --name "..." --weight 3 --objective "..." --json',
  ],
};

const phaseNew: CommandSpec = {
  cluster: "phase",
  command: "new",
  positional: "[<name>]",
  summary: [
    "Interactive wizard to create a phase. TTY-only — in a non-TTY context it",
    "errors and directs you to `phase add` with flags. Mutating (creates the",
    "phase YAML and registers it in the roadmap). Takes no flags; the wizard",
    "prompts for every field. For non-interactive / scripted creation use",
    "`phase add`.",
  ].join("\n"),
  flags: [],
  examples: [
    "code-pact phase new",
    'code-pact phase new "Authentication"',
  ],
};

const ls: CommandSpec = {
  cluster: "phase",
  command: "ls",
  summary: "List phases from the roadmap, optionally filtered by phase status.",
  readOnly: true,
  flags: [
    { name: "status", value: "<status>", description: "Filter by phase status." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact phase ls --json",
    "code-pact phase ls --status in_progress",
  ],
};

const show: CommandSpec = {
  cluster: "phase",
  command: "show",
  positional: "<phase-id>",
  summary: "Show one phase resolved from the roadmap.",
  readOnly: true,
  flags: [{ name: "json", description: "Emit JSON." }],
  examples: [
    "code-pact phase show P1 --json",
  ],
};

const phaseImport: CommandSpec = {
  cluster: "phase",
  command: "import",
  positional: "<file>",
  summary: [
    "Import phases and tasks from a YAML draft into the roadmap. Lenient by",
    "default (applies schema defaults to AI-generated YAML); --strict rejects",
    "any input that needs defaulting. Reserved ids (e.g. TUTORIAL) and id",
    "collisions are rejected with the whole input left unwritten.",
    "",
    "Alias: `code-pact plan import` routes here.",
  ].join("\n"),
  flags: [
    { name: "force", description: "Skip phases whose ids already exist in the roadmap (the rest still import). Task-id collisions are never bypassed." },
    { name: "scaffold-decisions", description: "Scaffold a `proposed` ADR stub for every requires_decision task that lacks one." },
    { name: "strict", description: "Reject input that relies on schema defaults." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact phase import design/roadmap-draft.yaml --json",
    "code-pact phase import design/roadmap-draft.yaml --scaffold-decisions --json",
  ],
};

const reconcile: CommandSpec = {
  cluster: "phase",
  command: "reconcile",
  positional: "<phase-id>",
  summary: [
    "Bulk-flip every task in the phase whose derived state is `done` but whose",
    "design status is still open. Dry-run is the default — pass --write to apply.",
    "Mutating only with --write. Never mutates the progress ledger; advisory-only",
    "on the phase's own status. Alias: `phase next` routes to `phase runbook`, not",
    "this command.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Apply the status flips (default is a dry-run preview)." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact phase reconcile P9 --json",
    "code-pact phase reconcile P9 --write --json",
  ],
};

const archive: CommandSpec = {
  cluster: "phase",
  command: "archive",
  positional: "<phase-id>",
  summary: [
    "Archive a terminal phase (status done/cancelled, all tasks terminal): write",
    "its phase-snapshot record, then delete `design/phases/<id>.yaml`. The",
    "archived phase still resolves from the snapshot (the roadmap ref is kept).",
    "Dry-run is the default — pass --write to apply. Mutating only with --write.",
    "Never edits the roadmap, rewrites a link, or appends a ledger.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Write the snapshot then delete the YAML (default is a dry-run preview)." },
    { name: "attest", value: "<task-id>=<reason>", repeatable: true, description: "Attest a legacy done-task that has no done event." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact phase archive P9 --json",
    "code-pact phase archive P9 --write --json",
    'code-pact phase archive P9 --write --attest P9-T2="verified by hand" --json',
  ],
};

const runbook: CommandSpec = {
  cluster: "phase",
  command: "runbook",
  positional: "<phase-id>",
  summary: [
    "Print the ordered next-steps for a phase from its derived task state.",
    "With --across-phases, aggregate runbooks for in-progress phases",
    "and their dependency-linked phases. Alias: `phase next`.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "across-phases", description: "Aggregate runbooks across in-progress phases; no phase id is required in this mode." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact phase runbook P9 --json",
    "code-pact phase runbook --across-phases --json",
  ],
};

export const PHASE_SPECS = {
  add,
  new: phaseNew,
  ls,
  show,
  import: phaseImport,
  reconcile,
  archive,
  runbook,
} satisfies Record<string, CommandSpec>;

export const PHASE_SPEC_ORDER = [
  "add",
  "new",
  "ls",
  "show",
  "import",
  "reconcile",
  "archive",
  "runbook",
] as const;
