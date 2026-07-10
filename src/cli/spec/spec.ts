// The single source for the spec cluster's CLI flag/help/reference surface.
//
// Scope: flag/usage/example reference only. Import/suggest semantics, JSON
// envelopes, path guarantees, and failure detail contracts remain in
// docs/cli-contract.md.

import type { CommandSpec } from "./types.ts";

const specImport: CommandSpec = {
  cluster: "spec",
  command: "import",
  summary: [
    "Bridge external spec-driven planning artifacts into code-pact.",
    "Use --from with --phase-id to parse a tasks.md-style file into draft phase",
    "YAML; use --suggest-from to extract brief and constitution candidates.",
    "Dry-run by default; --write persists the imported phase draft.",
  ].join("\n"),
  flags: [
    { name: "from", value: "<path>", description: "Read a tasks.md-style source file and generate draft phase YAML." },
    { name: "suggest-from", value: "<path>", description: "Read a spec.md or plan.md-style source file and emit planning candidates. Never writes files." },
    { name: "phase-id", value: "<id>", description: "Phase id for --from mode. Required with --from; ignored by --suggest-from." },
    { name: "write", description: "Persist the imported phase draft to design/phases/<id>-imported.yaml. Default is dry-run." },
    { name: "force", description: "Overwrite an existing imported phase draft when used with --write." },
    { name: "json", description: "Emit JSON." },
  ],
  examples: [
    "code-pact spec import --from tasks.md --phase-id P-feature --json",
    "code-pact spec import --from tasks.md --phase-id P-feature --write",
    "code-pact spec import --suggest-from spec.md --json",
  ],
};

export const SPEC_SPECS = {
  import: specImport,
} satisfies Record<string, CommandSpec>;

export const SPEC_SPEC_ORDER = ["import"] as const;
