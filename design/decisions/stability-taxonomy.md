# Decision: Stability taxonomy and v1.0 public contract freeze

**Status:** accepted (v1.0.0, 2026-05)
**Scope:** every command surface exposed by `code-pact`
**Owners:** maintainer

## Context

Through v0.5 → v0.9, `code-pact` shipped a growing CLI surface (init, plan, phase, task, recommend, adapter, doctor, validate, …) without a formal stability classification. Every minor release was free to rename flags, change JSON envelope shapes, and reword error codes. That was acceptable during the alpha — there was no broad consumer base — but it blocks the project from being usable as a build-time dependency or in CI pipelines that pin a version.

P8 was framed explicitly as "stabilize the control plane rather than add new features." A stability taxonomy was the load-bearing artifact of that phase.

## Decision

Every command and every observable behaviour is classified into one of four stability bands. The classification is recorded in `docs/cli-contract.md` and applies from v1.0.0 forward.

| Band | What it promises |
| --- | --- |
| **Stable (v1.0)** | Flags, exit codes, JSON envelope shape, error code names, and stdout/stderr stream choice are frozen across the v1.x line. Additive changes (new fields in `data`, new optional flags) are allowed. Removing or renaming requires a v2 cut. |
| **Stable (human-output)** | Same flag / exit-code freeze, but the command does not emit `--json` (it's human-readable only). The human stdout/stderr is documented and tested for `--non-interactive` CONFIG_ERROR behaviour. |
| **Experimental** | Ships and works, but the contract may shift in minor releases to track upstream tooling changes (typical example: the `cursor` and `gemini-cli` adapters). |
| **Deprecated** | Continues to work for one release cycle with a one-line stderr deprecation notice; removal target is recorded in the doc. |

The full classification table is in [`docs/cli-contract.md` § Stability taxonomy](../../docs/cli-contract.md#stability-taxonomy-v10). The error code surface is locked by `tests/unit/error-code-surface.test.ts`. JSON-only-on-stdout is asserted for every `Stable (v1.0)` command by `tests/integration/json-stdout.test.ts`.

## Consequences

**Accepted costs**

- Any later change that touches a `Stable (v1.0)` surface either has to be additive or has to wait for v2. Reviewers must check this on every PR (the PR template's Contract checklist exists for this reason).
- Adapter generators that produce different output than v1.0.0 trigger `ADAPTER_GENERATOR_STALE` (warning, not error). The dogfood `claude-code` manifest on this repo carries that warning across patch releases (e.g. v1.0.0 → v1.0.1) and is the documented "this is normal" path.
- The `cursor` and `gemini-cli` adapters remain Experimental in v1.0 because upstream `.cursorrules` / `.mdc` and `GEMINI.md` formats are themselves moving targets. Promoting either to Stable requires a separate decision.

**Accepted gains**

- Downstream consumers can pin `code-pact@^1.0.0` and rely on flag shapes, exit codes, and error codes being identical across patches and minor releases.
- CI scripts that branch on `error.code` keep working without source changes.
- `docs/migration.md` becomes useful — the v0.6 / v0.7 / v0.8 / v0.9 → v1.0 path is documented because there is now a "v1.0" to migrate to.

## Alternatives considered

- **No formal taxonomy, just a "stable enough" README badge.** Rejected because it does not constrain reviewers; every PR re-litigates whether a flag rename is acceptable.
- **Per-command stability annotations only, no global bands.** Rejected because it makes documentation hard to scan and gives no default classification for new commands.
- **Adopt SemVer 2.0 without further structure.** SemVer alone does not say *what* counts as a breaking change for a CLI. The taxonomy fills that gap: a JSON envelope shape change is breaking; an additive `data` field is not.

## References

- [`docs/cli-contract.md` § Stability taxonomy (v1.0)](../../docs/cli-contract.md#stability-taxonomy-v10)
- [`docs/migration.md`](../../docs/migration.md) — applies the taxonomy to the v0.6 → v1.0 upgrade path
- `design/phases/P8-stable-control-plane.yaml` — the phase that produced this decision
- `CHANGELOG.md` — v1.0.0 entry separates `CLI behavior changes: none` and `Release channel changes` explicitly, matching this decision
