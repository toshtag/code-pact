// The single source for the plan cluster's CLI surface.
//
// Scope: flag/usage/example reference only. The semantic contract for JSON
// envelopes, exit codes, diagnostics, mode constraints, and write behavior
// remains in docs/cli-contract.md.

import type { CommandSpec } from "./types.ts";

const brief: CommandSpec = {
  cluster: "plan",
  command: "brief",
  summary: [
    "Write design/brief.md from a structured brief. Mutating — creates the file",
    "(use --force to overwrite an existing brief). Three mutually-exclusive input",
    "modes: --from-file <path>, --stdin, or the inline --what/--who/--differentiator",
    "trio.",
  ].join("\n"),
  flags: [
    { name: "from-file", value: "<path>", description: "Read the brief YAML from a file." },
    { name: "stdin", description: "Read the brief YAML from stdin." },
    { name: "what", value: "<text>", description: "Inline mode: what the project is." },
    { name: "who", value: "<text>", description: "Inline mode: who it is for." },
    { name: "differentiator", value: "<text>", description: "Inline mode: what makes it different." },
    { name: "force", description: "Overwrite an existing design/brief.md." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan brief --from-file brief.yaml --json",
    'code-pact plan brief --what "..." --who "..." --differentiator "..." --json',
  ],
};

const prompt: CommandSpec = {
  cluster: "plan",
  command: "prompt",
  summary: [
    "Emit a planning prompt that asks an agent to produce a code-pact roadmap",
    "YAML. By default it embeds design/brief.md and design/constitution.md; in",
    "--schema-only mode it emits just the YAML format example and output rules",
    "for agents that already hold the project context.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "schema-only", description: "Emit only the format example + output rules (no brief/constitution)." },
    { name: "clipboard", description: "Copy the prompt to the system clipboard." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan prompt --schema-only",
    "code-pact plan prompt --clipboard",
  ],
};

const adopt: CommandSpec = {
  cluster: "plan",
  command: "adopt",
  positional: "<file>",
  summary: [
    "Adopt an existing roadmap/spec draft into the code-pact control plane.",
    "Dry-run is the default — pass --write to apply. Mutating only with --write.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Apply the adoption (default is a dry-run preview)." },
    { name: "scaffold-decisions", description: "Scaffold a `proposed` ADR stub for each requires_decision task." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan adopt design/roadmap-draft.yaml --json",
    "code-pact plan adopt design/roadmap-draft.yaml --write --json",
  ],
};

const constitution: CommandSpec = {
  cluster: "plan",
  command: "constitution",
  summary: [
    "Write design/constitution.md from a description + principles. Mutating —",
    "creates the file (use --force to overwrite). Three mutually-exclusive input",
    "modes: --from-file <path>, --stdin, or inline --description plus repeatable",
    "--principle.",
  ].join("\n"),
  flags: [
    { name: "from-file", value: "<path>", description: "Read the constitution YAML from a file." },
    { name: "stdin", description: "Read the constitution YAML from stdin." },
    { name: "description", value: "<text>", description: "Inline mode: the constitution's framing description." },
    { name: "principle", value: "<text>", repeatable: true, description: "Inline mode: one principle." },
    { name: "force", description: "Overwrite an existing design/constitution.md." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan constitution --from-file constitution.yaml --json",
    'code-pact plan constitution --description "..." --principle "..." --principle "..." --json',
  ],
};

const lint: CommandSpec = {
  cluster: "plan",
  command: "lint",
  summary: [
    "Read-only static integrity check over design/roadmap.yaml and every",
    "referenced phase file. Use --strict to promote exit-relevant warnings and",
    "--include-quality to opt into readiness/quality advisories.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "strict", description: "Promote exit-relevant warnings to failures." },
    { name: "include-quality", description: "Include opt-in quality/readiness advisories." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan lint --json",
    "code-pact plan lint --include-quality --strict --json",
  ],
};

const normalize: CommandSpec = {
  cluster: "plan",
  command: "normalize",
  summary: [
    "Rewrite roadmap/phase YAML into canonical form (stable key order, defaults",
    "applied). Without --write it runs in check mode (reports what would change,",
    "writes nothing, exits non-zero if anything is not already normalized); pass",
    "--write to apply. Mutating only with --write. --check and --write are",
    "mutually exclusive.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Apply the normalization." },
    { name: "check", description: "Check mode (the default): report drift, write nothing." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan normalize --json          # check mode (default)",
    "code-pact plan normalize --write --json  # apply",
  ],
};

const analyze: CommandSpec = {
  cluster: "plan",
  command: "analyze",
  summary: [
    "Read-only cross-artifact integrity check. Compares design task/phase status",
    "against derived progress state and reports drift. Use --strict to promote",
    "exit-relevant warnings and --include-historical to show hidden historical",
    "done-without-event drift.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "strict", description: "Promote exit-relevant warnings to failures." },
    { name: "include-historical", description: "Render historical issues that are hidden by default." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan analyze --json",
    "code-pact plan analyze --include-historical --strict --json",
  ],
};

const syncPaths: CommandSpec = {
  cluster: "plan",
  command: "sync-paths",
  summary: [
    "Apply explicit old=new path renames to the reads/writes of every phase task,",
    "so renaming or merging a referenced source file does not leave plan lint's",
    "reads-match invariant to be fixed by hand. Dry-run by default; pass --write",
    "to apply under the write lock. Repeat --rename for multiple renames.",
  ].join("\n"),
  flags: [
    { name: "rename", value: "<old>=<new>", repeatable: true, required: true, description: "Map an exact reads/writes entry to a new path." },
    { name: "write", description: "Apply the changes (default is a non-destructive preview)." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan sync-paths --rename src/a.ts=src/b.ts --json          # preview",
    "code-pact plan sync-paths --rename src/a.ts=src/b.ts --write --json  # apply",
  ],
};

const migrate: CommandSpec = {
  cluster: "plan",
  command: "migrate",
  summary: [
    "Convert a legacy monolithic .code-pact/state/progress.yaml into the",
    "per-event ledger (one file per event under .code-pact/state/events/).",
    "Idempotent and dry-run by default; progress.yaml is left in place.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Write the event files (default: dry run)." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact plan migrate --json          # dry run",
    "code-pact plan migrate --write --json  # migrate",
  ],
};

/** plan-cluster specs, keyed by subcommand. */
export const PLAN_SPECS = {
  brief,
  prompt,
  adopt,
  constitution,
  lint,
  normalize,
  analyze,
  "sync-paths": syncPaths,
  migrate,
} satisfies Record<string, CommandSpec>;

export const PLAN_SPEC_ORDER = [
  "brief",
  "prompt",
  "adopt",
  "constitution",
  "lint",
  "normalize",
  "analyze",
  "sync-paths",
  "migrate",
] as const;
