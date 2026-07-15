import type { CommandSpec } from "./types.ts";

const status: CommandSpec = {
  cluster: "memory",
  command: "status",
  summary: [
    "Report aggregate status for local bounded loop-memory episodes.",
    "Does not print episode bodies, commands, fingerprints, or file paths.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact memory status",
    "code-pact memory status --json",
  ],
};

const prune: CommandSpec = {
  cluster: "memory",
  command: "prune",
  summary: [
    "Plan or apply retention pruning for local bounded loop-memory episodes.",
    "Dry-run by default; --write deletes only validated retention candidates.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Apply the prune plan. Default is dry-run." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact memory prune",
    "code-pact memory prune --json",
    "code-pact memory prune --write --json",
  ],
};

export const MEMORY_SPECS = {
  status,
  prune,
} satisfies Record<string, CommandSpec>;

export const MEMORY_SPEC_ORDER = ["status", "prune"] as const;
