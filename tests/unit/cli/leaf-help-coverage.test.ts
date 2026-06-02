// P52 — leaf help coverage for the non-task clusters.
//
// task is CommandSpec-backed and pinned by task-lifecycle-help-terms.test.ts.
// plan / phase / adapter still hand-write (or stub) their help. This test makes
// the current state visible and stops it regressing: a command that an agent
// drives — mutating, or JSON-emitting — must answer `--help` with rich help
// (a real synopsis), not the 2-line stub. Commands still on the stub are listed
// in STUB_ALLOWLIST so the gap is explicit, not silent; as each is filled
// (P52 step 2) it is removed from the allowlist and the test tightens.
//
// Pure: drives subcommandUsage() — no CLI spawn, no build.

import { describe, it, expect } from "vitest";
import { subcommandUsage } from "../../../src/cli/usage.ts";

// The second line of the 2-line stub (subcommandStub). Rich help omits it.
const STUB_MARKER = "for the full subcommand list.";

type Cmd = {
  cluster: "plan" | "phase" | "adapter";
  sub: string;
  /** Mutates files/state (writes a doc, flips YAML, installs an adapter, …). */
  mutating: boolean;
  /** Accepts --json. */
  json: boolean;
};

// The non-task cluster surface, classified (see the P52 audit). `plan import`
// is an alias for `phase import`: this pure-function test can't see the alias
// (the routing lives in cmdPlan's dispatch, not subcommandUsage), so it is
// excluded here and covered by cli-help.test.ts at the built-CLI level. Bare
// `adapter` is an error, not a subcommand, and is excluded.
const COMMANDS: Cmd[] = [
  // plan
  { cluster: "plan", sub: "brief", mutating: true, json: true },
  { cluster: "plan", sub: "prompt", mutating: false, json: true },
  { cluster: "plan", sub: "adopt", mutating: true, json: true },
  { cluster: "plan", sub: "constitution", mutating: true, json: true },
  { cluster: "plan", sub: "lint", mutating: false, json: true },
  { cluster: "plan", sub: "normalize", mutating: true, json: true },
  { cluster: "plan", sub: "analyze", mutating: false, json: true },
  // phase
  { cluster: "phase", sub: "add", mutating: true, json: true },
  { cluster: "phase", sub: "new", mutating: true, json: false },
  { cluster: "phase", sub: "ls", mutating: false, json: true },
  { cluster: "phase", sub: "show", mutating: false, json: true },
  { cluster: "phase", sub: "import", mutating: true, json: true },
  { cluster: "phase", sub: "reconcile", mutating: true, json: true },
  { cluster: "phase", sub: "runbook", mutating: false, json: true },
  // adapter
  { cluster: "adapter", sub: "list", mutating: false, json: true },
  { cluster: "adapter", sub: "install", mutating: true, json: true },
  { cluster: "adapter", sub: "upgrade", mutating: true, json: true },
  { cluster: "adapter", sub: "doctor", mutating: false, json: true },
  { cluster: "adapter", sub: "conformance", mutating: false, json: true },
];

// Commands still on the 2-line stub. Each line here is a known gap, not a
// silent one. Removing an entry (after writing its rich help) tightens the
// test — that is the P52 step-2 mechanism. Keep this list shrinking, never
// growing: a new mutating/JSON command must ship with rich help, not an
// allowlist entry.
const STUB_ALLOWLIST = new Set<string>([
  // Read-only commands still on the stub (P52 step 2 filled the mutating ones).
  // These remain a known, listed gap — fill them in a later pass and remove the
  // entry. The list only shrinks.
  "plan lint",
  "plan analyze",
  "phase ls",
  "phase show",
  "phase runbook",
  "adapter list",
  "adapter doctor",
  "adapter conformance",
]);

const key = (c: Cmd) => `${c.cluster} ${c.sub}`;
const isRich = (c: Cmd) => !subcommandUsage(c.cluster, c.sub).includes(STUB_MARKER);

describe("leaf help coverage — non-task clusters (P52)", () => {
  // A command an agent drives (mutating or JSON-emitting) must be rich, unless
  // it is an explicit, listed gap. This is the regression guard: a *new* such
  // command can't silently ship as a stub.
  it.each(COMMANDS.filter((c) => c.mutating || c.json))(
    "`$cluster $sub` is rich help, or an explicit allowlisted stub",
    (c) => {
      if (STUB_ALLOWLIST.has(key(c))) {
        // Still a stub by design — assert it really is one, so the allowlist
        // can't rot (an entry that became rich should be removed).
        expect(isRich(c)).toBe(false);
      } else {
        expect(isRich(c)).toBe(true);
      }
    },
  );

  // A rich, JSON-emitting command must document --json (agents look for it).
  it.each(COMMANDS.filter((c) => c.json && !STUB_ALLOWLIST.has(`${c.cluster} ${c.sub}`)))(
    "`$cluster $sub` rich help documents --json",
    (c) => {
      expect(subcommandUsage(c.cluster, c.sub)).toContain("--json");
    },
  );

  // The allowlist must not reference unknown commands (keeps it honest as the
  // surface evolves).
  it("STUB_ALLOWLIST only names real commands", () => {
    const known = new Set(COMMANDS.map(key));
    for (const entry of STUB_ALLOWLIST) {
      expect(known.has(entry)).toBe(true);
    }
  });
});
