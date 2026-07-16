# Recall and Aggregation Boundary

**Status:** accepted (P70-T1, 2026-07)
**Scope:** separate P63 exact-match recall from P64 deterministic resolution
aggregation before runtime implementation begins.
**Owners:** maintainer
**Related:** `P63-T1-token-reduction-memory-roadmap-rfc.md`

## Decision

P63 automatic recall returns only the minimal fact that the current failure
fingerprint has prior local exact matches. It does not compute or expose
resolution counts.

The P63 `prior_local_signal` shape is:

```json
{
  "schema_version": 1,
  "exact_match_count": 2,
  "last_observed_at": "2026-07-15T00:00:00.000Z"
}
```

The following fields are not part of P63:

- `observed_resolution_count`
- `last_resolved_at`
- `resolved_count`
- `unresolved_count`
- `task_count`

P64 owns deterministic resolution aggregation. P64 derives:

- `failure_count`
- `resolved_count`
- `unresolved_count`
- `last_resolved_at`
- `task_count`

## Invariants

- The current failure episode must never contribute to `exact_match_count`.
- `prior_match_count` is not a public or internal contract field; use
  `exact_match_count`.
- P63 does not duplicate P64 aggregation logic.
- P63 first observation of a fingerprint omits `prior_local_signal`.
- P64 aggregation is a pure derivation over bounded local observations, not
  complete project history and not a correctness gate.

## P65 Relationship

P65 explicit retrieval may return bounded aggregate information after P64
exists. The automatic P63 signal remains minimal. This keeps the always-on
agent-detail failure envelope small while giving agents an explicit retrieval
path when aggregate detail is worth the bytes.

## Implementation Commitments

- P63-T2 implements exact-match lookup only.
- P63-T3 surfaces the minimal signal only in `--detail agent` failure JSON.
- P64-T2 exposes aggregation as a reusable pure function, for example:
  `deriveFingerprintAggregate(episodes, fingerprint)`.
- P65 retrieval may call that aggregate function; it must not reimplement the
  aggregation rules.
