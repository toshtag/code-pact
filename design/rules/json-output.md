---
tags: [cli, json, output]
applies_to: [feature, refactor, bugfix]
---

# JSON output convention

When a `code-pact` command is invoked with `--json` (accepted before or after the command name), **stdout must contain JSON only**. All human-readable logs, warnings, progress lines, and prompts go to **stderr**.

## Envelope shape

```json
{ "ok": true, "data": { ... } }
```

```json
{ "ok": false, "error": { "code": "STABLE_ERROR_CODE", "message": "..." }, "data": { ... } }
```

- `ok: true` always implies `data` is present (it may be an empty object).
- `ok: false` always implies `error.code` is one of the public error codes documented in `docs/cli-contract.md` § Error codes. Adding a new error code is part of the stable surface — bump the table when you add one and make sure `tests/unit/error-code-surface.test.ts` still asserts the full set.
- `error.message` is human-readable. Programs should branch on `error.code`, not on the message string.

## Why it matters

- CI parsers, GitHub Actions output handlers, and downstream agents pipe stdout into `JSON.parse`. A stray `console.log` (warning, progress dot, deprecation notice) anywhere on stdout breaks every caller silently.
- The `--json` contract is part of the `Stable (v1.0)` surface in `docs/cli-contract.md`. Any change to envelope shape or to whether stdout / stderr is used requires a v2 cut.

## Common pitfalls

- **Default stream for diagnostics is stderr, not stdout.** New commands and refactors sometimes use `process.stdout.write(...)` reflexively for progress lines. Under `--json`, that breaks the contract.
- **Adapter-style commands that write files** still must emit a JSON envelope on stdout under `--json`. The "what was written" listing belongs in `data`, not as ad-hoc stdout lines.
- **Interactive wizards** must not run under `--json` — they require a TTY for prompts which is mutually exclusive with JSON-only stdout. Wizards detect TTY via `isInteractive()` and fall back to `CONFIG_ERROR` (exit 2) when the required flags are missing in non-interactive mode.

## Verification

`tests/integration/json-stdout.test.ts` asserts that every command annotated `Stable (v1.0)` in `docs/cli-contract.md` emits valid-JSON-only stdout under `--json`. If you add a new `Stable (v1.0)` command, add it to that test.

## References

- [`docs/cli-contract.md` § JSON envelope](../../docs/cli-contract.md) — full contract and per-command envelope reference.
- [`CONTRIBUTING.md` § JSON output convention](../../CONTRIBUTING.md#json-output-convention) — the contributor-facing statement of this rule.
- [`tests/integration/json-stdout.test.ts`](../../tests/integration/json-stdout.test.ts) — the regression net.
