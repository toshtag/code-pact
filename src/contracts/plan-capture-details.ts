// Typed catalog: the `data.detail` values for the non-interactive input *capture*
// modes of `plan brief` and `plan constitution` (`--from-file` and `--stdin`).
// "Capture" = taking new planning input from the user; this is NOT `plan adopt`
// or `plan import` (which ingest existing plan files and have their own details).
// Both capture commands share these — their input failure modes are identical.
//
// Plain value tuples — the generated cli-contract table shows only the value
// names, so the catalog carries only the names (no unrendered metadata to drift).
// Side-effect-free / import-light (imports nothing) so the doc generator
// (scripts/gen-doc-blocks.ts) reads it without dragging the command handlers'
// yaml/zod/parser deps into check:docs. Edit a value here and nowhere else:
// `check:doc-blocks` (table drift) and `tsc` (a renamed value breaks the runtime
// detail types) fail until every surface follows. Order is the published order.

// invalid_yaml / schema_invalid fire in BOTH modes — spread into each below, and
// named so the parser layer can reference exactly the shared two.
export const PLAN_CAPTURE_PARSE_DETAILS = ["invalid_yaml", "schema_invalid"] as const;

export const PLAN_CAPTURE_FILE_DETAILS = [
  "unsafe_path",
  "unreadable",
  ...PLAN_CAPTURE_PARSE_DETAILS,
] as const;

export const PLAN_CAPTURE_STDIN_DETAILS = [
  "stdin_read_failed",
  ...PLAN_CAPTURE_PARSE_DETAILS,
] as const;

export type PlanCaptureParseDetail = (typeof PLAN_CAPTURE_PARSE_DETAILS)[number];
export type PlanCaptureFileDetail = (typeof PLAN_CAPTURE_FILE_DETAILS)[number];
export type PlanCaptureStdinDetail = (typeof PLAN_CAPTURE_STDIN_DETAILS)[number];
