// `decision prune` (dry-run) CLI contract — built-CLI integration.
// PR-C1b: public command, JSON envelopes, exit codes. No --write yet.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createTempProject,
  ensureCliBuilt,
  expectJsonOk,
  expectJsonErr,
} from "../helpers/cli.ts";

beforeAll(() => ensureCliBuilt(), 60_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ACCEPTED = "# RFC\n\n**Status:** accepted\n\n## Decision\n\nbody";

const PHASE = (taskStatus: string, decisionRef: string) => `id: P1
name: P1
weight: 10
confidence: high
risk: low
status: ${taskStatus === "done" ? "done" : "planned"}
objective: An objective long enough
definition_of_done:
  - DoD that is clearly long enough
verification:
  commands:
    - pnpm test
tasks:
  - id: P1-T1
    type: feature
    ambiguity: low
    risk: low
    context_size: small
    write_surface: low
    verification_strength: medium
    expected_duration: short
    status: ${taskStatus}
    description: Implements the thing
    decision_refs:
      - ${decisionRef}
`;

async function project(decisionContent: string, taskStatus = "done") {
  const p = await createTempProject({ init: true, prefix: "decprune-int-" });
  cleanups.push(p.cleanup);
  await mkdir(join(p.dir, "design", "decisions"), { recursive: true });
  await mkdir(join(p.dir, "design", "phases"), { recursive: true });
  await writeFile(join(p.dir, "design", "decisions", "foo-rfc.md"), decisionContent);
  await writeFile(
    join(p.dir, "design", "roadmap.yaml"),
    `phases:\n  - id: P1\n    path: design/phases/P1.yaml\n    weight: 10\n`,
  );
  await writeFile(
    join(p.dir, "design", "phases", "P1.yaml"),
    PHASE(taskStatus, "design/decisions/foo-rfc.md"),
  );
  return p;
}

describe("decision prune — CLI (dry-run)", () => {
  it("eligible accepted target → exit 0, ok:true, data.eligible:true (JSON)", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    const env = expectJsonOk<{ eligible: boolean; mode: string }>(res);
    expect(env.data.eligible).toBe(true);
    expect(env.data.mode).toBe("dry-run");
    expect(res.code).toBe(0);
  });

  it("proposed target → exit 2, DECISION_PRUNE_NOT_ELIGIBLE with data.blocks", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    const env = expectJsonErr(res);
    expect(env.error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(Array.isArray((env.data as { blocks?: unknown[] }).blocks)).toBe(true);
    expect(res.code).toBe(2);
  });

  it("not-done referencing task → exit 2, DECISION_PRUNE_NOT_ELIGIBLE", async () => {
    const p = await project(ACCEPTED, "in_progress");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(res.code).toBe(2);
  });

  it("non-decision target → exit 2, DECISION_PRUNE_NOT_ELIGIBLE", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "docs/cli-contract.md", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    expect(res.code).toBe(2);
  });

  it("--write is not a flag yet → exit 2, CONFIG_ERROR", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--write", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("missing path → exit 2, CONFIG_ERROR", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("multiple paths → exit 2, CONFIG_ERROR", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "a.md", "b.md", "--json"]);
    expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    expect(res.code).toBe(2);
  });

  it("unreadable plan graph (invalid roadmap) → exit 2, plan_artifacts_unreadable", async () => {
    const p = await project(ACCEPTED, "done");
    await writeFile(join(p.dir, "design", "roadmap.yaml"), ":\n  not: [valid");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    const env = expectJsonErr(res);
    expect(env.error.code).toBe("DECISION_PRUNE_NOT_ELIGIBLE");
    const gates = ((env.data as { blocks?: { gate: string }[] }).blocks ?? []).map((b) => b.gate);
    expect(gates).toContain("plan_artifacts_unreadable");
    expect(res.code).toBe(2);
  });

  it("`decision --help` → Usage + Subcommands, exit 0", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).toContain("prune");
  });

  it("`decision prune --help` → Usage / Options / Examples / --json, exit 0", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage:");
    expect(res.stdout).toContain("Options:");
    expect(res.stdout).toContain("Examples:");
    expect(res.stdout).toContain("--json");
  });

  it("human eligible → dry-run summary on stdout, exit 0", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ELIGIBLE");
    expect(res.stdout).toContain("dry-run");
  });

  it("human ineligible → NOT ELIGIBLE on stderr, exit 2", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md"]);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("NOT ELIGIBLE");
  });
});
