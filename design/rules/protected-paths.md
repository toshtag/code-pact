# Protected paths

Globs in this file feed `TASK_WRITES_PROTECTED_PATH` plan-lint warnings.
A task that declares `writes` overlapping any of these patterns gets an
advisory warning at `plan lint` time. Under `plan lint --strict` the
warning becomes exit-relevant (existing binary `--strict` promotion).

This file is **optional**.

- **Absent file** → code-pact falls back to the hardcoded default list
  from `src/core/glob.ts` (`PROTECTED_PATHS`). v1.5 behaviour.
- **Present file** → the file is the source of truth. The hardcoded
  defaults are NOT layered on top. If you want them, list them here.
- **Empty file (or only comments)** → explicit "no protected paths".

Format:

- One glob per line, P10 supported subset only (literal segments, `*`,
  `**`).
- Lines starting with `#` are comments.
- End-of-line `# ...` comments are stripped.
- Blank lines are ignored.
- Malformed entries (unsafe paths, glob syntax outside the P10 subset)
  are silently skipped.

Default list (the v1.5 `PROTECTED_PATHS` constant — included here as a
starting template; edit freely):

```
.git/**
node_modules/**
.code-pact/**
design/roadmap.yaml
design/phases/*.yaml
```

Typical extensions you might add for your project:

```
# Build outputs and lockfiles you do not hand-edit
dist/**
build/**
package-lock.json
pnpm-lock.yaml

# Secrets and credentials
secrets/**
.env
.env.*

# Vendored dependencies
vendor/**
third_party/**
```

To regress to the v1.5 hardcoded behaviour, delete this file.
