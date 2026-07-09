// The single source for the adapter cluster's CLI flag/help/reference surface.
//
// Scope: flag/usage/example reference only. Stable JSON envelopes, exit codes,
// filesystem guarantees, and adapter safety semantics remain in docs/cli-contract.md.

import type { CommandSpec } from "./types.ts";

const list: CommandSpec = {
  cluster: "adapter",
  command: "list",
  summary: [
    "List registered adapters with enabled/experimental state and manifest",
    "presence. Useful before install or upgrade work.",
  ].join("\n"),
  readOnly: true,
  flags: [{ name: "json", description: "Emit JSON." }],
  examples: [
    "code-pact adapter list",
    "code-pact adapter list --json",
  ],
};

const install: CommandSpec = {
  cluster: "adapter",
  command: "install",
  positional: "<agent>",
  summary: [
    "Install an agent adapter: writes its instruction files, skills, agent",
    "profile updates, and manifest. Mutating.",
  ].join("\n"),
  flags: [
    { name: "force", description: "Adopt or replace unmanaged files only; never overwrites managed local modifications." },
    { name: "model", value: "<version>", description: "Pin the agent's model_version at install time." },
    { name: "regen-skills", description: "Refresh built-in skill files; dynamic command-skill collisions are refused." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact adapter install claude-code --json",
    "code-pact adapter install claude-code --model claude-opus-4-8 --json",
  ],
};

const upgrade: CommandSpec = {
  cluster: "adapter",
  command: "upgrade",
  positional: "<agent>",
  summary: [
    "Re-sync an installed adapter's managed files to the current generator",
    "output. Exactly one of --check or --write is required; --check is read-only,",
    "and --write applies changes.",
  ].join("\n"),
  flags: [
    { name: "check", description: "Report drift and exit non-zero if any; writes nothing." },
    { name: "write", description: "Apply the upgrade." },
    { name: "force", description: "Adopt or replace unmanaged files only; never overwrites modified managed files." },
    { name: "accept-modified", description: "Allow overwriting managed local modifications when used with --write." },
    { name: "regen-skills", description: "Refresh built-in skill files; dynamic command-skill collisions are refused." },
    { name: "model", value: "<version>", description: "Update the agent's model_version; requires --write." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact adapter upgrade claude-code --check --json",
    "code-pact adapter upgrade claude-code --write --json",
    "code-pact adapter upgrade claude-code --write --accept-modified --json",
  ],
};

const doctor: CommandSpec = {
  cluster: "adapter",
  command: "doctor",
  summary: [
    "Run adapter-scoped manifest and generated-file diagnostics. With --agent,",
    "inspect exactly one adapter; otherwise inspect enabled agents.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "agent", value: "<name>", description: "Inspect one adapter by agent name." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact adapter doctor",
    "code-pact adapter doctor --agent claude-code --json",
  ],
};

const conformance: CommandSpec = {
  cluster: "adapter",
  command: "conformance",
  positional: "<agent>",
  summary: [
    "Check that an installed adapter satisfies the agent contract and per-file",
    "integrity requirements.",
  ].join("\n"),
  readOnly: true,
  flags: [{ name: "json", description: "Emit JSON." }],
  examples: [
    "code-pact adapter conformance claude-code",
    "code-pact adapter conformance claude-code --json",
  ],
};

export const ADAPTER_SPECS = {
  list,
  install,
  upgrade,
  doctor,
  conformance,
} satisfies Record<string, CommandSpec>;

export const ADAPTER_SPEC_ORDER = [
  "list",
  "install",
  "upgrade",
  "doctor",
  "conformance",
] as const;
