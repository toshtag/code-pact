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
