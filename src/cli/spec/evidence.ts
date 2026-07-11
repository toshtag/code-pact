import type { CommandSpec } from "./types.ts";

const show: CommandSpec = {
  cluster: "evidence",
  command: "show",
  positional: "<evidence-ref>",
  summary: [
    "Print a cached verification evidence artifact by opaque evidence reference.",
    "The artifact contains the bounded stdout/stderr captured by Code Pact, not",
    "an unbounded process log.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "stream", value: "<name>", description: "Which stream to print: all (default), stdout, or stderr." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact evidence show evidence:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "code-pact evidence show evidence:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --json",
    "code-pact evidence show evidence:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --stream stderr",
  ],
};

export const EVIDENCE_SPECS = { show } satisfies Record<string, CommandSpec>;
export const EVIDENCE_SPEC_ORDER = ["show"] as const;
