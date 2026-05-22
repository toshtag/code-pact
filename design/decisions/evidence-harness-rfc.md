# RFC: Evidence harness — internal-only dogfood measurement

**Status:** proposed (P20, 2026-05)
**Scope:** add an internal-only measurement harness at `scripts/harness/` that captures deterministic, deterministic-input metrics from the dogfood corpus (`design/phases/*.yaml` + `.code-pact/state/progress.yaml`) and from a small set of external sample repos. Output is CSV in a stable column shape suitable for citation inside `design/decisions/*.md`. **Not a product feature** — never registered in `package.json` bin, never invoked by users, never surfaces in JSON envelopes or CLI help. The harness is a maintainer tool for moving design judgement from "感覚" to "measurement."
**Owners:** maintainer
**Related:**
- [design/decisions/task-readiness-schema-rfc.md](task-readiness-schema-rfc.md) (P10 — defines the per-task fields the harness measures pack size against).
- [design/decisions/lightweight-runbook-rfc.md](lightweight-runbook-rfc.md) (P12 — defines the runbook surface whose step counts feed one of the metrics).
- [design/decisions/governance-rfc.md](governance-rfc.md) (P14 — the strict-clean dogfood regime the harness operates against).

## Status lifecycle

- This document opens at status **proposed** in PR1 (the P20-T1 PR) and flips to **accepted** in a follow-up commit before merge, per the P11–P19 RFC lifecycle precedent.
- P20-T1 is considered done only after PR1 — with the status line reading `accepted` — has landed on main.
- Subsequent implementation PRs (P20-T2..T4) treat the accepted document as load-bearing.

## Background

code-pact has been designed by deliberate judgement — RFC lifecycle, advisory locks, strict-clean dogfood, etc. — but every design decision so far rests on **qualitative** arguments: "this feels safer", "this feels noisier", "this is the natural break-point". The qualitative posture has carried the project through P1–P19 without major regressions, but two recent decisions hit the limits of taste-driven reasoning:

1. **Cycle severity in P19-T2.** The RFC originally proposed `warning`; review pressure (consistency with `TASK_DEPENDS_ON_SELF_REFERENCE`) flipped it to `error` before merge. The flip was the right call, but it was a judgement call. Real evidence about how often cycles appear mid-refactor in a typical roadmap would have settled the question deterministically.
2. **Strict-clean dogfood scope in P15-T3.** The decision to make protected-paths configurable (vs hardcoded) was driven by feel — "config is more honest" — without measurement of how often the dogfood corpus actually trips the warning. Empirical drift rate would have made the case sharper.

The harness is the path out of this. It captures a small set of deterministic metrics from the corpus and emits CSV that a future RFC can cite as "X% of dogfood tasks have `writes` declared", "context pack size for the average task is N tokens", etc.

## Decision

1. **Internal-only tool, not a product feature.** Lives under `scripts/harness/`. The `package.json` `bin` field is unchanged. No new public CLI surface. No new error codes. No JSON envelope. Output is CSV files written to `design/measurements/` (a new directory, intentionally outside `dist/`, `src/`, `.code-pact/`).
2. **Deterministic-input metrics only.** Every metric is computable from already-on-disk artifacts:
   - phase YAML (`design/phases/*.yaml`)
   - roadmap YAML (`design/roadmap.yaml`)
   - progress events (`.code-pact/state/progress.yaml`)
   - git working tree state (for audit drift, when relevant)
   No network. No LLM API. No telemetry.
3. **Initial metric set (locked).** v1.10 ships four CSV outputs:
   - `pack-size-by-task.csv` — for every task in the corpus, the size of `task context <task-id>` output (bytes + line count + section count). Quantifies the "context bandwidth" each task asks of an agent.
   - `verify-success-rate.csv` — per phase, the count of `task complete` events that succeeded on first verify vs required a retry (derived from `progress.yaml` event chain). Quantifies how strong verification commands are.
   - `task-event-density.csv` — per task, the count of progress events by status (started / blocked / resumed / done / failed). Quantifies how often tasks bounce vs flow linearly.
   - `lint-issue-histogram.csv` — count of each `plan lint --include-quality` diagnostic code across the corpus, by phase. Quantifies the "noise floor" of the lint surface.
4. **Sample repos external, optional, deterministic.** The harness accepts `--corpus <path>` to point at any cloned project that has a `design/` directory. v1.10 ships baseline measurements for the dogfood corpus only; sample repo runs are deferred to P20-T3 implementation when an externalisable example exists.
5. **CSV format locked.** Header columns are fixed in this RFC and cited verbatim by future decisions. Format changes require a follow-up RFC amendment.
6. **No timestamps in output.** The CSV is reproducible from the same inputs; including `now()` would break diff-ability across runs. A separate `measurements.manifest.json` (also written to `design/measurements/`) records the git SHA of the inputs and the harness version, so historical CSVs are traceable.

## What this does NOT change

- **The product surface.** `code-pact` users see no new commands, no new flags, no new error codes, no new JSON fields. The harness is invisible to anyone running `npm install -g code-pact`.
- **The `dist/` bundle.** `scripts/harness/` is not bundled by `tsup`; `package.json` `files` does not include it.
- **Existing CI workflows.** The harness is not part of `pnpm test:ci`. A separate optional `pnpm harness` script invokes it; CI can opt in via a future workflow if maintainer interest demands.
- **`design/` corpus integrity.** The harness only **reads** corpus YAML. It writes only to `design/measurements/` (and only when `--write` is passed; `--check` mode prints to stdout).
- **`KNOWN_CODES.public`.** Unchanged.
- **`progress.yaml` schema.** Unchanged.

## CSV format specifications

### `pack-size-by-task.csv`

```csv
phase_id,task_id,pack_bytes,pack_lines,pack_sections,reads_glob_count,writes_glob_count,decision_refs_count,acceptance_refs_count
P14,P14-T6,12483,287,8,4,2,1,1
P15,P15-T1,18204,412,9,5,4,1,1
...
```

Column semantics:
- `pack_bytes`: `JSON.stringify(packResult).length` for the per-task pack
- `pack_lines`: `packResult.markdown.split("\n").length`
- `pack_sections`: number of `## ` headings in the pack markdown
- the four `*_count` columns: cardinality of the corresponding task field arrays

### `verify-success-rate.csv`

```csv
phase_id,task_id,first_pass,retries,verify_runs_total
P10,P10-T2,true,0,1
P15,P15-T6,true,1,2
...
```

Column semantics:
- `first_pass`: true if the task's `done` event came from the first verify attempt (no `failed` events between `started` and `done`)
- `retries`: count of `failed` or `blocked → resumed` cycles before the final `done`
- `verify_runs_total`: `retries + 1` (always ≥ 1 if `done` exists)

Tasks without a `done` event are omitted from this CSV.

### `task-event-density.csv`

```csv
phase_id,task_id,started,blocked,resumed,done,failed,total_events,event_span_days
P12,P12-T3,1,0,0,1,0,2,0.4
P15,P15-T6,1,1,1,1,0,4,2.1
...
```

Column semantics:
- one column per status enum value
- `total_events`: sum of all status columns
- `event_span_days`: time between the first and last event, in days (decimal). 0 if all events occurred on the same day.

### `lint-issue-histogram.csv`

```csv
phase_id,code,severity,count
P15,TASK_WRITES_PROTECTED_PATH,warning,3
P18,PLACEHOLDER_VERIFICATION,warning,1
...
```

One row per (phase, code) pair. Rows with `count: 0` are omitted to keep the file small. Sorted by `phase_id ASC, code ASC` for deterministic diff-ability.

### `measurements.manifest.json`

Sibling to the CSVs. Single JSON object:

```json
{
  "harness_version": "0.1.0",
  "input_git_sha": "abcdef0",
  "code_pact_cli_version": "1.10.0",
  "generated_at": "2026-05-22",
  "csv_files": ["pack-size-by-task.csv", "verify-success-rate.csv", "task-event-density.csv", "lint-issue-histogram.csv"]
}
```

`generated_at` is a date (no clock time) to keep the manifest diff-stable within the same day.

## Invocation surface

```sh
# Dry-run: print CSV contents to stdout, write nothing
pnpm harness --corpus .

# Persist to design/measurements/
pnpm harness --corpus . --write

# Quiet mode for CI dashboards
pnpm harness --corpus . --json
```

The `pnpm harness` script is added to `package.json` `scripts` (NOT to `bin`). The script invokes `node --import tsx scripts/harness/run.ts`.

Default behaviour is `--check` (print to stdout). `--write` is opt-in. There is no `--force` — overwriting existing CSVs is fine because they are deterministic.

## Backward compatibility

- Pure additive at the maintainer-tool level. End users see nothing new.
- `package.json` adds a `scripts.harness` entry and nothing else.
- `design/measurements/` is a new directory; it is **not** added to `.gitignore` because the CSVs are intentionally committable artifacts (they ground future RFCs).

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Ship the harness as a public `code-pact harness` command | Conflates product surface with maintainer tooling. Users would expect the metric set to be stable forever; we want freedom to evolve the metric definitions as we learn what's actually useful. |
| Stream metrics to OpenTelemetry / Prometheus / etc. | Out of charter. The harness is dogfood-internal; introducing observability infrastructure would expand surface and dependencies for no immediate user benefit. |
| Use `npx code-pact harness` to make it discoverable but hidden | Discoverability invites user expectation. Internal scripts under `scripts/` are the standard place for "tools that aren't products". |
| Include `now()` timestamps in CSV cells | Breaks diff-ability across runs against the same input SHA. We use a `generated_at` field in the manifest (a date, not a clock time) and keep the CSVs deterministic. |
| Measure LLM-side metrics (token cost, latency) | Out of charter — requires a model API and breaks the deterministic-input rule. Cost/latency measurement is a separate (un-RFCed) future direction if/when needed. |
| Make `design/measurements/` gitignored | The whole point is to commit the CSVs so future RFCs can cite specific row values. Gitignoring would defeat the purpose. |

## Open questions

None at proposal time. The metric set (4 CSVs), the CSV column shapes, the manifest JSON shape, the `pnpm harness` invocation, and the "internal-only, not in `bin`" stance were all settled during P20-T1 drafting. Implementation may surface edge cases that warrant a follow-up amendment.

## Deferred to a later phase / RFC

- **External sample repo measurements** (P20-T3 in this phase covers the harness wiring, but ships only against the dogfood corpus in v1.10). A future phase can add curated sample repos with measurement baselines.
- **Metric trends over time** (line-graph CSVs that read prior runs and compute deltas). v1.10 ships single-snapshot CSVs only.
- **LLM-side metrics** (token cost, latency, retry counts driven by API errors). Requires network and external dependencies — separate RFC if/when needed.
- **An RFC-citation tool** that auto-embeds CSV rows into `design/decisions/*.md`. Manual citation by humans is enough for v1.10.

## Acceptance criteria

- This document carries `Status: accepted` before any P20-T2/T3/T4 implementation PR opens.
- `scripts/harness/run.ts` ships and is invokable via `pnpm harness --corpus . --write`.
- The four CSVs and the manifest land under `design/measurements/` for the dogfood corpus.
- The CSVs are byte-deterministic given the same input git SHA (a test asserts this by running the harness twice and comparing output).
- `tests/integration/json-stdout.test.ts` continues to pass (harness is not part of the CLI surface).
- `KNOWN_CODES.public` is unchanged.
- `package.json` `bin` is unchanged. `package.json` `files` is unchanged.
- Phase YAML schema and `progress.yaml` schema unchanged.
