// The single source for the state cluster's CLI flag/help/reference surface.
//
// Scope: flag/usage/example reference only. Stable JSON envelopes, exit codes,
// filesystem guarantees, and archive/state maintenance semantics remain in
// docs/cli-contract.md.

import type { CommandSpec } from "./types.ts";

const compact: CommandSpec = {
  cluster: "state",
  command: "compact",
  positional: "<phase-id>",
  summary: [
    "Fold one archived phase's loose progress event files into an event pack.",
    "Dry-run by default; --write writes the pack and removes covered loose files",
    "under the advisory write lock.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Write the event pack and clean up covered loose event files. Default is dry-run." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact state compact P1 --json",
    "code-pact state compact P1 --write --json",
  ],
};

const compactArchive: CommandSpec = {
  cluster: "state",
  command: "compact-archive",
  positional: "[<kind>]",
  summary: [
    "Fold loose archive records into content-addressed bundles. The optional",
    "kind restricts the run to one archive kind; omitting it processes all kinds.",
    "Dry-run by default; --write applies under the advisory write lock.",
  ].join("\n"),
  flags: [
    { name: "write", description: "Fold archive records into bundles and delete bundled loose copies. Default is dry-run." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact state compact-archive --json",
    "code-pact state compact-archive --write --json",
    "code-pact state compact-archive decision_record --write",
  ],
};

const archiveRetention: CommandSpec = {
  cluster: "state",
  command: "archive-retention",
  summary: [
    "Apply keep-latest retention to unreferenced archive records. Dry-run by",
    "default; --write deletes eligible old archive truth under the advisory write",
    "lock.",
  ].join("\n"),
  flags: [
    { name: "keep-latest", value: "<N>", description: "Keep the latest N unreferenced records per kind. Default is the project retention default." },
    { name: "write", description: "Apply the retention plan. Default is dry-run." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact state archive-retention --json",
    "code-pact state archive-retention --keep-latest 5 --json",
    "code-pact state archive-retention --write --json",
  ],
};

const archiveMaintain: CommandSpec = {
  cluster: "state",
  command: "archive-maintain",
  summary: [
    "Run the high-level archive maintenance sequence: recover pending delete",
    "intent, compact, retain, compact again when needed, then run checks. Dry-run",
    "by default; --write applies the sequence under one advisory write lock.",
  ].join("\n"),
  flags: [
    { name: "keep-latest", value: "<N>", description: "Keep the latest N unreferenced records per kind during retention. Default is the project retention default." },
    { name: "write", description: "Apply archive maintenance. Default is dry-run." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact state archive-maintain --json",
    "code-pact state archive-maintain --write --json",
    "code-pact state archive-maintain --write --keep-latest 5",
  ],
};

export const STATE_SPECS = {
  compact,
  "compact-archive": compactArchive,
  "archive-retention": archiveRetention,
  "archive-maintain": archiveMaintain,
} satisfies Record<string, CommandSpec>;

export const STATE_SPEC_ORDER = [
  "compact",
  "compact-archive",
  "archive-retention",
  "archive-maintain",
] as const;
