// P41-T1 — help-coverage test for the task lifecycle verbs.
//
// Agents read leaf `--help` as an exploration surface. Before P41, 7 task verbs
// fell back to a 2-line stub while 4 were rich. This pins every rich task verb
// to a small required-term set so a verb cannot silently regress to a stub, and
// guards the help-vs-real-flags drift the stub check can't catch (the term sets
// name the verbs' actual flags). Modeled on record-done-help-terms.test.ts:
// assert short, stable tokens (single-line, so wrapping doesn't break matches)
// via subcommandUsage — pure, no CLI spawn, no build.

import { describe, it, expect } from "vitest";
import { subcommandUsage } from "../../../src/cli/usage.ts";

// The second line of the 2-line stub (subcommandStub). A rich help must NOT
// contain it — the canonical "did not regress to a stub" check.
const STUB_MARKER = 'for the full subcommand list.';

// Per-verb required terms: the Usage line, the verb's documented flags, and a
// purpose phrase. `task add` is pinned thickly (it is the bloat/thin-help risk
// and has the most flags + the wizard/required-with-description rules).
const REQUIRED_TERMS: Record<string, readonly string[]> = {
  add: [
    "Usage: code-pact task add <phase-id>",
    "wizard",
    "--description",
    "requires --type",
    "--type",
    "--id",
    "--depends-on",
    "--decision-ref",
    "--read",
    "--write",
    "--acceptance-ref",
    "--ambiguity",
    "--verification-strength",
    "--json",
    "phase import",
  ],
  context: [
    "Usage: code-pact task context <task-id>",
    "Read-only",
    "--agent",
    "--explain",
    "--budget-bytes",
    "--json",
    "CONTEXT_OVER_BUDGET",
  ],
  start: [
    "Usage: code-pact task start <task-id>",
    "started",
    "Idempotent",
    "--agent",
    "--json",
  ],
  status: [
    "Usage: code-pact task status <task-id>",
    "derived state",
    "Read-only",
    "--json",
  ],
  block: [
    "Usage: code-pact task block <task-id>",
    "--reason",
    "required",
    "resumed", // points at `task resume`
    "--agent",
  ],
  resume: [
    "Usage: code-pact task resume <task-id>",
    "resumed",
    "blocked",
    "--agent",
  ],
  runbook: [
    "Usage: code-pact task runbook <task-id>",
    "next-steps",
    "Read-only",
    "task next", // documents the alias
    "--json",
  ],
  // The 4 pre-existing rich verbs — keep them rich (anchor flag/term each).
  prepare: ["Usage: code-pact task prepare <task-id>", "--budget-bytes", "Read-only"],
  complete: ["Usage: code-pact task complete <task-id>", "--dry-run", "record-done"],
  "record-done": ["Usage: code-pact task record-done <task-id>", "--evidence", "record_only"],
  finalize: ["Usage: code-pact task finalize <task-id>", "--audit-strict", "--write"],
};

const VERBS = Object.keys(REQUIRED_TERMS);

describe("task lifecycle verbs have rich --help (P41)", () => {
  it.each(VERBS)("`task %s --help` is not the 2-line stub", (verb) => {
    expect(subcommandUsage("task", verb)).not.toContain(STUB_MARKER);
  });

  it.each(
    VERBS.flatMap((verb) => REQUIRED_TERMS[verb]!.map((term) => [verb, term] as const)),
  )("`task %s --help` includes %j", (verb, term) => {
    expect(subcommandUsage("task", verb)).toContain(term);
  });
});
