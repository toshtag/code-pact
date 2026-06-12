import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as cliRun, ensureCliBuilt, type RunResult } from "../helpers/cli.ts";
import { checkDocLinks } from "../../scripts/check-doc-links.ts";

// design-docs-ephemeral step 7 PR-B2 — `decision retire --write`, the complex
// destructive verb. End-to-end via the real CLI: write the v2.0 decision-state
// record, then delete the .md; rewrite NO links (PR-A resolves the unchanged
// inbound link as retired); the status-sensitive referencing gate carries an
// accepted decision_refs gate, softens an acceptance_refs at any status, and never
// carries a filename-scan gate. prune is unchanged.

let tmpDir: string;
function run(args: string[]): RunResult {
  return cliRun(tmpDir, args);
}
function json(r: RunResult): { ok?: boolean; data?: Record<string, unknown>; error?: { code?: string } } {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}

const XREF = "design/decisions/x-rfc.md";
const ACCEPTED = "# RFC: X\n\n**Status:** accepted (P1, 2026-06)\n\n## Decision\n\nSettled.\n";
const BLOCKED = "# RFC: X\n\n**Status:** proposed\n\n## Decision\n\nNot yet settled.\n";

const TASK_FIELDS = `    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short`;

const ROADMAP = `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 1\n`;

/** A phase whose single active task references X via `refField` (or none). */
function phase(refField: "decision_refs" | "acceptance_refs" | "none"): string {
  const requires = refField === "decision_refs" ? "true" : "false";
  const refBlock =
    refField === "none"
      ? ""
      : `    ${refField}:\n      - ${XREF}\n`;
  return `id: P1
name: P1
weight: 1
confidence: high
risk: low
status: in_progress
objective: An objective long enough here
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - "true"
tasks:
  - id: P1-T1
    type: feature
${TASK_FIELDS}
    status: in_progress
    description: Implements the thing
    requires_decision: ${requires}
${refBlock}`;
}

async function scaffold(opts: { adr?: string; refField?: "decision_refs" | "acceptance_refs" | "none" } = {}): Promise<void> {
  const init = run(["init", "--non-interactive", "--locale", "en-US", "--agent", "claude-code", "--json"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stdout}${init.stderr}`);
  await mkdir(join(tmpDir, "design", "decisions"), { recursive: true });
  await mkdir(join(tmpDir, "design", "phases"), { recursive: true });
  await writeFile(join(tmpDir, "design", "roadmap.yaml"), ROADMAP, "utf8");
  await writeFile(join(tmpDir, "design", "phases", "P1.yaml"), phase(opts.refField ?? "decision_refs"), "utf8");
  await writeFile(join(tmpDir, XREF), opts.adr ?? ACCEPTED, "utf8");
}

const X_MD = () => join(tmpDir, XREF);
const RECORD_DIR = () => join(tmpDir, ".code-pact", "state", "archive", "decisions");
const fileExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};
async function recordCount(): Promise<number> {
  try {
    return (await import("node:fs/promises").then((m) => m.readdir(RECORD_DIR()))).length;
  } catch {
    return 0;
  }
}

beforeAll(() => ensureCliBuilt(), 60_000);
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "code-pact-decision-retire-int-"));
});
afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("decision retire — dry-run + write (accepted, active decision_refs)", () => {
  it("dry-run → would_retire, writes nothing", async () => {
    await scaffold();
    const r = run(["decision", "retire", XREF, "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("would_retire");
    expect(await fileExists(X_MD())).toBe(true);
    expect(await recordCount()).toBe(0);
  });

  it("--write → retired: record written, .md deleted, the active gate still resolves via the record (A3)", async () => {
    await scaffold();
    const r = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("retired");
    expect(await fileExists(X_MD())).toBe(false);
    expect(await recordCount()).toBe(1);
    // The accepted record carries the active decision_refs gate after the .md is gone.
    const verify = run(["verify", "--phase", "P1", "--task", "P1-T1", "--json"]);
    const checks = (JSON.parse(verify.stdout) as { data?: { checks?: { name: string; ok: boolean }[] } }).data?.checks ?? [];
    expect(checks.find((c) => c.name === "decision")?.ok).toBe(true);
    expect(JSON.parse(run(["plan", "lint", "--strict", "--json"]).stdout).ok).toBe(true);
  });

  it("idempotent re-run → already_retired (exit 0, no second record/delete)", async () => {
    await scaffold();
    expect(run(["decision", "retire", XREF, "--write", "--json"]).code).toBe(0);
    const again = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(again.code).toBe(0);
    expect(json(again).data?.kind).toBe("already_retired");
  });

  it("HUMAN mode (no --json) prints a sentence, NOT a raw JSON envelope", async () => {
    await scaffold();
    const dry = run(["decision", "retire", XREF]); // no --json
    expect(dry.code).toBe(0);
    expect(dry.stdout).not.toMatch(/^\s*\{/); // not a JSON object dump
    expect(dry.stdout).toMatch(/would retire/i);
    const w = run(["decision", "retire", XREF, "--write"]); // no --json
    expect(w.code).toBe(0);
    expect(w.stdout).not.toMatch(/^\s*\{/);
    expect(w.stdout).toMatch(/Retired/i);
  });
});

describe("decision retire — status-sensitive referencing gate", () => {
  it("blocked decision + active decision_refs → NOT_ELIGIBLE (referencing_task_not_done), nothing written", async () => {
    await scaffold({ adr: BLOCKED, refField: "decision_refs" });
    const r = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("DECISION_RETIRE_NOT_ELIGIBLE");
    expect((json(r).data?.blocks as { gate: string }[]).some((b) => b.gate === "referencing_task_not_done")).toBe(true);
    expect(await fileExists(X_MD())).toBe(true);
  });

  it("blocked decision + active acceptance_refs → retire succeeds (any valid record softens); gate semantics unchanged", async () => {
    await scaffold({ adr: BLOCKED, refField: "acceptance_refs" });
    const r = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("retired");
    expect(await fileExists(X_MD())).toBe(false);
    // The record is may_satisfy:false (non-accepted) — it softens the acceptance lint
    // but releases no gate. plan lint --strict stays green; validate stays green.
    expect(JSON.parse(run(["plan", "lint", "--strict", "--json"]).stdout).ok).toBe(true);
    expect(JSON.parse(run(["validate", "--json"]).stdout).ok).toBe(true);
  });

  it("blocked decision NOT referenced by any active task → retire succeeds", async () => {
    await scaffold({ adr: BLOCKED, refField: "none" });
    const r = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(r.code).toBe(0);
    expect(json(r).data?.kind).toBe("retired");
  });
});

describe("decision retire — NO link rewrite (Option A; PR-A resolves the link)", () => {
  it("inbound links stay byte-identical; check:docs green incl. a #fragment link", async () => {
    await scaffold();
    const readme = "# Project\n\nSee [the X decision](design/decisions/x-rfc.md) and\n[its decision section](design/decisions/x-rfc.md#decision).\n";
    await writeFile(join(tmpDir, "README.md"), readme, "utf8");

    expect(run(["decision", "retire", XREF, "--write", "--json"]).code).toBe(0);

    // (a) the inbound-link source is byte-identical — retire rewrote nothing.
    expect(await readFile(join(tmpDir, "README.md"), "utf8")).toBe(readme);
    // (b/c) the doc-link checker (PR-A) resolves the now-deleted .md AND its #fragment
    // link as retired via the record → green (exit code 0).
    const code = await checkDocLinks({ repoRoot: tmpDir, stdout: { write: () => true }, stderr: { write: () => true } });
    expect(code).toBe(0);
  });
});

describe("decision retire — fail-closed presence + idempotency edges", () => {
  it("missing .md + no record → NOT_RETIRED (fail-closed)", async () => {
    await scaffold();
    await rm(X_MD());
    const r = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("DECISION_RETIRE_NOT_RETIRED");
  });

  it("final-component symlink → STALE, refused before any delete", async () => {
    await scaffold();
    const real = join(tmpDir, "design", "decisions", "real.md");
    await writeFile(real, ACCEPTED, "utf8");
    await rm(X_MD());
    await symlink(real, X_MD());
    const r = run(["decision", "retire", XREF, "--write", "--json"]);
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("DECISION_RETIRE_STALE");
    expect(await fileExists(real)).toBe(true); // target untouched
  });

  it("lock contention → LOCK_HELD", async () => {
    await scaffold();
    await mkdir(join(tmpDir, ".code-pact", "locks"), { recursive: true });
    await writeFile(
      join(tmpDir, ".code-pact", "locks", "write.lock"),
      JSON.stringify({ pid: 999999, hostname: "other", cmd: "x", created_at: "2026-06-01T00:00:00.000Z" }),
      { flag: "wx" },
    );
    const r = cliRun(tmpDir, ["decision", "retire", XREF, "--write", "--json"], { env: { CODE_PACT_DISABLE_LOCKS: "" } });
    expect(r.code).toBe(2);
    expect(json(r).error?.code).toBe("LOCK_HELD");
  });
});

describe("decision retire — help + prune regression guard", () => {
  it("decision --help lists retire; decision retire --help documents --write + dry-run default", async () => {
    expect(run(["decision", "--help"]).stdout).toMatch(/\bretire\b/);
    const h = run(["decision", "retire", "--help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/--write/);
    expect(h.stdout).toMatch(/DRY-RUN BY DEFAULT/);
  });

  it("prune still works unchanged on an accepted decision (post-extraction regression guard)", async () => {
    await scaffold({ refField: "none" }); // no active task references it
    const r = run(["decision", "prune", XREF, "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(JSON.parse(r.stdout).data.eligible).toBe(true);
  });
});
