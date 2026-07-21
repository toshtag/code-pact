# P80-T2: Qualified One-Pair Effectiveness Trial

## Trial plan

P80-T2 adds a capability gate before the one-pair comparison. The same local
model (`gemma3:latest`) is used for the gate, the baseline condition, and the
Code Pact condition. One invocation is allowed per stage; repair is not used.

This file will be updated with results after the trial completes.

## Fixed scope

- Capability gate: 1 invocation
- If the gate passes:
  - Baseline: 1 invocation
  - Code Pact: 1 invocation
- Maximum total model invocations: 3
- Repair: 0
- Model switching: 0
- Provider switching: 0
- Corrective pass maximum: 1

## Writes

- `design/decisions/P80-T2-qualified-one-pair-trial.md`
- `scripts/experiments/verify-p80-t2-evidence.mjs`

## Evidence archive

`/tmp/code-pact-p80-t2/P80-T2-trial-evidence.zip`
