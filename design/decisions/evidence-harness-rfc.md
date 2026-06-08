# RFC: Evidence harness — internal-only dogfood measurement

**Status:** accepted (P20, 2026-05)
**Scope:** an internal-only measurement harness at `scripts/harness/` that captures deterministic-input metrics from the dogfood corpus (`design/phases/*.yaml` + `.code-pact/state/progress.yaml`) and optional external sample repos, emitting CSV in a stable column shape for citation inside `design/decisions/*.md`. **Not a product feature** — never in `package.json` `bin`, never invoked by users, never in JSON envelopes or CLI help. A maintainer tool for moving design judgement from "感覚" to measurement.
**Owners:** maintainer
**Related:** [task-readiness-schema](task-readiness-schema-rfc.md) (P10 — the per-task fields the harness measures pack size against) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12 — the runbook surface whose step counts feed a metric) · [governance](governance-rfc.md) (P14 — the strict-clean dogfood regime the harness operates against).

## Summary

Every code-pact decision through P19 rested on qualitative argument ("feels safer / noisier"). Two recent calls (P19-T2 cycle severity, P15-T3 protected-paths configurability) hit the limits of taste-driven reasoning — real corpus evidence would have settled them deterministically. The harness is the path out: a small set of deterministic metrics computed from on-disk artifacts, emitted as CSV that a future RFC can cite ("X% of dogfood tasks declare `writes`", "average pack is N bytes"). User-facing notes: [docs/concepts/evidence-harness.md](../../docs/concepts/evidence-harness.md).

## Decisions

1. **Internal-only tool, not a product feature.** Lives under `scripts/harness/`. `package.json` `bin` unchanged, no new public CLI surface, no new error codes, no JSON envelope. Output is CSV written to `design/measurements/` — a new directory, intentionally outside `dist/`, `src/`, `.code-pact/`. *Rationale: a public `code-pact harness` command would conflate product surface with maintainer tooling and freeze the metric set under a stability expectation; we want freedom to evolve metric definitions as we learn.*
2. **Deterministic-input metrics only.** Every metric is computable from already-on-disk artifacts: phase YAML, roadmap YAML, progress events, git working-tree state. No network, no LLM API, no telemetry. *Rationale: keeps output reproducible and diff-able; LLM-side metrics (cost/latency) would require an API and break the rule — deferred.*
3. **Initial metric set (locked).** Four CSV outputs (column shapes below). Changing the set or columns requires a follow-up RFC amendment so future decisions can cite columns verbatim.
4. **Sample repos external, optional, deterministic.** `--corpus <path>` points at any cloned project with a `design/` dir. v1.10 ships baseline measurements for the dogfood corpus only; sample-repo runs are deferred to P20-T3 wiring.
5. **No timestamps in output.** CSVs are reproducible from the same inputs; including `now()` would break cross-run diff-ability. A sibling `measurements.manifest.json` records the input git SHA and harness version for traceability, with `generated_at` a date (no clock time) to stay diff-stable within a day.

## What this does NOT change

The product surface (no new commands/flags/error codes/JSON fields); the `dist/` bundle (`scripts/harness/` is not bundled by `tsup`, not in `package.json` `files`); `pnpm test:ci` (the harness runs via a separate opt-in `pnpm harness` script); `design/` corpus integrity (the harness only **reads** corpus YAML, writing only to `design/measurements/` and only under `--write`); `KNOWN_CODES.public`; and the `progress.yaml` schema. `design/measurements/` is deliberately **not** gitignored — the CSVs are committable artifacts that ground future RFCs.

## CSV format specifications

The four CSV column contracts are locked here and cited verbatim by future decisions.

- **`pack-size-by-task.csv`** — columns: `phase_id, task_id, pack_bytes, pack_lines, pack_sections, reads_glob_count, writes_glob_count, decision_refs_count, acceptance_refs_count`. `pack_bytes` = `JSON.stringify(packResult).length`; `pack_lines` = pack markdown line count; `pack_sections` = number of `## ` headings in the pack; the four `*_count` columns = cardinality of the corresponding task-field arrays. One row per corpus task.
- **`verify-success-rate.csv`** — columns: `phase_id, task_id, first_pass, retries, verify_runs_total`. `first_pass` = true if `done` came from the first verify attempt (no `failed` events between `started` and `done`); `retries` = count of `failed` or `blocked → resumed` cycles before the final `done`; `verify_runs_total` = `retries + 1`. Tasks without a `done` event are omitted.
- **`task-event-density.csv`** — columns: `phase_id, task_id, started, blocked, resumed, done, failed, total_events, event_span_days`. One column per status enum; `total_events` = sum of the status columns; `event_span_days` = decimal days between first and last event (0 if same day).
- **`lint-issue-histogram.csv`** — columns: `phase_id, code, severity, count`. One row per (phase, code) pair; `count: 0` rows omitted; sorted `phase_id ASC, code ASC` for deterministic diffs.
- **`measurements.manifest.json`** (sibling) — single object: `harness_version`, `input_git_sha`, `code_pact_cli_version`, `generated_at` (date only), `csv_files` (array of the four CSV names).

## Invocation surface

`pnpm harness --corpus <path>` (a `scripts` entry, **not** `bin`; invokes `node --import tsx scripts/harness/run.ts`). Default mode is `--check` (print CSV to stdout, write nothing); `--write` is opt-in and persists to `design/measurements/`; `--json` is quiet mode for CI. No `--force` — overwriting existing CSVs is safe because they are deterministic.

## Alternatives considered

- **Public `code-pact harness` command, or hidden `npx code-pact harness`** — rejected; both conflate product surface with maintainer tooling and invite user expectation of a stable metric set. `scripts/` is the standard home for tools that aren't products.
- **Stream to OpenTelemetry / Prometheus** — rejected; out of charter, expands surface and dependencies for no user benefit.
- **`now()` timestamps in CSV cells** — rejected; breaks cross-run diff-ability. The manifest's `generated_at` date covers traceability.
- **Measure LLM-side metrics (token cost, latency)** — rejected; requires a model API and breaks the deterministic-input rule. Separate future RFC if needed.
- **Gitignore `design/measurements/`** — rejected; committing the CSVs is the whole point (future RFCs cite specific row values).

## Open questions / deferred

- **External sample-repo measurements** — P20-T3 wires the harness but ships only against the dogfood corpus in v1.10; curated sample repos with baselines come later.
- **Metric trends over time** (delta CSVs reading prior runs) — v1.10 is single-snapshot only.
- **LLM-side metrics** (token cost, latency, API-driven retries) — separate RFC; needs network + external deps.
- **An RFC-citation tool** auto-embedding CSV rows into `design/decisions/*.md` — manual citation suffices for v1.10.
- No open questions at proposal time: the metric set, column shapes, manifest shape, invocation, and "internal-only, not in `bin`" stance were all settled during P20-T1 drafting. Implementation may surface edge cases warranting an amendment.

## References

- RFCs: [task-readiness-schema](task-readiness-schema-rfc.md) (P10) · [lightweight-runbook](lightweight-runbook-rfc.md) (P12) · [governance](governance-rfc.md) (P14).
- Docs: [docs/concepts/evidence-harness.md](../../docs/concepts/evidence-harness.md).
