// P38-T3 — required-term test for `task record-done --help`.
//
// The last blocker of the 1.26.0 review was that this help text still framed
// record-done as external-completion-only after `record_only` became a
// first-class lane (P33). The prose docs were reconciled rounds earlier, but
// the CLI help — which users and agents read directly — lagged. This pins the
// reconciled vocabulary so the help cannot silently regress to the old framing.
//
// Modeled on the existing adapter-conformance required-term checks: assert the
// presence of short, stable tokens (single-line, so line wrapping doesn't break
// the match) rather than matching whole sentences.

import { describe, it, expect } from "vitest";
import { subcommandUsage } from "../../../src/cli/usage.ts";

const help = subcommandUsage("task", "record-done");

// Both uses must be present (the dual-use framing P33 introduced) along with
// the "no verification, evidence is the proof" semantics.
const REQUIRED_TERMS: readonly string[] = [
  "WITHOUT running task complete's verification",
  "externally completed work",
  "lifecycleMode: record_only",
  "does NOT run verification",
  "Completion proof",
  "--evidence",
];

// The pre-P33 framing that must NOT come back.
const FORBIDDEN_TERMS: readonly string[] = [
  "for work completed OUTSIDE the code-pact loop",
  "Evidence for the externally-completed work",
];

describe("task record-done --help reflects the record_only lane", () => {
  it.each(REQUIRED_TERMS)("includes %j", (term) => {
    expect(help).toContain(term);
  });

  it.each(FORBIDDEN_TERMS)("does not regress to the external-only framing: %j", (term) => {
    expect(help).not.toContain(term);
  });
});
