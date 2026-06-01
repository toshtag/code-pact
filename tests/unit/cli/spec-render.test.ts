// P46 — the CommandSpec single-source invariants.
//
// CommandSpec is the one place a task command's flag surface is declared;
// toParseOptions/renderLeafHelp/renderReference derive parse, help, and docs
// from it. These tests pin that derivation so the three surfaces cannot drift
// from the spec (the failure mode that the old three-hand-written-copies setup
// allowed). They do NOT pin runtime semantics — required enforcement and
// example runnability are covered by command/contract tests, by design.

import { describe, it, expect } from "vitest";
import { TASK_SPECS } from "../../../src/cli/spec/task.ts";
import {
  toParseOptions,
  renderLeafHelp,
  renderReference,
} from "../../../src/cli/spec/render.ts";

const SPECS = Object.entries(TASK_SPECS);

describe("CommandSpec derivation (P46)", () => {
  it.each(SPECS)("`task %s` toParseOptions maps flags to parseArgs config", (_name, spec) => {
    const opts = toParseOptions(spec);
    expect(Object.keys(opts)).toEqual(spec.flags.map((f) => f.name));
    for (const f of spec.flags) {
      const entry = opts[f.name]!;
      // value present → string; absent → boolean.
      expect(entry.type).toBe(f.value ? "string" : "boolean");
      // repeatable → multiple:true; otherwise multiple is unset.
      expect(entry.multiple ?? false).toBe(f.repeatable ?? false);
    }
  });

  it.each(SPECS)("`task %s` help carries the Usage line, every flag, and examples", (name, spec) => {
    const help = renderLeafHelp(spec);
    expect(help).toContain(`Usage: code-pact task ${name}`);
    if (spec.positional) expect(help).toContain(spec.positional);
    for (const f of spec.flags) expect(help).toContain(`--${f.name}`);
    expect(help).toContain("Examples:");
    for (const ex of spec.examples) expect(help).toContain(ex);
    if (spec.readOnly) expect(help).toContain("Read-only");
  });

  it.each(SPECS)("`task %s` reference carries the heading, every flag, and examples", (name, spec) => {
    const ref = renderReference(spec);
    expect(ref).toContain(`## \`task ${name}\``);
    for (const f of spec.flags) expect(ref).toContain(`\`--${f.name}\``);
    for (const ex of spec.examples) expect(ref).toContain(ex);
  });

  // `task add` is the highest-risk port (stdlib parseArgs directly, the largest
  // mixed required/repeatable flag set). Pin its parse surface specifically:
  // the spec must reproduce the exact options the hand-written literal had.
  describe("task add parse surface (P46 step 2)", () => {
    const opts = toParseOptions(TASK_SPECS.add!);

    it("repeatable flags map to multiple:true", () => {
      for (const name of ["depends-on", "decision-ref", "read", "write", "acceptance-ref"]) {
        expect(opts[name]).toEqual({ type: "string", multiple: true });
      }
    });

    it("string-valued flags are string, no multiple", () => {
      for (const name of ["description", "type", "id", "ambiguity", "risk", "context-size", "write-surface", "verification-strength", "expected-duration"]) {
        expect(opts[name]).toEqual({ type: "string" });
      }
    });

    it("--json is boolean", () => {
      expect(opts.json).toEqual({ type: "boolean" });
    });

    it("covers exactly the 15 documented flags (no addition, no drop)", () => {
      expect(Object.keys(opts).sort()).toEqual(
        [
          "acceptance-ref", "ambiguity", "context-size", "decision-ref",
          "depends-on", "description", "expected-duration", "id", "json",
          "read", "risk", "type", "verification-strength", "write", "write-surface",
        ].sort(),
      );
    });
  });

  it("required is presentation-only: it does not appear in parseArgs config", () => {
    // A synthetic spec with a required flag must still produce a plain
    // string/boolean parseArgs entry — no "required" key leaks through.
    const opts = toParseOptions({
      cluster: "task",
      command: "synthetic",
      summary: "x",
      flags: [{ name: "reason", value: "<text>", required: true, description: "why" }],
      examples: [],
    });
    expect(opts.reason).toEqual({ type: "string" });
    expect("required" in opts.reason!).toBe(false);
  });
});
