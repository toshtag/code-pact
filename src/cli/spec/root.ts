import type { CommandSpec } from "./types.ts";

const verify: CommandSpec = {
  cluster: "root",
  command: "verify",
  summary: [
    "Run deterministic completion checks without recording progress. This is",
    "the standalone audit surface; `task complete` reuses the same command",
    "execution contract before it records a done event.",
  ].join("\n"),
  readOnly: true,
  flags: [
    { name: "phase", value: "<phase-id>", required: true, description: "Phase id containing the task." },
    { name: "task", value: "<task-id>", required: true, description: "Task id to verify." },
    { name: "dry-run", description: "Preview verification commands without executing them." },
    { name: "timeout", value: "<ms>", description: "Per-command timeout in decimal milliseconds (default: 300000)." },
    { name: "detail", value: "<mode>", description: "JSON detail mode: full (default) or agent. Requires --json." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact verify --phase P1 --task P1-T1 --json",
    "code-pact verify --phase P1 --task P1-T1 --json --detail agent",
    "code-pact verify --phase P1 --task P1-T1 --timeout 300000 --json",
  ],
};

export const ROOT_SPECS = {
  verify,
} satisfies Record<string, CommandSpec>;
