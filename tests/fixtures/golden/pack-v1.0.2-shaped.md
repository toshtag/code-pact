# Context Pack — P2 / P2-E1-T1

**Agent:** claude-code  
**Phase:** P2 — Core CLI  
**Task:** P2-E1-T1

## Rules

### coding-style.md

# Coding style rules

- Prefer explicit over implicit.
- No commented-out code in commits.
- File-level exports only; avoid barrel re-exports of internal helpers.

### testing.md

# Testing rules

- All new features must have unit tests.
- Do not mock the database in integration tests.
- Test filenames mirror the source file: `foo.ts` → `foo.test.ts`.

## Phase Contract

**Objective:** Implement the five MVP CLI commands: init, phase, progress, pack, verify.

**Definition of Done:**
- All five commands are functional
- All commands support --json
- Snapshot tests pass for fixtures

**Non-Goals:**
- LLM API integration
- Web UI

## Task Definition

| Field | Value |
|-------|-------|
| ID | P2-E1-T1 |
| Type | feature |
| Ambiguity | medium |
| Risk | medium |
| Context size | medium |
| Write surface | medium |
| Verification | strong |
| Expected duration | medium |
| Status | planned |

**Description:** Implement code-pact init command

## Related Decisions

### P2-E1-T1-use-parseargs.md

# ADR: Use node:util parseArgs for CLI parsing

**Task:** P2-E1-T1  
**Status:** accepted

## Context

We need a CLI argument parser. External libraries like `commander` add runtime
dependencies and pull in transitive packages.

## Decision

Use `node:util` `parseArgs` (built-in since Node 18.3). No additional
dependency required.

## Consequences

- No external dep for CLI parsing.
- Limited to flag-style options; positionals handled manually.

## Verification Commands

```
pnpm test
```
```
pnpm typecheck
```
```
pnpm build
```

## Recording progress

Do NOT hand-write the ledger. When this task is complete, record it with:

```sh
code-pact task complete P2-E1-T1 --agent <agent>
```

If the work was completed outside the loop, record it with evidence instead:

```sh
code-pact task record-done P2-E1-T1 --evidence "<verification command or artifact>"
```

Either writes one merge-safe event file under `.code-pact/state/events/`.
