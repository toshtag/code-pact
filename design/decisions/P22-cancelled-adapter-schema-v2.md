# P22 cancellation — Adapter schema v2 and template signature tracking

**Status:** accepted (P22, 2026-05)
**Decision:** Cancel P22 as originally proposed. No code change ships under this phase.

## Context

P22 was the last item on the roadmap drafted at the start of the v1.11 development cycle. The originally-proposed scope had two parts:

1. **`adapter_schema_version: 2` bump** with a new per-file `template_signature` field intended to let `adapter doctor` distinguish "upstream template changed" from "local user edit" when surfacing drift.
2. **Lifecycle hooks** (`prepare_command` / `finish_command`) — agent-side commands that `code-pact` would expose to the agent runtime at well-defined points in the per-task lifecycle.

Both pieces were preemptive engineering — neither was driven by an observed user pain. Across v1.11 → v1.13.2 (five releases), only v1.11.0 required users to re-run `adapter upgrade` after a template body change, and that was a one-off adapter template refresh tied to P21's agent contract surface additions, not a recurring pattern.

## Finding

The premise that motivated `template_signature` — distinguishing upstream template change from local user edit — **is already satisfied by the v1 manifest plus the existing `adapter doctor` two-axis classification.**

The two axes already implemented:

- **Local state** (in [`src/core/adapters/file-state.ts`](../../src/core/adapters/file-state.ts)): `managed-clean` (disk hash equals manifest hash) vs `managed-modified` (disk hash differs from manifest hash) vs `managed-missing`.
- **Desired state**: `current` (the current generator's output equals what is on disk) vs `stale` (the current generator would produce different content).

The combinations map cleanly to existing doctor codes:

| local × desired | doctor code | meaning |
|---|---|---|
| `managed-clean × stale` | `ADAPTER_DESIRED_STALE` | Upstream template changed; the local file was not edited. |
| `managed-modified × stale` | `ADAPTER_FILE_DRIFT` | Upstream template changed AND the local file was edited. Both axes diverge. |
| `managed-modified × current` | (no doctor issue) | The file content already matches the current desired output; only the manifest hash entry is stale. |
| `managed-missing` | `ADAPTER_FILE_MISSING` | A managed file is missing from disk. |

A `template_signature` per file would duplicate the information `desired` already carries. The two-axis classification has shipped since v0.9 (P7), is exercised by every `adapter doctor` test, and has held up across every subsequent adapter template change.

The premise that motivated lifecycle hooks — making post-install / pre-task / etc. extension points available to agent integrations — has no concrete use case the project has been asked to serve. Designing `prepare_command` / `finish_command` semantics, security model (arbitrary command execution surface), and rollback behaviour before a real consumer exists would produce a contract we would likely re-shape on first contact with a real integration.

## Decision

- **Do not ship adapter schema v2 for P22.**
- **Do not add a `template_signature` field** to `ManifestFile`. The v1 schema is sufficient.
- **Do not bump `adapter_schema_version`** in any of the adapter modules. The current value (1 for every adapter) remains correct.
- **Do not rename existing public error codes** (`ADAPTER_DESIRED_STALE`, `ADAPTER_FILE_DRIFT`, etc.). The names are imperfectly self-describing — `ADAPTER_FILE_DRIFT` covers the "both axes diverged" case, not the "any drift" case — but a rename would be a breaking change to the `KNOWN_CODES.public` surface. Document the existing semantics instead.
- **Do not add lifecycle hooks** (`prepare_command` / `finish_command` or any equivalent). When a concrete use case surfaces, a future RFC may revisit; until then, no design.

## Consequence

P22 is closed as **investigated, no shippable scope**. The phase YAML lists `P22-T0` as the lone task (the investigation itself); both task and phase status flip to `cancelled` per the v1.4 `cancelled`-as-intentional-close semantics introduced for P15-T5.

The only follow-up action is a small documentation patch:

- `docs/cli-contract.md` gains a table documenting the existing two-axis classification, the per-code doctor semantics, and the remediation for each row. This is a doc improvement, not a phase — small enough to land as a v1.13.3 patch (or to be bundled into the next phase's release prep if/when one starts).

The number `P22` is **not reused** for a different theme. The slot is preserved as a documented cancellation so the cycle of `P22-T0 → P22 cancelled → P22-T0 → P22 something else` does not happen.

## What follows from this decision

Future work that genuinely needs `template_signature` or lifecycle hooks must come with a concrete use case (a specific agent integration that cannot be implemented today, or a measurable drift-attribution gap not covered by `ADAPTER_DESIRED_STALE` / `ADAPTER_FILE_DRIFT`). The use case justifies the design; designing without one is the failure mode this cancellation guards against.

## Related

- [design/decisions/agent-contract-rfc.md](agent-contract-rfc.md) — v1.7 P16 adapter platform that introduced the file-state classification this decision relies on.
- [design/decisions/agent-contract-v2-rfc.md](agent-contract-v2-rfc.md) — v1.11 P21 adapter conformance work that did require an `adapter upgrade`; the single template body refresh in the v1.11 → v1.13.2 window.
- [design/phases/P15-declared-writes-audit.yaml](../phases/P15-declared-writes-audit.yaml) — P15-T5 cancellation precedent. Sets the pattern of `cancelled`-as-intentional-close used here.
