// `decision prune` (dry-run) CLI contract — built-CLI integration.
// PR-C1b: public command, JSON envelopes, exit codes. No --write yet.

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
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

/** Recursively snapshot every file under `root` as { relPath → content }. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) out[relative(root, abs)] = await readFile(abs, "utf8");
    }
  }
  await walk(root);
  return out;
}

describe("decision prune — CLI (dry-run)", () => {
  it("eligible accepted target → exit 0, full success envelope shape (JSON)", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    const env = expectJsonOk<{
      mode: string;
      decision: string;
      eligible: boolean;
      blocks: unknown[];
      referencing_tasks: { task_id: string; phase_id: string; status: string; via: string }[];
      plan: {
        remove_file: string;
        append_ledger: boolean;
        link_rewrite: { status: string; items: unknown[] };
      };
      warnings: unknown[];
    }>(res);
    expect(res.code).toBe(0);
    expect(env.data.mode).toBe("dry-run");
    expect(env.data.decision).toBe("design/decisions/foo-rfc.md");
    expect(env.data.eligible).toBe(true);
    expect(env.data.blocks).toEqual([]);
    expect(env.data.plan).toEqual({
      remove_file: "design/decisions/foo-rfc.md",
      append_ledger: true,
      link_rewrite: { status: "ready", items: [] },
    });
    expect(Array.isArray(env.data.warnings)).toBe(true);
    expect(env.data.referencing_tasks[0]).toMatchObject({
      task_id: "P1-T1",
      phase_id: "P1",
      status: "done",
      via: "decision_refs",
    });
  });

  it("eligible with a real inbound link → non-empty link_rewrite.items[] with the full field shape (JSON)", async () => {
    const p = await project(ACCEPTED, "done");
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(join(p.dir, "docs", "x.md"), "# X\n\nSee [d](../design/decisions/foo-rfc.md).\n");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    const env = expectJsonOk<{
      plan: { link_rewrite: { status: string; items: Record<string, unknown>[] } };
    }>(res);
    expect(env.data.plan.link_rewrite.status).toBe("ready");
    const item = env.data.plan.link_rewrite.items.find((i) => i.source_file === "docs/x.md");
    expect(item).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual(
      [
        "column",
        "line",
        "link_kind",
        "link_text",
        "normalized_target",
        "raw_href",
        "raw_link",
        "rewrite_action",
        "source_file",
      ].sort(),
    );
    expect(item).toMatchObject({
      link_kind: "inline",
      rewrite_action: "delink",
      normalized_target: "design/decisions/foo-rfc.md",
    });
  });

  it("ineligible → data.plan is null and data.blocks[].gate is populated (JSON)", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const res = p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    const env = expectJsonErr(res);
    const data = env.data as { eligible: boolean; plan: unknown; blocks: { gate: string }[] };
    expect(data.eligible).toBe(false);
    expect(data.plan).toBeNull();
    expect(data.blocks.map((b) => b.gate)).toContain("target_not_accepted");
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
    // matches cli-contract: applicable gates, not "every failing gate"
    expect(res.stdout).toContain("every applicable failing gate");
    expect(res.stdout).not.toContain("every failing gate under");
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

  it("is ZERO-WRITE in every mode (eligible / human / --write) — whole-project snapshot", async () => {
    const p = await project(ACCEPTED, "done");
    // Add an inbound link so the plan is non-trivial (items populated) — the
    // dry-run must STILL not touch it.
    await mkdir(join(p.dir, "docs"), { recursive: true });
    await writeFile(
      join(p.dir, "docs", "x.md"),
      "# X\n\nSee [d](../design/decisions/foo-rfc.md).\n",
    );
    const before = await snapshotTree(p.dir);

    for (const args of [
      ["decision", "prune", "design/decisions/foo-rfc.md", "--json"], // eligible
      ["decision", "prune", "design/decisions/foo-rfc.md"], // eligible, human
      ["decision", "prune", "design/decisions/foo-rfc.md", "--write", "--json"], // CONFIG_ERROR
    ]) {
      p.run(args);
    }

    expect(await snapshotTree(p.dir)).toEqual(before); // entire tree byte-identical
  });

  it("ineligible runs are also ZERO-WRITE (whole-project snapshot)", async () => {
    const p = await project("# RFC\n\n**Status:** proposed\n\nx", "done");
    const before = await snapshotTree(p.dir);
    p.run(["decision", "prune", "design/decisions/foo-rfc.md", "--json"]);
    p.run(["decision", "prune", "design/decisions/foo-rfc.md"]);
    expect(await snapshotTree(p.dir)).toEqual(before);
  });

  it("cluster-level errors honor --json (unknown subcommand)", async () => {
    const p = await project(ACCEPTED, "done");
    for (const args of [
      ["decision", "nope", "--json"],
      ["decision", "--json"],
    ]) {
      const res = p.run(args);
      expect(res.code).toBe(2);
      expect(expectJsonErr(res).error.code).toBe("CONFIG_ERROR");
    }
  });

  it("top-level `--help` lists the decision command (discoverability)", async () => {
    const p = await project(ACCEPTED, "done");
    const res = p.run(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("decision");
  });
});
