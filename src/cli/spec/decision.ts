// The single source for the decision cluster's CLI flag/help/reference surface.
//
// Scope: flag/usage/example reference only. Stable JSON envelopes, exit codes,
// filesystem guarantees, and decision lifecycle semantics remain in
// docs/cli-contract.md.

import type { CommandSpec } from "./types.ts";

const prune: CommandSpec = {
  cluster: "decision",
  command: "prune",
  positional: "<path>",
  summary: [
    "Retire a shipped, accepted decision record from the live plane. Dry-run by",
    "default: reports the eligibility verdict and inbound-link rewrite plan;",
    "--write appends the PRUNED.md row, rewrites inbound links, then deletes",
    "the decision record last. Ineligible results list every applicable failing gate.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Execute the prune plan under the advisory write lock. Default is dry-run." },
    { name: "policy", value: "<value>", description: "Override decision_retention for this invocation: one of keep-full, compress-on-ship, prune-on-ship." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact decision prune design/decisions/foo-rfc.md",
    "code-pact decision prune design/decisions/foo-rfc.md --json",
    "code-pact decision prune design/decisions/foo-rfc.md --write --json",
  ],
};

const retire: CommandSpec = {
  cluster: "decision",
  command: "retire",
  positional: "<path>",
  summary: [
    "Retire a decision of any status to a durable decision-state record, then",
    "delete the design/decisions/*.md file last. DRY-RUN BY DEFAULT; --write",
    "writes the record and applies the delete when eligibility still holds.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Write the decision-state record and delete the .md file under the advisory write lock. Default is dry-run." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact decision retire design/decisions/foo-rfc.md",
    "code-pact decision retire design/decisions/foo-rfc.md --json",
    "code-pact decision retire design/decisions/foo-rfc.md --write --json",
  ],
};

export const DECISION_SPECS = {
  prune,
  retire,
} satisfies Record<string, CommandSpec>;

export const DECISION_SPEC_ORDER = [
  "prune",
  "retire",
] as const;
