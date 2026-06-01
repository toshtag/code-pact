# RFC: CLI command spec — single source for parse, help, and reference docs

> Status: **accepted — implemented in v1.28.0** (task cluster: parse/help/
> reference derive from CommandSpec; cli-contract task flag tables point at the
> generated reference).
> Scope: P46. task cluster only. No behaviour change to any command.

## Problem

A task command's flag surface is declared in **three** places that no
mechanism keeps in sync:

1. **parse** — the `strictParse(...)` call inside each `cmd*` function in
   `src/cli/commands/task.ts` (`{ agent: {type:"string"}, json:{type:"boolean"}, … }`).
2. **help** — the hand-written synopsis + flag list in `LEAF_USAGE` in
   `src/cli/usage.ts`.
3. **reference** — the hand-written flag tables in `docs/cli-contract.md`
   (one `## \`task <verb>\`` section per command).

Today (verified) these are *consistent* for `task prepare` — the problem is
not existing drift, it is that **nothing prevents drift**. Add a flag and you
must remember to edit three files; the only safety net is reviewers' eyes and
a few keyword tests (`task-lifecycle-help-terms.test.ts`,
`record-done-help-terms.test.ts`) that assert presence of specific strings,
not flag-set equality.

This is the maintenance-surface problem the project removes elsewhere (cf. the
docs/ja mirror removal): a hand-synced duplicate with no enforcement.

## Decision

Introduce one **`CommandSpec`** per task subcommand as the single source.
Everything else is **derived** from it:

```
src/cli/spec/task.ts   ── CommandSpec[] (the single source)
      │
      ├─ toParseOptions(spec)  → the object passed to strictParse  (parse)
      ├─ renderLeafHelp(spec)  → the LEAF_USAGE entry              (help)
      └─ renderReference(spec) → one section of the generated .md  (reference)
```

- **Parse is derived too** (chosen over "help/docs only"): `task.ts` calls
  `strictParse("task prepare", argv, toParseOptions(spec.prepare), …)` instead
  of an inline options literal. A flag added to the spec changes parse, help,
  and docs at once — true single source.

  **Precise claim:** *flag-surface* drift across parse / help / generated
  reference becomes structurally impossible (they share one source). This is
  NOT a claim that all CLI behaviour is now drift-proof. Runtime semantics stay
  the responsibility of command tests and other docs:
  - required-flag **enforcement** lives in command bodies (see `required` note
    below), guarded by parse regression tests — not by the spec.
  - which option names a command body actually reads.
  - example **runnability** — guarded by `task-prepare-commands-contract.test.ts`.
  - the narrative prose and the JSON envelope / error-code sections of
    `cli-contract.md` — owned and tested separately.
- **Generation runs under tsx** (chosen over reading `dist/`): the spec stays
  TypeScript in `src/`, `scripts/gen-cli-reference.ts` imports it via tsx and
  writes `docs/cli-reference.generated.md`. Type-safe, no build prerequisite,
  matches the existing `scripts/harness/run.ts` tsx precedent.

## The type

A plain `type` (not zod). It describes static CLI shape, not runtime-validated
external input, so the project's zod-for-schemas convention does not apply —
this is closer to the existing `LEAF_USAGE` constant. Placed at
`src/cli/spec/types.ts`.

```ts
export type FlagSpec = {
  name: string;                 // long flag, no dashes: "budget-bytes"
  value?: string;               // value placeholder for help: "<N>"; absent → boolean
  required?: boolean;           // shown as required in help; informational for parse
  repeatable?: boolean;         // maps to parseArgs multiple:true
  description: string;          // one line, help + reference
};

export type CommandSpec = {
  cluster: "task";              // P46 is task-only; widen later
  command: string;              // "prepare"
  positional?: string;          // "<task-id>" (help synopsis); undefined → none
  summary: string;              // the paragraph(s) under the Usage line
  flags: FlagSpec[];
  examples: string[];           // full command lines
  readOnly?: boolean;           // surfaces the "Read-only — never mutates…" note
};
```

### Derivation: `toParseOptions`

```ts
// FlagSpec[] → the Node parseArgs options object strictParse expects.
// value present → string; absent → boolean. repeatable → multiple:true.
function toParseOptions(spec: CommandSpec): ParseArgsOptionsConfig {
  const out: ParseArgsOptionsConfig = {};
  for (const f of spec.flags) {
    out[f.name] = {
      type: f.value ? "string" : "boolean",
      ...(f.repeatable ? { multiple: true } : {}),
    };
  }
  return out;
}
```

`required` is **not** expressed to parseArgs (Node's parseArgs has no required
concept). **`required` on the spec is presentation-only — it is NOT runtime
enforcement.** Required-flag enforcement already lives in each command's body
(e.g. `task block --reason`, `task record-done --evidence`, `task add`'s
required fields) and stays there. This keeps the spec honest: it does not claim
parse enforces something it doesn't.

Because the spec does not enforce required-ness, the enforcement must be pinned
independently. **Add regression tests** (if not already present) that assert:

- `task block` without `--reason` fails.
- `task record-done` without `--evidence` fails.
- `task add`'s missing required fields fail.

These guard the runtime contract the spec deliberately does not own.

## What this touches

### `src/cli/commands/task.ts` (the largest change)

Each `cmd*` function's inline `strictParse(...)` options literal becomes
`toParseOptions(SPEC.<verb>)`. The verified flag sets are preserved exactly —
this is a mechanical lift, asserted by the existing
`task-prepare-commands-contract.test.ts` (it runs the built CLI against every
emitted command string and fails on any "Unknown option").

**Exception — `task add`.** It does not use `strictParse`; it calls stdlib
`parseArgs()` directly (task.ts ~166-187) because of its large, mixed
required/repeatable flag set. `toParseOptions` produces the same options shape
`parseArgs` already takes, so `add` is converted the same way. No behaviour
change.

### `src/cli/usage.ts`

`LEAF_USAGE["task <verb>"]` entries are replaced by
`renderLeafHelp(SPEC.<verb>)`. `renderLeafHelp` reproduces the current format
(Usage line, summary, `Options:` block, `Examples:` block, the read-only note)
so existing help-terms tests keep passing. **The exact current wording for
record-done is preserved** — its tests assert specific dual-use framing
(P33/P38) and forbidden phrasings; the spec's `summary` carries that text
verbatim.

### `docs/cli-reference.generated.md` (new) + `docs/cli-contract.md` (shrinks)

- New `docs/cli-reference.generated.md`: the per-command flag tables + usage +
  examples for the task cluster, rendered from the spec. Has a generated-file
  header banner ("DO NOT EDIT — run pnpm gen:cli-reference").
- `docs/cli-contract.md`: the 11 `## \`task <verb>\`` flag-table sections are
  **replaced by a single pointer** to the generated reference. cli-contract.md
  keeps what it should own: JSON envelope, exit codes, error/cause codes,
  stability taxonomy, locale, write guarantees. (This is the P53 "shrink
  cli-contract" direction, but scoped to only the task sections P46 generates —
  no broader docs churn.)

  Note: `check-doc-invariants.mjs` rule #8 reads `cli-contract.md`'s "JSON
  output shape" section — untouched by this change (that section stays).

### `scripts/gen-cli-reference.ts` + package.json

A **TypeScript** script (not `.mjs`): it imports the `CommandSpec` types and
data directly, so it should live in the same typed world it depends on. The
existing `scripts/*.mjs` are plain JS with no such dependency; this one has a
reason to be `.ts`, run under tsx (the `scripts/harness/run.ts` precedent).

```jsonc
"gen:cli-reference":  "tsx scripts/gen-cli-reference.ts",
"check:cli-reference":"tsx scripts/gen-cli-reference.ts --check"
```

`--check` regenerates into memory and compares to the committed file; on drift
it prints the diff and exits 1 (the `git diff --exit-code` pattern, but
self-contained so it works on a dirty tree too). Wired into `check:docs` and
the CI `full` job alongside the existing doc checks.

## Tests

- **Keep**: `task-lifecycle-help-terms.test.ts`, `record-done-help-terms.test.ts`,
  `cli-help.test.ts`, `task-prepare-commands-contract.test.ts` — they pin the
  rendered output and the live parse contract. If the render is faithful they
  pass unchanged; that is the regression guard for the lift.
- **Add** `spec-render.test.ts`: for every `CommandSpec`, `toParseOptions`
  yields a valid parseArgs config, and `renderLeafHelp` output contains the
  Usage line, every flag, and every example. This is the new invariant that
  replaces "remember to edit three files".
- **Add** a `--check` assertion path so CI fails if the committed
  `cli-reference.generated.md` is stale.

## Staging (within this one PR)

1. `types.ts` + `toParseOptions` + `renderLeafHelp` + `renderReference`, and
   the `SPEC` for **prepare, complete, finalize** only. Wire those three
   through parse + help. Generator emits their sections. Land the CI check.
   → vertical slice: all layers proven on 3 commands.
2. Port the remaining 8 (add, context, start, status, block, resume, runbook,
   record-done) onto the spec. No new mechanism — only data.

   **`task add` is the highest-risk port** (stdlib `parseArgs` directly, the
   largest mixed required/repeatable flag set). Before/with its port, add a
   focused **`task add` parse regression test** covering:
   - repeatable flags (`--depends-on`, `--read`, `--write`, … accumulate).
   - a missing required field fails (`--description` without `--type`).
   - an unknown option fails.
   - boolean vs string options are not swapped (`--json` boolean,
     `--id <v>` string).
   - positional handling (`<phase-id>`).
3. Replace the 11 cli-contract.md task sections with the pointer; commit the
   generated file.

   **Anchor compatibility.** Removing the 11 `## \`task <verb>\`` headings drops
   their `#task-prepare`-style anchors; any in-repo link to them would break
   (`check-doc-links.mjs` would catch it). Before deletion, grep for links into
   those anchors. Then either (a) keep a thin redirect stub heading in
   cli-contract.md pointing at the generated reference, or (b) give the
   generated reference stable matching anchors and repoint the links. Pick per
   what the grep finds; `check:docs` must stay green.

Done in one PR but in that order, so a mid-review failure localizes to a layer,
not a command.

## Non-goals (explicitly out)

- Other clusters (plan/phase/adapter). task-only this round; the type carries a
  `cluster` field so widening is additive. **Future candidate:** plan/phase/adapter
  leaf help was brought to parity by hand in P52 (the 9 mutating/JSON commands);
  porting those clusters onto `CommandSpec` — so their parse/help/reference share
  one source like task's — is a deferred follow-up, not done here. The P52
  hand-written help is the interim; CommandSpec-izing it is the eventual dedupe.
- Any flag/behaviour change. Pure refactor + generation; the verified flag sets
  are preserved byte-for-byte.
- Touching `cli-contract.md` sections other than the 11 task flag tables.
- **Widening `CommandSpec` beyond flag surface + `readOnly`.** No write
  semantics, lifecycle semantics, or recovery hints on the spec this round —
  those belong to P47+ and would bloat the type. `readOnly` is the only
  semantic field allowed in P46.

## Risks

- **Faithful render is load-bearing.** If `renderLeafHelp` diverges from the
  current text, help-terms tests fail — caught in CI, not shipped. The
  record-done framing is the sharpest edge; its `summary` is copied verbatim.
- **`task add`'s parseArgs nuances.** Its required/repeatable mix must map
  exactly. The contract test + a focused `add` parse test cover this.
- **Generated-file drift in CI.** Mitigated by `check:cli-reference` running in
  the same `full` job that already gates the branch.
