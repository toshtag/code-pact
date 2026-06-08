// Typed catalog: the `spec import` `data.detail` enum.
//
// This module is INTENTIONALLY side-effect-free and import-light — it pulls in
// nothing. The doc generator (scripts/gen-doc-blocks.ts) reads it to render the
// `cli-contract.md` detail table, so it must never drag in command-handler deps
// (parsers, file I/O, yaml). New generated-doc catalogs belong here, next to it.
//
// Edit a detail here and nowhere else: `check:doc-blocks` (table drift) and `tsc`
// (a renamed key breaks the `satisfies` ties in the runtime) fail until every
// surface follows. Order is the published table order — keep it stable.
export const SPEC_IMPORT_DETAILS = {
  unsafe_path: { when: "`--from` / `--suggest-from` failed `assertSafeRelativePath`" },
  file_not_found: { when: "source file does not exist" },
  unreadable: { when: "source file exists but cannot be read" },
  phase_id_invalid: { when: "`--phase-id` does not match `/^[A-Za-z][A-Za-z0-9_-]*$/`" },
  phase_yaml_exists: { when: "`--write` would clobber an existing imported YAML (use `--force`)" },
  no_sections_parsed: { when: "input has no Heading 3 sections (importer mode only)" },
  mutex_violation: { when: "`--from` + `--suggest-from` both passed" },
  missing_phase_id: { when: "`--from` passed without `--phase-id`" },
} as const;

export type SpecImportDetail = keyof typeof SPEC_IMPORT_DETAILS;
