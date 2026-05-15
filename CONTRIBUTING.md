# Contributing

## Language policy

| Surface                                          | Language                              |
| ------------------------------------------------ | ------------------------------------- |
| Branch names, commit messages, PR titles/bodies  | English                               |
| Source code and code comments                    | English                               |
| CLI output, usage docs, generated context packs  | i18n (currently `ja-JP`, `en-US`)     |

Internal planning notes that are not meant for public consumption belong in `.local/` (gitignored).

## Commit style

Conventional Commits. Examples:

```
feat(init): create .code-pact and design layouts
fix(verify): treat missing progress event as VERIFICATION_FAILED
chore(deps): pin node engines to >=24
docs(readme): clarify json response shape
test(progress): cover expanded_work for project-b fixture
```

## Branch / PR workflow

- One CLI command (or one cohesive concern) per branch: `feat/<command>` or `chore/<scope>`.
- Open a PR even for solo work; do not push directly to `master`.
- Inside a PR, prefer many small commits. Squash-merge at PR merge time is acceptable.
- CI must be green before merge: `pnpm typecheck && pnpm test && pnpm build`.

## Runtime dependency policy

MVP runtime `dependencies` are limited to `yaml` and `zod`. Do not add CLI frameworks (`commander`), color libraries (`picocolors`), front-matter parsers (`gray-matter`), glob libraries (`globby`), or process libraries (`execa`) without an explicit RFC in `.local/decisions/`.

Use built-ins instead:

- CLI parsing: `node:util` `parseArgs`
- Subprocess: `node:child_process` `spawn`
- Front-matter: small in-repo parser + the existing `yaml` package
- File listing: `node:fs/promises` `readdir`

## Testing

- `vitest`, snapshot tests for command output where useful.
- Fixtures live under `tests/fixtures/`. Snapshot any change deliberately.

## JSON output convention

When `--json` is set, **stdout must be JSON only**. All human-readable logs, warnings, and progress lines must go to **stderr**. Use the shared response shape:

```json
{ "ok": true, "data": { } }
```

```json
{ "ok": false, "error": { "code": "PHASE_NOT_FOUND", "message": "..." }, "data": { } }
```

Stable error code strings are the public contract; do not rename them lightly.
