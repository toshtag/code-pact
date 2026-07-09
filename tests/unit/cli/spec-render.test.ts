// P46 — the CommandSpec single-source invariants.
//
// CommandSpec is the one place a task command's flag surface is declared;
// toParseOptions/renderLeafHelp/renderReference derive parse, help, and docs
// from it. These tests pin that derivation so the three surfaces cannot drift
// from the spec (the failure mode that the old three-hand-written-copies setup
// allowed). They do NOT pin runtime semantics — required enforcement and
// example runnability are covered by command/contract tests, by design.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ADAPTER_SPECS } from "../../../src/cli/spec/adapter.ts";
import { ROOT_SPECS } from "../../../src/cli/spec/root.ts";
import { PLAN_SPECS } from "../../../src/cli/spec/plan.ts";
import { PHASE_SPECS } from "../../../src/cli/spec/phase.ts";
import { TASK_SPECS } from "../../../src/cli/spec/task.ts";
import {
  toParseOptions,
  renderLeafHelp,
  renderReference,
} from "../../../src/cli/spec/render.ts";

const ALL_SPECS = [
  ...Object.entries(ROOT_SPECS).map(([name, spec]) => [name, spec, name] as const),
  ...Object.entries(PLAN_SPECS).map(([name, spec]) => [name, spec, `plan ${name}`] as const),
  ...Object.entries(PHASE_SPECS).map(([name, spec]) => [name, spec, `phase ${name}`] as const),
  ...Object.entries(ADAPTER_SPECS).map(([name, spec]) => [name, spec, `adapter ${name}`] as const),
  ...Object.entries(TASK_SPECS).map(([name, spec]) => [name, spec, `task ${name}`] as const),
];

describe("CommandSpec derivation (P46)", () => {
  it.each(ALL_SPECS)("`%s` toParseOptions maps flags to parseArgs config", (_name, spec) => {
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

  it.each(ALL_SPECS)("`%s` help carries the Usage line, every flag, and examples", (_name, spec, label) => {
    const help = renderLeafHelp(spec);
    expect(help).toContain(`Usage: code-pact ${label}`);
    if (spec.positional) expect(help).toContain(spec.positional);
    for (const f of spec.flags) expect(help).toContain(`--${f.name}`);
    expect(help).toContain("Examples:");
    for (const ex of spec.examples) expect(help).toContain(ex);
    if (spec.readOnly) expect(help).toContain("Read-only");
  });

  it.each(ALL_SPECS)("`%s` reference carries the heading, every flag, and examples", (_name, spec, label) => {
    const ref = renderReference(spec);
    expect(ref).toContain(`### \`${label}\``);
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

  describe("plan parse surfaces", () => {
    it("plan brief covers exactly the parser-backed flags", () => {
      expect(Object.keys(toParseOptions(PLAN_SPECS.brief)).sort()).toEqual(
        [
          "differentiator",
          "force",
          "from-file",
          "json",
          "stdin",
          "what",
          "who",
        ].sort(),
      );
    });

    it("plan constitution marks --principle repeatable", () => {
      const opts = toParseOptions(PLAN_SPECS.constitution);
      expect(opts.principle).toEqual({ type: "string", multiple: true });
      expect(Object.keys(opts).sort()).toEqual(
        ["description", "force", "from-file", "json", "principle", "stdin"].sort(),
      );
    });

    it("plan sync-paths marks --rename repeatable", () => {
      const opts = toParseOptions(PLAN_SPECS["sync-paths"]);
      expect(opts.rename).toEqual({ type: "string", multiple: true });
      expect(Object.keys(opts).sort()).toEqual(["json", "rename", "write"].sort());
    });

    it("plan lint and analyze rich help are not generic stubs", () => {
      expect(renderLeafHelp(PLAN_SPECS.lint)).toContain("--include-quality");
      expect(renderLeafHelp(PLAN_SPECS.analyze)).toContain("--include-historical");
      expect(renderReference(PLAN_SPECS.lint)).toContain("code-pact plan lint --json");
      expect(renderReference(PLAN_SPECS.analyze)).toContain("code-pact plan analyze --json");
    });
  });

  describe("phase parse surfaces", () => {
    it("phase add covers exactly the parser-backed flags", () => {
      const opts = toParseOptions(PHASE_SPECS.add);
      expect(opts["verify-command"]).toEqual({ type: "string", multiple: true });
      expect(opts["done-criterion"]).toEqual({ type: "string", multiple: true });
      expect(Object.keys(opts).sort()).toEqual(
        [
          "confidence",
          "done-criterion",
          "id",
          "json",
          "name",
          "non-interactive",
          "objective",
          "risk",
          "verify-command",
          "weight",
        ].sort(),
      );
    });

    it("phase archive and import keep repeatable/alias-sensitive flags in the canonical specs", () => {
      expect(toParseOptions(PHASE_SPECS.archive).attest).toEqual({
        type: "string",
        multiple: true,
      });
      expect(Object.keys(toParseOptions(PHASE_SPECS.import)).sort()).toEqual(
        ["force", "json", "scaffold-decisions", "strict"].sort(),
      );
    });

    it("phase reference renders flags and examples for representative specs", () => {
      expect(renderReference(PHASE_SPECS.import)).toContain("code-pact phase import design/roadmap-draft.yaml --json");
      expect(renderReference(PHASE_SPECS.runbook)).toContain("`--across-phases`");
      expect(renderLeafHelp(PHASE_SPECS.ls)).toContain("--status");
    });
  });

  describe("adapter parse surfaces", () => {
    it("adapter install covers exactly the parser-backed flags", () => {
      expect(Object.keys(toParseOptions(ADAPTER_SPECS.install)).sort()).toEqual(
        ["force", "json", "model", "regen-skills"].sort(),
      );
    });

    it("adapter upgrade covers exactly the parser-backed flags", () => {
      expect(Object.keys(toParseOptions(ADAPTER_SPECS.upgrade)).sort()).toEqual(
        [
          "accept-modified",
          "check",
          "force",
          "json",
          "model",
          "regen-skills",
          "write",
        ].sort(),
      );
    });

    it("adapter read-only specs and representative help render their key flags and examples", () => {
      expect(ADAPTER_SPECS.list.readOnly).toBe(true);
      expect(ADAPTER_SPECS.doctor.readOnly).toBe(true);
      expect(ADAPTER_SPECS.conformance.readOnly).toBe(true);
      expect(renderLeafHelp(ADAPTER_SPECS.doctor)).toContain("--agent");
      expect(renderReference(ADAPTER_SPECS.install)).toContain("code-pact adapter install claude-code --json");
      expect(renderReference(ADAPTER_SPECS.upgrade)).toContain("`--accept-modified`");
    });
  });

  it("generated reference uses H2 groups and H3 command entries", () => {
    const doc = readFileSync(new URL("../../../docs/cli-reference.generated.md", import.meta.url), "utf8");
    expect(doc).toContain("## Task commands\n\n### `task add`");
    expect(doc).toContain("## Plan commands\n\n### `plan brief`");
    expect(doc).toContain("## Phase commands\n\n### `phase add`");
    expect(doc).toContain("## Adapter commands\n\n### `adapter list`");
    expect(doc).not.toMatch(/## (Task|Plan|Phase|Adapter) commands\n\n## `/);
  });

  it("required is presentation-only: it does not appear in parseArgs config", () => {
    // A synthetic spec with a required flag must still produce a plain
    // string/boolean parseArgs entry — no "required" key leaks through.
    const opts = toParseOptions({
      cluster: "root",
      command: "synthetic",
      summary: "x",
      flags: [{ name: "reason", value: "<text>", required: true, description: "why" }],
      examples: [],
    });
    expect(opts.reason).toEqual({ type: "string" });
    expect("required" in opts.reason!).toBe(false);
  });
});
