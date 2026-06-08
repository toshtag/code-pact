// Typed catalog: the `data.detail` enums for the non-interactive input *capture*
// modes of `plan brief` and `plan constitution` (`--from-file` and `--stdin`).
// "Capture" = taking new planning input from the user; this is NOT `plan adopt`
// or `plan import` (which ingest existing plan files and have their own details).
// Both capture commands share these — their input failure modes are identical.
//
// Side-effect-free / import-light (imports nothing) — the doc generator
// (scripts/gen-doc-blocks.ts) reads it to render the cli-contract.md detail table
// without dragging the command handlers' yaml/zod/parser deps into check:docs.
// Edit a detail here and nowhere else: `check:doc-blocks` (table drift) and `tsc`
// (a renamed key breaks the runtime detail types) fail until every surface
// follows. Key order is the published order — keep it stable.

// invalid_yaml / schema_invalid fire in BOTH modes — their own named catalog so
// the parser layer can reference exactly the shared two, and so the descriptions
// are defined once and spread into the file/stdin catalogs below.
export const PLAN_CAPTURE_PARSE_DETAILS = {
  invalid_yaml: { when: "the input is not valid YAML" },
  schema_invalid: { when: "the parsed YAML does not match the schema" },
} as const;

export const PLAN_CAPTURE_FILE_DETAILS = {
  unsafe_path: { when: "`--from-file` path failed `assertSafeRelativePath`" },
  unreadable: { when: "`--from-file` path exists but cannot be read" },
  ...PLAN_CAPTURE_PARSE_DETAILS,
} as const;

export const PLAN_CAPTURE_STDIN_DETAILS = {
  stdin_read_failed: { when: "`--stdin` could not be read from `process.stdin`" },
  ...PLAN_CAPTURE_PARSE_DETAILS,
} as const;

export type PlanCaptureFileDetail = keyof typeof PLAN_CAPTURE_FILE_DETAILS;
export type PlanCaptureStdinDetail = keyof typeof PLAN_CAPTURE_STDIN_DETAILS;
export type PlanCaptureParseDetail = keyof typeof PLAN_CAPTURE_PARSE_DETAILS;
