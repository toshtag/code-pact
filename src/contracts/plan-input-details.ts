// Typed catalog: the `data.detail` enums for the non-interactive input modes of
// `plan brief` and `plan constitution` (`--from-file` and `--stdin`). Their input
// failure modes are identical, so both commands share these.
//
// Side-effect-free / import-light (imports nothing) — the doc generator
// (scripts/gen-doc-blocks.ts) reads it to render the cli-contract.md detail lists
// without dragging the command handlers' yaml/zod/parser deps into check:docs.
// Edit a detail here and nowhere else: `check:doc-blocks` (list drift) and `tsc`
// (a renamed key breaks the runtime detail types) fail until every surface
// follows. Key order is the published list order — keep it stable.

// invalid_yaml / schema_invalid fire in BOTH modes — defined once, spread into
// each so the shared descriptions never diverge.
const SHARED_PARSE_DETAILS = {
  invalid_yaml: { when: "the input is not valid YAML" },
  schema_invalid: { when: "the parsed YAML does not match the schema" },
} as const;

export const PLAN_INPUT_FILE_DETAILS = {
  unsafe_path: { when: "`--from-file` path failed `assertSafeRelativePath`" },
  unreadable: { when: "`--from-file` path exists but cannot be read" },
  ...SHARED_PARSE_DETAILS,
} as const;

export const PLAN_INPUT_STDIN_DETAILS = {
  stdin_read_failed: { when: "`--stdin` could not be read from `process.stdin`" },
  ...SHARED_PARSE_DETAILS,
} as const;

export type PlanInputFileDetail = keyof typeof PLAN_INPUT_FILE_DETAILS;
export type PlanInputStdinDetail = keyof typeof PLAN_INPUT_STDIN_DETAILS;
