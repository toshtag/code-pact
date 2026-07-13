import type { CommandSpec } from "./types.ts";

const show: CommandSpec = {
  cluster: "context",
  command: "show",
  positional: "<context-ref>",
  summary: [
    "Inspect or retrieve exact sections from a deferred context manifest.",
    "Default output shows manifest metadata only; --list lists sections without",
    "content; --section prints exactly one section body.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "list", description: "List deferred sections without section content." },
    { name: "section", value: "<name>", description: "Print exactly one deferred section body." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact context show context:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "code-pact context show context:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --list --json",
    "code-pact context show context:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef --section rules",
  ],
};

export const CONTEXT_SPECS = { show } satisfies Record<string, CommandSpec>;
export const CONTEXT_SPEC_ORDER = ["show"] as const;
